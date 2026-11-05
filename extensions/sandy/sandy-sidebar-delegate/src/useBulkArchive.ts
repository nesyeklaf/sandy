import { useCallback } from "react";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "./lib/toast";

type Sdk = ReturnType<typeof useSdk>;

function threadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

async function unarchiveTree(sdk: Sdk, threadIds: readonly string[]): Promise<string[]> {
  let pending = [...threadIds];
  while (pending.length > 0) {
    const failed: string[] = [];
    for (const threadId of pending) {
      try {
        await sdk.threads.unarchive({ threadId });
      } catch {
        failed.push(threadId);
      }
    }
    if (failed.length === pending.length) return failed;
    pending = failed;
  }
  return [];
}

export function useBulkArchive() {
  const sdk = useSdk();
  return useCallback(
    async (threads: readonly Pick<PluginSidebarThread, "id">[]) => {
      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length === 0) return;
      const results = await Promise.allSettled(threadIds.map((threadId) => sdk.threads.archive({ threadId })));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) toast.error(`Could not archive ${threadCount(failed)}`);
      const archived = [
        ...new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value.archivedThreadIds : []))),
      ];
      const archivedRoots = threadIds.filter((_, index) => results[index]?.status === "fulfilled");
      if (archivedRoots.length === 0) return;
      toast.success(`Archived ${threadCount(archivedRoots.length)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void unarchiveTree(sdk, archived).then((notRestored) => {
              if (notRestored.length > 0) toast.error(`Could not restore ${threadCount(notRestored.length)}`);
            });
          },
        },
      });
    },
    [sdk],
  );
}
