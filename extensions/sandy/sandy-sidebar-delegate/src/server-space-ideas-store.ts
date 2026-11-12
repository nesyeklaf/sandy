import { randomUUID } from "node:crypto";
import { assert } from "./assert";
import { SpaceCoordinationError } from "./space-coordination-error";
import { IDEAS_PER_SPACE_MAX, IDEA_LINKS_MAX, type Idea, type IdeaStatus } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";

type Database = ServerContext["db"];

interface IdeaRow {
  id: string;
  space_id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  author_kind: "owner" | "session";
  author_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface IdeaAuthor {
  kind: "owner" | "session";
  threadId: string | null;
}

interface IdeaPatch {
  title?: string;
  body?: string;
  status?: IdeaStatus;
  threadIds?: readonly string[];
}

function toIdea(row: IdeaRow, threadIds: string[]): Idea {
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    body: row.body,
    status: row.status,
    authorKind: row.author_kind,
    authorThreadId: row.author_thread_id,
    threadIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createIdeaReads(db: Database) {
  const selectLinks = db.prepare("SELECT thread_id FROM space_idea_links WHERE idea_id = ? ORDER BY thread_id");
  const selectById = db.prepare("SELECT * FROM space_ideas WHERE id = ?");

  function linksOf(ideaId: string): string[] {
    return (selectLinks.all(ideaId) as Array<{ thread_id: string }>).map((row) => row.thread_id);
  }

  function get(ideaId: string): Idea | null {
    const row = selectById.get(ideaId) as IdeaRow | undefined;
    return row === undefined ? null : toIdea(row, linksOf(ideaId));
  }

  function countOf(spaceId: string): number {
    const row = db.prepare("SELECT COUNT(*) AS total FROM space_ideas WHERE space_id = ?").get(spaceId) as {
      total: number;
    };
    return row.total;
  }

  function list(spaceId: string): Idea[] {
    assert(spaceId.length > 0, "spaceId must not be empty");
    const rows = db
      .prepare("SELECT * FROM space_ideas WHERE space_id = ? ORDER BY created_at, id LIMIT ?")
      .all(spaceId, IDEAS_PER_SPACE_MAX) as IdeaRow[];
    return rows.map((row) => toIdea(row, linksOf(row.id)));
  }

  function spaceIdsWithIdeas(): Array<{ spaceId: string; ideaCount: number }> {
    const rows = db
      .prepare("SELECT space_id, COUNT(*) AS total FROM space_ideas GROUP BY space_id ORDER BY space_id")
      .all() as Array<{ space_id: string; total: number }>;
    return rows.map((row) => ({ spaceId: row.space_id, ideaCount: row.total }));
  }

  return { get, countOf, list, spaceIdsWithIdeas };
}

type IdeaReads = ReturnType<typeof createIdeaReads>;

function replaceLinks(db: Database, ideaId: string, threadIds: readonly string[]): void {
  const unique = [...new Set(threadIds)];
  assert(unique.length <= IDEA_LINKS_MAX, `an idea links at most ${IDEA_LINKS_MAX} sessions`);
  db.prepare("DELETE FROM space_idea_links WHERE idea_id = ?").run(ideaId);
  const insert = db.prepare("INSERT INTO space_idea_links (idea_id, thread_id) VALUES (?, ?)");
  for (const threadId of unique) insert.run(ideaId, threadId);
}

function createIdeaWrites(db: Database, reads: IdeaReads) {
  const { get, countOf } = reads;

  function create(
    input: { spaceId: string; title: string; body: string; threadIds: readonly string[]; author: IdeaAuthor },
    nowMs: number,
  ): Idea {
    assert(input.spaceId.length > 0 && input.title.length > 0, "Space id and title must not be empty");
    if (countOf(input.spaceId) >= IDEAS_PER_SPACE_MAX) {
      throw new SpaceCoordinationError(
        "limit_reached",
        `This Space already holds the maximum of ${IDEAS_PER_SPACE_MAX} ideas.`,
      );
    }
    const id = `idea_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO space_ideas
           (id, space_id, title, body, status, author_kind, author_thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(id, input.spaceId, input.title, input.body, input.author.kind, input.author.threadId, nowMs, nowMs);
      replaceLinks(db, id, input.threadIds);
    })();
    const created = get(id);
    assert(created !== null && created.spaceId === input.spaceId, "created idea must be readable");
    return created;
  }

  function update(ideaId: string, patch: IdeaPatch, nowMs: number): Idea {
    const current = get(ideaId);
    if (current === null) throw new SpaceCoordinationError("not_found", `No idea ${ideaId}.`);
    db.transaction(() => {
      db.prepare("UPDATE space_ideas SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?").run(
        patch.title ?? current.title,
        patch.body ?? current.body,
        patch.status ?? current.status,
        nowMs,
        ideaId,
      );
      if (patch.threadIds !== undefined) replaceLinks(db, ideaId, patch.threadIds);
    })();
    const updated = get(ideaId);
    assert(updated !== null && updated.spaceId === current.spaceId, "updated idea must stay in its Space");
    return updated;
  }

  return { create, update };
}

function createIdeaMaintenance(db: Database, reads: IdeaReads) {
  const { get, countOf } = reads;

  function linkThread(ideaId: string, threadId: string): void {
    const current = get(ideaId);
    if (current === null) throw new SpaceCoordinationError("not_found", `No idea ${ideaId}.`);
    if (current.threadIds.includes(threadId)) return;
    assert(current.threadIds.length < IDEA_LINKS_MAX, `an idea links at most ${IDEA_LINKS_MAX} sessions`);
    db.prepare("INSERT OR IGNORE INTO space_idea_links (idea_id, thread_id) VALUES (?, ?)").run(ideaId, threadId);
  }

  function remove(ideaId: string): boolean {
    const removed = db.transaction(() => {
      db.prepare("DELETE FROM space_idea_links WHERE idea_id = ?").run(ideaId);
      return db.prepare("DELETE FROM space_ideas WHERE id = ?").run(ideaId).changes > 0;
    })();
    assert(get(ideaId) === null, "idea must be gone after removal");
    return removed;
  }

  function moveSpace(fromSpaceId: string, toSpaceId: string): number {
    assert(fromSpaceId !== toSpaceId, "source and target Space must differ");
    const incoming = countOf(fromSpaceId);
    if (countOf(toSpaceId) + incoming > IDEAS_PER_SPACE_MAX) {
      throw new SpaceCoordinationError(
        "limit_reached",
        `The target Space would exceed the maximum of ${IDEAS_PER_SPACE_MAX} ideas.`,
      );
    }
    const moved = db.prepare("UPDATE space_ideas SET space_id = ? WHERE space_id = ?").run(toSpaceId, fromSpaceId);
    assert(countOf(fromSpaceId) === 0, "no idea may stay in the source Space");
    return moved.changes;
  }

  return { linkThread, remove, moveSpace };
}

export function createSpaceIdeasStore(db: Database) {
  const reads = createIdeaReads(db);
  return { ...reads, ...createIdeaWrites(db, reads), ...createIdeaMaintenance(db, reads) };
}

export type SpaceIdeasStore = ReturnType<typeof createSpaceIdeasStore>;
