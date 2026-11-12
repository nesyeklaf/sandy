import { assert } from "./assert";
import { SCRATCHPAD_BYTES_MAX, type Scratchpad, type ScratchpadWrite } from "./space-coordination-contract";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { ServerContext } from "./server-context";
import type { IdeaAuthor } from "./server-space-ideas-store";

type Database = ServerContext["db"];

interface ScratchpadRow {
  space_id: string;
  body: string;
  revision: number;
  updated_by_kind: "owner" | "session";
  updated_by_thread_id: string | null;
  updated_at: number;
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function emptyScratchpad(spaceId: string): Scratchpad {
  return { spaceId, body: "", revision: 0, updatedByKind: null, updatedByThreadId: null, updatedAt: null };
}

export function createSpaceScratchpadStore(db: Database) {
  function read(spaceId: string): Scratchpad {
    assert(spaceId.length > 0, "spaceId must not be empty");
    const row = db.prepare("SELECT * FROM space_scratchpads WHERE space_id = ?").get(spaceId) as
      | ScratchpadRow
      | undefined;
    if (row === undefined) return emptyScratchpad(spaceId);
    assert(row.revision >= 1, "a stored scratchpad has revision 1 or higher");
    return {
      spaceId: row.space_id,
      body: row.body,
      revision: row.revision,
      updatedByKind: row.updated_by_kind,
      updatedByThreadId: row.updated_by_thread_id,
      updatedAt: row.updated_at,
    };
  }

  function store(spaceId: string, body: string, revision: number, author: IdeaAuthor, nowMs: number): void {
    db.prepare(
      `INSERT OR REPLACE INTO space_scratchpads
         (space_id, body, revision, updated_by_kind, updated_by_thread_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(spaceId, body, revision, author.kind, author.threadId, nowMs);
  }

  return {
    read,

    write(spaceId: string, body: string, baseRevision: number, author: IdeaAuthor, nowMs: number): ScratchpadWrite {
      assert(Number.isInteger(baseRevision) && baseRevision >= 0, "baseRevision must be a non-negative integer");
      if (bytesOf(body) > SCRATCHPAD_BYTES_MAX) {
        throw new SpaceCoordinationError(
          "limit_reached",
          `The scratchpad is limited to ${SCRATCHPAD_BYTES_MAX} bytes.`,
        );
      }
      return db.transaction((): ScratchpadWrite => {
        const current = read(spaceId);
        if (current.revision !== baseRevision) return { status: "conflict", scratchpad: current };
        store(spaceId, body, current.revision + 1, author, nowMs);
        const written = read(spaceId);
        assert(written.revision === baseRevision + 1, "revision must advance by exactly one");
        return { status: "written", scratchpad: written };
      })();
    },

    appendUnderHeading(spaceId: string, heading: string, text: string, author: IdeaAuthor, nowMs: number): void {
      assert(heading.length > 0, "heading must not be empty");
      const current = read(spaceId);
      const separator = current.body.length === 0 ? "" : "\n\n";
      const merged = `${current.body}${separator}## ${heading}\n\n${text}`;
      if (bytesOf(merged) > SCRATCHPAD_BYTES_MAX) {
        throw new SpaceCoordinationError(
          "limit_reached",
          `The merged scratchpad would exceed ${SCRATCHPAD_BYTES_MAX} bytes.`,
        );
      }
      store(spaceId, merged, current.revision + 1, author, nowMs);
      assert(read(spaceId).revision === current.revision + 1, "revision must advance by exactly one");
    },

    remove(spaceId: string): void {
      db.prepare("DELETE FROM space_scratchpads WHERE space_id = ?").run(spaceId);
      assert(read(spaceId).revision === 0, "scratchpad must be gone after removal");
    },

    spaceIdsWithScratchpads(): string[] {
      return (
        db.prepare("SELECT space_id FROM space_scratchpads ORDER BY space_id").all() as Array<{ space_id: string }>
      ).map((row) => row.space_id);
    },
  };
}

export type SpaceScratchpadStore = ReturnType<typeof createSpaceScratchpadStore>;
