import type { ServerContext, ServerHandlers } from "./server-context";
import { ANCHORS_CHANNEL } from "./realtime-channels";
import type { Anchor } from "./anchors-contract";
import { buildExplainPrompt, cleanExplanation } from "./explain-prompt";
import type { HiddenHelper } from "./hidden-helper";

const EXPLAIN_TIMEOUT_MS = 90_000;

export const ANCHORS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS anchors (
     id          TEXT PRIMARY KEY,
     thread_id   TEXT NOT NULL,
     kind        TEXT NOT NULL CHECK (kind IN ('note', 'comment', 'tag', 'link', 'bookmark')),
     message_id  TEXT NOT NULL,
     seq         INTEGER,
     quote       TEXT NOT NULL DEFAULT '',
     offset      INTEGER,
     body        TEXT NOT NULL DEFAULT '',
     tags_json   TEXT NOT NULL DEFAULT '[]',
     target_id   TEXT,
     author      TEXT NOT NULL DEFAULT 'user' CHECK (author IN ('user', 'agent')),
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS anchors_thread ON anchors (thread_id, seq)`,
  `CREATE INDEX IF NOT EXISTS anchors_target ON anchors (target_id)`,
];

interface AnchorRow {
  id: string;
  thread_id: string;
  kind: Anchor["kind"];
  message_id: string;
  seq: number | null;
  quote: string;
  offset: number | null;
  body: string;
  tags_json: string;
  target_id: string | null;
  author: Anchor["author"];
  created_at: number;
  updated_at: number;
}

const DEFAULT_LIMIT = 100;

const parseTags = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
};

const toAnchor = (row: AnchorRow): Anchor => ({
  id: row.id,
  threadId: row.thread_id,
  kind: row.kind,
  messageId: row.message_id,
  seq: row.seq,
  quote: row.quote,
  offset: row.offset,
  body: row.body,
  tags: parseTags(row.tags_json),
  targetId: row.target_id,
  author: row.author,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** LIKE needs the wildcards of the user's text escaped. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export function createServerAnchors(ctx: ServerContext, helper: Pick<HiddenHelper, "run">) {
  const byId = (id: string) => ctx.db.prepare("SELECT * FROM anchors WHERE id = ?").get(id) as AnchorRow | undefined;

  const handlers = {
    async listAnchors({ threadId }) {
      const rows = ctx.db
        .prepare("SELECT * FROM anchors WHERE thread_id = ? ORDER BY seq, offset, created_at")
        .all(threadId) as AnchorRow[];
      return { anchors: rows.map(toAnchor) };
    },
    async saveAnchor(input) {
      const now = Date.now();
      const previous = input.id ? byId(input.id) : undefined;
      const id = input.id ?? `anc_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()))].filter(Boolean);
      if (input.kind === "link" && !input.targetId) throw new Error("A link needs a target");
      ctx.db
        .prepare(
          `INSERT INTO anchors (id, thread_id, kind, message_id, seq, quote, offset, body, tags_json, target_id, author, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind, message_id = excluded.message_id, seq = excluded.seq,
             quote = excluded.quote, offset = excluded.offset, body = excluded.body,
             tags_json = excluded.tags_json, target_id = excluded.target_id, updated_at = excluded.updated_at`,
        )
        .run(
          id,
          input.threadId,
          input.kind,
          input.messageId,
          input.seq ?? null,
          input.quote ?? "",
          input.offset ?? null,
          input.body ?? "",
          JSON.stringify(tags),
          input.targetId ?? null,
          previous?.author ?? input.author ?? "user",
          previous?.created_at ?? now,
          now,
        );
      ctx.sandy.realtime.publish(ANCHORS_CHANNEL, { threadId: input.threadId });
      return toAnchor(byId(id) as AnchorRow);
    },
    async deleteAnchor({ id }) {
      const row = byId(id);
      ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM anchors WHERE id = ?").run(id);
        // A link to a removed anchor has nowhere to point.
        ctx.db.prepare("DELETE FROM anchors WHERE kind = 'link' AND target_id = ?").run(id);
      })();
      if (row) ctx.sandy.realtime.publish(ANCHORS_CHANNEL, { threadId: row.thread_id });
      return { ok: true };
    },
    async explainSelection({ threadId, quote }) {
      const thread = await ctx.sandy.sdk.threads.get({ threadId });
      const output = await helper.run(
        thread,
        "Explain selection",
        buildExplainPrompt(quote, thread.title ?? "untitled"),
        EXPLAIN_TIMEOUT_MS,
      );
      return { text: cleanExplanation(output ?? "") };
    },
    async searchAnchors({ query, kind, threadId, limit }) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (kind) {
        where.push("kind = ?");
        args.push(kind);
      }
      if (threadId) {
        where.push("thread_id = ?");
        args.push(threadId);
      }
      for (const word of (query ?? "").split(/\s+/).filter(Boolean)) {
        where.push("(body LIKE ? ESCAPE '\\' OR quote LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')");
        const pattern = likePattern(word);
        args.push(pattern, pattern, pattern);
      }
      const rows = ctx.db
        .prepare(
          `SELECT * FROM anchors ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...args, limit ?? DEFAULT_LIMIT) as AnchorRow[];
      return { anchors: rows.map(toAnchor) };
    },
  } satisfies Pick<
    ServerHandlers,
    "listAnchors" | "saveAnchor" | "deleteAnchor" | "searchAnchors" | "explainSelection"
  >;

  return { handlers };
}
