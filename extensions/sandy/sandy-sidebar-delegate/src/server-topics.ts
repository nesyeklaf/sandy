import type { ServerContext, ServerHandlers } from "./server-context";
import { TOPICS_CHANNEL } from "./realtime-channels";
import type { HiddenHelper } from "./hidden-helper";
import { messageFromEvent } from "./topic-messages";
import { buildSuggestPrompt, parseSuggestions } from "./topic-suggest";
import { groupTurns } from "./topic-turns";
import type { TopicMessage, TopicSegment } from "./topics-contract";

export const TOPICS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS topic_segments (
     id          TEXT PRIMARY KEY,
     thread_id   TEXT NOT NULL,
     from_seq    INTEGER NOT NULL,
     to_seq      INTEGER NOT NULL,
     title       TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS topic_segments_thread ON topic_segments (thread_id, from_seq)`,
  `CREATE TABLE IF NOT EXISTS topic_tags (
     owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('thread', 'segment')),
     owner_id    TEXT NOT NULL,
     tag         TEXT NOT NULL,
     PRIMARY KEY (owner_kind, owner_id, tag)
   )`,
];

interface SegmentRow {
  id: string;
  thread_id: string;
  from_seq: number;
  to_seq: number;
  title: string;
}

const PAGE = "100";

const SUGGEST_TIMEOUT_MS = 120_000;

export function createServerTopics(ctx: ServerContext, helper: Pick<HiddenHelper, "run">) {
  // Messages only grow, so each call reads just the events after the last seq.
  const cache = new Map<string, { lastSeq: number; messages: TopicMessage[] }>();

  const tagsOf = (kind: "thread" | "segment", ownerId: string): string[] =>
    (
      ctx.db
        .prepare("SELECT tag FROM topic_tags WHERE owner_kind = ? AND owner_id = ? ORDER BY tag")
        .all(kind, ownerId) as Array<{ tag: string }>
    ).map((row) => row.tag);

  const toSegment = (row: SegmentRow): TopicSegment => ({
    id: row.id,
    threadId: row.thread_id,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    title: row.title,
    tags: tagsOf("segment", row.id),
  });

  const loadMessages = async (threadId: string): Promise<TopicMessage[]> => {
    const entry = cache.get(threadId) ?? { lastSeq: 0, messages: [] };
    for (;;) {
      const rows = await ctx.sandy.sdk.threads.events.list({
        threadId,
        afterSeq: String(entry.lastSeq),
        limit: PAGE,
        order: "asc",
        types: ["client/turn/requested", "item/completed"],
      });
      for (const row of rows) {
        const found = messageFromEvent(row);
        if (found) entry.messages.push(found);
        entry.lastSeq = Math.max(entry.lastSeq, row.seq);
      }
      if (rows.length < Number(PAGE)) break;
    }
    cache.set(threadId, entry);
    return entry.messages;
  };

  const handlers = {
    async getThreadMessages({ threadId }) {
      return { messages: await loadMessages(threadId) };
    },
    async listTopics({ threadId }) {
      const rows = ctx.db
        .prepare("SELECT * FROM topic_segments WHERE thread_id = ? ORDER BY from_seq, to_seq")
        .all(threadId) as SegmentRow[];
      return { segments: rows.map(toSegment), threadTags: tagsOf("thread", threadId) };
    },
    async saveTopic({ threadId, id, fromSeq, toSeq, title }) {
      const from = Math.min(fromSeq, toSeq);
      const to = Math.max(fromSeq, toSeq);
      const now = Date.now();
      const segmentId = id ?? `seg_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      ctx.db
        .prepare(
          `INSERT INTO topic_segments (id, thread_id, from_seq, to_seq, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             from_seq = excluded.from_seq, to_seq = excluded.to_seq,
             title = excluded.title, updated_at = excluded.updated_at`,
        )
        .run(segmentId, threadId, from, to, title, now, now);
      ctx.sandy.realtime.publish(TOPICS_CHANNEL, { threadId });
      return toSegment({ id: segmentId, thread_id: threadId, from_seq: from, to_seq: to, title });
    },
    async deleteTopic({ id }) {
      const row = ctx.db.prepare("SELECT thread_id FROM topic_segments WHERE id = ?").get(id) as
        | { thread_id: string }
        | undefined;
      ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM topic_segments WHERE id = ?").run(id);
        ctx.db.prepare("DELETE FROM topic_tags WHERE owner_kind = 'segment' AND owner_id = ?").run(id);
      })();
      if (row) ctx.sandy.realtime.publish(TOPICS_CHANNEL, { threadId: row.thread_id });
      return { ok: true };
    },
    async setTopicTags({ kind, ownerId, tags }) {
      const clean = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))].filter(Boolean);
      ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM topic_tags WHERE owner_kind = ? AND owner_id = ?").run(kind, ownerId);
        const insert = ctx.db.prepare("INSERT INTO topic_tags (owner_kind, owner_id, tag) VALUES (?, ?, ?)");
        for (const tag of clean) insert.run(kind, ownerId, tag);
      })();
      ctx.sandy.realtime.publish(TOPICS_CHANNEL, {});
      return { tags: tagsOf(kind, ownerId).sort() };
    },
    async suggestTopics({ threadId }) {
      const turns = groupTurns(await loadMessages(threadId));
      if (turns.length === 0) throw new Error("This session has no messages to analyse yet");
      const thread = await ctx.sandy.sdk.threads.get({ threadId });
      const output = await helper.run(thread, "Suggest session topics", buildSuggestPrompt(turns), SUGGEST_TIMEOUT_MS);
      return { suggestions: parseSuggestions(output, turns) };
    },
    async listAllTags() {
      const threadTags: Record<string, string[]> = {};
      for (const row of ctx.db
        .prepare("SELECT owner_id, tag FROM topic_tags WHERE owner_kind = 'thread' ORDER BY tag")
        .all() as Array<{ owner_id: string; tag: string }>) {
        (threadTags[row.owner_id] ??= []).push(row.tag);
      }
      const rows = ctx.db.prepare("SELECT * FROM topic_segments ORDER BY thread_id, from_seq").all() as SegmentRow[];
      return { threadTags, segments: rows.map(toSegment) };
    },
  } satisfies Pick<
    ServerHandlers,
    "getThreadMessages" | "listTopics" | "saveTopic" | "deleteTopic" | "setTopicTags" | "suggestTopics" | "listAllTags"
  >;

  return { handlers };
}
