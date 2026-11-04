import { lastMessageLine } from "./last-message";
import { LAST_MESSAGE_CHANNEL } from "./realtime-channels";
import type { ServerContext, ServerHandlers } from "./server-context";

export const LAST_MESSAGES_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_last_message (
     thread_id   TEXT PRIMARY KEY,
     text        TEXT NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
];

export function createServerLastMessages(ctx: ServerContext) {
  const read = (threadId: string) =>
    (
      ctx.db.prepare(`SELECT text FROM thread_last_message WHERE thread_id = ?`).get(threadId) as
        | { text: string }
        | undefined
    )?.text ?? null;

  const store = (threadId: string, text: string | null) => {
    if (read(threadId) === text) return;
    if (text === null) ctx.db.prepare(`DELETE FROM thread_last_message WHERE thread_id = ?`).run(threadId);
    else
      ctx.db
        .prepare(
          `INSERT INTO thread_last_message (thread_id, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        )
        .run(threadId, text, Date.now());
    ctx.sandy.realtime.publish(LAST_MESSAGE_CHANNEL, {});
  };

  ctx.sandy.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    store(thread.id, lastMessageLine(lastAssistantText));
  });
  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    store(thread.id, null);
  });

  const handlers = {
    async listLastMessages() {
      const rows = ctx.db.prepare(`SELECT thread_id, text FROM thread_last_message`).all() as Array<{
        thread_id: string;
        text: string;
      }>;
      return { messages: rows.map((row) => ({ threadId: row.thread_id, text: row.text })) };
    },
  } satisfies Pick<ServerHandlers, "listLastMessages">;
  return { handlers };
}
