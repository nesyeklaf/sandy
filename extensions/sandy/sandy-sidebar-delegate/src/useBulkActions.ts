import { useCallback } from "react";
import { useRpc, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { formatSnoozeWakeTime } from "./lifecycle";
import { toast } from "./lib/toast";
import { useMarkIdeas } from "./useIdeas";
import { useMarkOrchestrators } from "./useOrchestrators";

type Target = Pick<PluginSidebarThread, "id">;

function threadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

type BulkChange = { changed: string[]; failed: string[]; undoToken: string };

async function bulkChange(failure: string, run: () => Promise<BulkChange>): Promise<BulkChange | null> {
  try {
    return await run();
  } catch {
    toast.error(failure);
    return null;
  }
}

export function useBulkActions() {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const markIdeas = useMarkIdeas();
  const markOrchestrators = useMarkOrchestrators();

  const undo = useCallback(
    (undoToken: string) => {
      void rpc.call("undoBulkAction", { undoToken }).then(
        ({ failed }) => {
          if (failed.length > 0) toast.error(`Could not undo ${threadCount(failed.length)}`);
        },
        () => toast.error("Could not undo this change"),
      );
    },
    [rpc],
  );

  const snooze = useCallback(
    async (threads: readonly Target[], snoozedUntil: number) => {
      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length === 0) return;
      const result = await bulkChange(`Could not snooze ${threadCount(threadIds.length)}`, () =>
        rpc.call("snoozeThreads", { threadIds, snoozedUntil }),
      );
      if (!result) return;
      if (result.failed.length > 0) toast.error(`Could not snooze ${threadCount(result.failed.length)}`);
      if (result.changed.length === 0) return;
      toast.success(`Snoozed ${threadCount(result.changed.length)}`, {
        description: `Wakes ${formatSnoozeWakeTime(snoozedUntil)}`,
        action: { label: "Undo", onClick: () => undo(result.undoToken) },
      });
    },
    [rpc, undo],
  );

  const pin = useCallback(
    async (threads: readonly Pick<PluginSidebarThread, "id" | "isPinned" | "parentThreadId">[]) => {
      const topLevel = threads.filter((thread) => thread.parentThreadId == null);
      const unpinning = topLevel.length > 0 && topLevel.every((thread) => thread.isPinned);
      const threadIds = topLevel.filter((thread) => thread.isPinned === unpinning).map((thread) => thread.id);
      if (threadIds.length === 0) return;
      const verb = unpinning ? "unpin" : "pin";
      const result = await bulkChange(`Could not ${verb} ${threadCount(threadIds.length)}`, () =>
        rpc.call("pinThreads", { threadIds, pinned: !unpinning }),
      );
      if (!result) return;
      if (result.failed.length > 0) toast.error(`Could not ${verb} ${threadCount(result.failed.length)}`);
      if (result.changed.length === 0) return;
      toast.success(`${unpinning ? "Unpinned" : "Pinned"} ${threadCount(result.changed.length)}`, {
        action: { label: "Undo", onClick: () => undo(result.undoToken) },
      });
    },
    [rpc, undo],
  );

  const tag = useCallback(
    async (threads: readonly Target[], tag: string) => {
      const clean = tag.trim().toLowerCase();
      if (!clean || threads.length === 0) return;
      const threadIds = threads.map((thread) => thread.id);
      let result: { tagged: string[]; atLimit: string[] };
      try {
        result = await rpc.call("tagThreads", { threadIds, tag: clean });
      } catch {
        toast.error(`Could not tag ${threadCount(threadIds.length)}`);
        return;
      }
      const { tagged, atLimit } = result;
      if (atLimit.length > 0) toast.error(`${threadCount(atLimit.length)} already have the most tags allowed`);
      if (tagged.length === 0) return;
      toast.success(`Tagged ${threadCount(tagged.length)} with ${clean}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void rpc.call("untagThreads", { threadIds: tagged, tag: clean }).catch(() => {
              toast.error(`Could not untag ${threadCount(tagged.length)}`);
            });
          },
        },
      });
    },
    [rpc],
  );

  const topic = useCallback(
    async (threads: readonly Target[], topic: string) => {
      const clean = topic.trim();
      if (!clean || threads.length === 0) return;
      const threadIds = threads.map((thread) => thread.id);
      let result: { added: string[]; atLimit: string[] };
      try {
        result = await rpc.call("addThreadTopic", { threadIds, topic: clean });
      } catch {
        toast.error(`Could not add ${threadCount(threadIds.length)} to ${clean}`);
        return;
      }
      const { added, atLimit } = result;
      if (atLimit.length > 0) toast.error(`${threadCount(atLimit.length)} already have the most topics allowed`);
      if (added.length === 0) return;
      toast.success(`Added ${threadCount(added.length)} to ${clean}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void rpc.call("removeThreadTopic", { threadIds: added, topic: clean }).catch(() => {
              toast.error(`Could not remove ${threadCount(added.length)} from ${clean}`);
            });
          },
        },
      });
    },
    [rpc],
  );

  const idea = useCallback(
    async (threads: readonly Target[], idea: boolean) => {
      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length === 0) return;
      let changed: string[];
      try {
        changed = await markIdeas(threadIds, idea);
      } catch {
        toast.error(`Could not change the idea mark of ${threadCount(threadIds.length)}`);
        return;
      }
      if (changed.length === 0) return;
      toast.success(
        idea
          ? `Marked ${threadCount(changed.length)} as idea`
          : `Removed the idea mark from ${threadCount(changed.length)}`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void markIdeas(changed, !idea).catch(() => toast.error("Could not undo this change"));
            },
          },
        },
      );
    },
    [markIdeas],
  );

  const orchestrator = useCallback(
    async (threads: readonly Target[], orchestrator: boolean) => {
      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length === 0) return;
      let changed: string[];
      try {
        changed = await markOrchestrators(threadIds, orchestrator);
      } catch {
        toast.error(`Could not change the orchestrator mark of ${threadCount(threadIds.length)}`);
        return;
      }
      if (changed.length === 0) return;
      toast.success(
        orchestrator
          ? `Marked ${threadCount(changed.length)} as orchestrator`
          : `Removed the orchestrator mark from ${threadCount(changed.length)}`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void markOrchestrators(changed, !orchestrator).catch(() => toast.error("Could not undo this change"));
            },
          },
        },
      );
    },
    [markOrchestrators],
  );

  return { snooze, pin, tag, topic, idea, orchestrator };
}
