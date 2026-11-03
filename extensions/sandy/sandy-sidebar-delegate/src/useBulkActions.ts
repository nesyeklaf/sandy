import { useCallback } from "react";
import { useRpc, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { formatSnoozeWakeTime } from "./lifecycle";
import { toast } from "./lib/toast";

type Target = Pick<PluginSidebarThread, "id">;

function threadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

async function each(threadIds: readonly string[], run: (threadId: string) => Promise<unknown>): Promise<string[]> {
  const results = await Promise.allSettled(threadIds.map(run));
  return threadIds.filter((_, index) => results[index]?.status === "fulfilled");
}

function reportUndo(label: string) {
  return (done: readonly string[], total: number) => {
    if (done.length < total) toast.error(`Could not ${label} ${threadCount(total - done.length)}`);
  };
}

export function useBulkActions() {
  const rpc = useRpc<typeof sandySidebarRpcContract>();

  const snooze = useCallback(
    async (threads: readonly Target[], snoozedUntil: number) => {
      const ids = threads.map((thread) => thread.id);
      const done = await each(ids, (threadId) => rpc.call("snooze", { threadId, snoozedUntil }));
      if (done.length < ids.length) toast.error(`Could not snooze ${threadCount(ids.length - done.length)}`);
      if (done.length === 0) return;
      toast.success(`Snoozed ${threadCount(done.length)}`, {
        description: `Wakes ${formatSnoozeWakeTime(snoozedUntil)}`,
        action: {
          label: "Undo",
          onClick: () => {
            void each(done, (threadId) => rpc.call("unsnooze", { threadId })).then((undone) =>
              reportUndo("wake")(undone, done.length),
            );
          },
        },
      });
    },
    [rpc],
  );

  const pin = useCallback(
    async (threads: readonly Pick<PluginSidebarThread, "id" | "isPinned" | "parentThreadId">[]) => {
      const topLevel = threads.filter((thread) => thread.parentThreadId == null);
      const unpinning = topLevel.length > 0 && topLevel.every((thread) => thread.isPinned);
      const ids = topLevel.filter((thread) => thread.isPinned === unpinning).map((thread) => thread.id);
      if (ids.length === 0) return;
      const done = await each(ids, (threadId) => rpc.call("pin", { threadId }));
      const verb = unpinning ? "unpin" : "pin";
      if (done.length < ids.length) toast.error(`Could not ${verb} ${threadCount(ids.length - done.length)}`);
      if (done.length === 0) return;
      toast.success(`${unpinning ? "Unpinned" : "Pinned"} ${threadCount(done.length)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void each(done, (threadId) => rpc.call("pin", { threadId })).then((undone) =>
              reportUndo(unpinning ? "pin" : "unpin")(undone, done.length),
            );
          },
        },
      });
    },
    [rpc],
  );

  const tag = useCallback(
    async (threads: readonly Target[], tag: string, currentTags: Readonly<Record<string, readonly string[]>>) => {
      const clean = tag.trim().toLowerCase();
      if (!clean) return;
      const previous = new Map(threads.map((thread) => [thread.id, [...(currentTags[thread.id] ?? [])]]));
      const ids = [...previous.entries()].filter(([, tags]) => !tags.includes(clean)).map(([id]) => id);
      if (ids.length === 0) return;
      const done = await each(ids, (ownerId) =>
        rpc.call("setTopicTags", { kind: "thread", ownerId, tags: [...(previous.get(ownerId) ?? []), clean] }),
      );
      if (done.length < ids.length) toast.error(`Could not tag ${threadCount(ids.length - done.length)}`);
      if (done.length === 0) return;
      toast.success(`Tagged ${threadCount(done.length)} with ${clean}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void each(done, (ownerId) =>
              rpc.call("setTopicTags", { kind: "thread", ownerId, tags: previous.get(ownerId) ?? [] }),
            ).then((undone) => reportUndo("untag")(undone, done.length));
          },
        },
      });
    },
    [rpc],
  );

  return { snooze, pin, tag };
}
