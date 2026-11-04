import { IDEAS_CHANNEL } from "./realtime-channels";
import type { ServerContext, ServerHandlers } from "./server-context";

export const IDEAS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_ideas (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`,
];

export function createServerIdeas(ctx: ServerContext) {
  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    const removed = ctx.db.prepare(`DELETE FROM thread_ideas WHERE thread_id = ?`).run(thread.id);
    if (removed.changes > 0) ctx.sandy.realtime.publish(IDEAS_CHANNEL, {});
  });

  const handlers = {
    async listIdeas() {
      const rows = ctx.db.prepare(`SELECT thread_id FROM thread_ideas ORDER BY marked_at`).all() as Array<{
        thread_id: string;
      }>;
      return { threadIds: rows.map((row) => row.thread_id) };
    },
    async setIdea({ threadIds, idea }) {
      const changed: string[] = [];
      const now = Date.now();
      ctx.db.transaction(() => {
        const statement = idea
          ? ctx.db.prepare(`INSERT OR IGNORE INTO thread_ideas (thread_id, marked_at) VALUES (?, ?)`)
          : ctx.db.prepare(`DELETE FROM thread_ideas WHERE thread_id = ?`);
        for (const threadId of new Set(threadIds)) {
          const result = idea ? statement.run(threadId, now) : statement.run(threadId);
          if (result.changes > 0) changed.push(threadId);
        }
      })();
      if (changed.length > 0) ctx.sandy.realtime.publish(IDEAS_CHANNEL, {});
      return { changed };
    },
  } satisfies Pick<ServerHandlers, "listIdeas" | "setIdea">;
  return { handlers };
}
