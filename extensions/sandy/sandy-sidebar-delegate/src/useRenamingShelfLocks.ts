import { useEffect, useState } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";

export function threadNeedsAttention(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    thread.queuedWork === "failed"
  );
}

export function useRenamingShelfLocks(threads: readonly PluginSidebarThread[], lifecycle: LifecycleApi) {
  const [renamingShelfLocks, setRenamingShelfLocks] = useState<
    Map<string, "active" | "working" | "review" | "inactive">
  >(() => new Map());
  useEffect(() => {
    const activeIds = new Set(
      threads
        .filter(
          (thread) => !thread.isArchived && lifecycle.shelfFor(thread) === "active" && !threadNeedsAttention(thread),
        )
        .map((thread) => thread.id),
    );
    setRenamingShelfLocks((current) => {
      const next = new Map([...current].filter(([threadId]) => activeIds.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [lifecycle, threads]);
  return [renamingShelfLocks, setRenamingShelfLocks] as const;
}
