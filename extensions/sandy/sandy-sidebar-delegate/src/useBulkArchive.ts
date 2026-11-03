import { useCallback } from "react";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "./lib/toast";

function threadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

export function useBulkArchive() {
  const sdk = useSdk();
  return useCallback(
    async (threads: readonly Pick<PluginSidebarThread, "id">[]) => {
      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length === 0) return;
      const results = await Promise.allSettled(threadIds.map((threadId) => sdk.threads.archive({ threadId })));
      const archived = threadIds.filter((_, index) => results[index]?.status === "fulfilled");
      if (archived.length < threadIds.length) {
        toast.error(`Could not archive ${threadCount(threadIds.length - archived.length)}`);
      }
      if (archived.length === 0) return;
      toast.success(`Archived ${threadCount(archived.length)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void Promise.allSettled(archived.map((threadId) => sdk.threads.unarchive({ threadId }))).then((undone) => {
              const failed = undone.filter((result) => result.status === "rejected").length;
              if (failed > 0) toast.error(`Could not restore ${threadCount(failed)}`);
            });
          },
        },
      });
    },
    [sdk],
  );
}
