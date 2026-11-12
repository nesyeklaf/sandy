import { assert } from "./assert";
import type { ServerContext } from "./server-context";

const ACTIVITY_ENTRIES_MAX = 5000;

interface ActivityThread {
  id: string;
  updatedAt: number;
  latestAttentionAt: number;
}

function rememberBounded(map: Map<string, number>, threadId: string, atMs: number): void {
  map.delete(threadId);
  map.set(threadId, atMs);
  if (map.size > ACTIVITY_ENTRIES_MAX) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
  assert(map.size <= ACTIVITY_ENTRIES_MAX, "activity map stays within its bound");
}

export function createActivityTracker(ctx: ServerContext) {
  const lastEventAt = new Map<string, number>();
  const turnStartedAt = new Map<string, number>();

  const seen = ({ thread }: { thread: { id: string } }) => rememberBounded(lastEventAt, thread.id, Date.now());
  ctx.sandy.events.on("thread.created", seen);
  ctx.sandy.events.on("thread.idle", seen);
  ctx.sandy.events.on("thread.failed", seen);
  ctx.sandy.events.on("interaction.pending", seen);
  ctx.sandy.events.on("thread.active", ({ thread }) => {
    const nowMs = Date.now();
    rememberBounded(lastEventAt, thread.id, nowMs);
    rememberBounded(turnStartedAt, thread.id, nowMs);
  });
  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    lastEventAt.delete(thread.id);
    turnStartedAt.delete(thread.id);
  });

  return {
    lastActivityAt(thread: ActivityThread): number {
      return Math.max(thread.updatedAt, thread.latestAttentionAt, lastEventAt.get(thread.id) ?? 0);
    },
    turnStartedAt(threadId: string): number | null {
      return turnStartedAt.get(threadId) ?? null;
    },
  };
}

export type ActivityTracker = ReturnType<typeof createActivityTracker>;
