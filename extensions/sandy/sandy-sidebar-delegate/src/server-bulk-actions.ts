import { randomUUID } from "node:crypto";
import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle, StoredLifecycleRow } from "./server-lifecycle";
import type { createServerSettleCleanup } from "./server-settle-cleanup";
import { pinnedNeighbors, rebaseMovedId, sortPinnedThreads } from "./pinned-order";

const UNDO_TTL_MS = 5 * 60_000;
const MAX_UNDOS = 50;

interface ThreadState {
  pinned: boolean;
  row: StoredLifecycleRow | null;
}

interface BulkUndo {
  expiresAt: number;
  pinOrder: string[];
  threads: Array<{ threadId: string; before: ThreadState; after: ThreadState }>;
}

export function createServerBulkActions(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  cleanup: ReturnType<typeof createServerSettleCleanup>,
) {
  const { readOne, write, withPinParentChange, loadPolicyThreads, sameLifecycle, publishLifecycleChanges } = lifecycle;
  const { reclaimThreadResources } = cleanup;
  const undos = new Map<string, BulkUndo>();
  ctx.sandy.onDispose(() => undos.clear());

  const pinThread = (threadId: string) =>
    withPinParentChange(threadId, async () => {
      const thread = await ctx.sandy.sdk.threads.get({ threadId });
      if (thread.parentThreadId != null) throw new Error("Child threads cannot be pinned");
      await ctx.sandy.sdk.threads.pin({ threadId });
      write({ threadId, parkedAt: null, settledAt: null, settledOverride: "active", snoozedUntil: null, snoozedAt: null });
    });

  const snoozeThread = async (threadId: string, snoozedUntil: number) => {
    await ctx.sandy.sdk.threads.unpin({ threadId });
    write({ threadId, settledAt: null, settledOverride: null, snoozedUntil, snoozedAt: Date.now() });
    return reclaimThreadResources(threadId);
  };

  const pinnedRoots = async () => {
    const threads = await loadPolicyThreads();
    const roots = sortPinnedThreads(threads.filter((thread) => thread.pinnedAt !== null && thread.parentThreadId === null));
    return roots.map((thread) => thread.id);
  };

  const remember = (pinOrder: string[], threads: BulkUndo["threads"]) => {
    const now = Date.now();
    for (const [token, undo] of undos) if (undo.expiresAt <= now) undos.delete(token);
    while (undos.size >= MAX_UNDOS) undos.delete(undos.keys().next().value!);
    const undoToken = randomUUID();
    undos.set(undoToken, { expiresAt: now + UNDO_TTL_MS, pinOrder, threads });
    return undoToken;
  };

  const runEach = async (threadIds: readonly string[], change: (threadId: string, before: ThreadState) => Promise<boolean>) => {
    const pinOrder = await pinnedRoots();
    const pinned = new Set(pinOrder);
    const changed: BulkUndo["threads"] = [];
    const failed: string[] = [];
    for (const threadId of new Set(threadIds)) {
      const before = { pinned: pinned.has(threadId), row: readOne(threadId) };
      try {
        if (!(await change(threadId, before))) continue;
        const after = { pinned: (await ctx.sandy.sdk.threads.get({ threadId })).pinnedAt !== null, row: readOne(threadId) };
        changed.push({ threadId, before, after });
      } catch {
        failed.push(threadId);
      }
    }
    return { changed: changed.map((entry) => entry.threadId), failed, undoToken: remember(pinOrder, changed) };
  };

  const restorePinOrder = async (undo: BulkUndo, restoredIds: ReadonlySet<string>) => {
    let current = await pinnedRoots();
    for (const threadId of undo.pinOrder) {
      if (!restoredIds.has(threadId) || !current.includes(threadId)) continue;
      const target = pinnedNeighbors(rebaseMovedId(current, undo.pinOrder, threadId), threadId);
      const present = pinnedNeighbors(current, threadId);
      if (target.previousThreadId === present.previousThreadId && target.nextThreadId === present.nextThreadId) continue;
      const reordered = await ctx.sandy.sdk.threads.reorderPinned({ threadId, ...target });
      current = reordered.filter((thread) => thread.pinnedAt !== null).map((thread) => thread.id);
    }
  };

  const handlers = {
    async pinThreads({ threadIds, pinned }) {
      return runEach(threadIds, async (threadId, before) => {
        if (before.pinned === pinned) return false;
        if (pinned) await pinThread(threadId);
        else await ctx.sandy.sdk.threads.unpin({ threadId });
        return true;
      });
    },
    async snoozeThreads({ threadIds, snoozedUntil }) {
      return runEach(threadIds, async (threadId) => {
        await snoozeThread(threadId, snoozedUntil);
        return true;
      });
    },
    async undoBulkAction({ undoToken }) {
      const undo = undos.get(undoToken);
      if (!undo || undo.expiresAt <= Date.now()) throw new Error("This change can no longer be undone");
      undos.delete(undoToken);
      const restored: string[] = [];
      const failed: string[] = [];
      for (const { threadId, before, after } of undo.threads) {
        try {
          const pinnedNow = (await ctx.sandy.sdk.threads.get({ threadId })).pinnedAt !== null;
          if (pinnedNow !== after.pinned || !sameLifecycle(readOne(threadId), after.row)) continue;
          if (before.pinned && !pinnedNow) await ctx.sandy.sdk.threads.pin({ threadId });
          if (!before.pinned && pinnedNow) await ctx.sandy.sdk.threads.unpin({ threadId });
          if (before.row) write(before.row, false);
          else ctx.db.prepare("DELETE FROM thread_lifecycle WHERE thread_id = ?").run(threadId);
          restored.push(threadId);
        } catch {
          failed.push(threadId);
        }
      }
      publishLifecycleChanges(restored);
      try {
        await restorePinOrder(undo, new Set(restored));
      } catch (error) {
        ctx.sandy.log.warn(`Could not restore pin order: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { restored, failed };
    },
  } satisfies Pick<ServerHandlers, "pinThreads" | "snoozeThreads" | "undoBulkAction">;

  return { handlers, pinThread, snoozeThread };
}
