import type { ServerContext } from "./server-context";

export function threadMarksMigration(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`;
}

export function createThreadMarks(ctx: ServerContext, table: string, channel: string) {
  const load = () =>
    (ctx.db.prepare(`SELECT thread_id FROM ${table} ORDER BY marked_at`).all() as Array<{ thread_id: string }>).map(
      (row) => row.thread_id,
    );
  const marked = new Set(load());

  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    const removed = ctx.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(thread.id);
    marked.delete(thread.id);
    if (removed.changes > 0) ctx.sandy.realtime.publish(channel, {});
  });

  return {
    has: (threadId: string) => marked.has(threadId),
    list: load,
    set(threadIds: readonly string[], mark: boolean): string[] {
      const changed: string[] = [];
      const now = Date.now();
      ctx.db.transaction(() => {
        const statement = mark
          ? ctx.db.prepare(`INSERT OR IGNORE INTO ${table} (thread_id, marked_at) VALUES (?, ?)`)
          : ctx.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`);
        for (const threadId of new Set(threadIds)) {
          const result = mark ? statement.run(threadId, now) : statement.run(threadId);
          if (result.changes > 0) changed.push(threadId);
        }
      })();
      for (const threadId of changed) {
        if (mark) marked.add(threadId);
        else marked.delete(threadId);
      }
      if (changed.length > 0) ctx.sandy.realtime.publish(channel, {});
      return changed;
    },
  };
}

export type ThreadMarks = ReturnType<typeof createThreadMarks>;
