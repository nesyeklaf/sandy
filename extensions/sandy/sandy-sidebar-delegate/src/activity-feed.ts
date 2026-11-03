import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { threadFailed } from "./thread-status";

export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 50;
const BUSY_STATUSES: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

export type ActivityKind = "asked" | "failed" | "finished" | "archived";

export interface ActivityItem {
  kind: ActivityKind;
  thread: PluginSidebarThread;
  at: number;
}

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  asked: "asked a question",
  failed: "failed",
  finished: "finished",
  archived: "archived",
};

function itemOf(thread: PluginSidebarThread, since: number): ActivityItem | null {
  if (thread.isHidden) return null;
  if (thread.isArchived) {
    return thread.archivedAt !== null && thread.archivedAt >= since
      ? { kind: "archived", thread, at: thread.archivedAt }
      : null;
  }
  const at = thread.latestAttentionAt;
  if (at < since) return null;
  if (thread.hasPendingInteraction) return { kind: "asked", thread, at };
  if (threadFailed(thread)) return { kind: "failed", thread, at };
  if (thread.isUnread && !BUSY_STATUSES.has(thread.status)) return { kind: "finished", thread, at };
  return null;
}

export function activityFeed(threads: readonly PluginSidebarThread[], now: number): ActivityItem[] {
  const since = now - ACTIVITY_WINDOW_MS;
  return threads
    .flatMap((thread) => {
      const item = itemOf(thread, since);
      return item ? [item] : [];
    })
    .sort((left, right) => right.at - left.at)
    .slice(0, ACTIVITY_LIMIT);
}

export function waitingQuestionCount(threads: readonly PluginSidebarThread[]): number {
  return threads.filter((thread) => !thread.isArchived && !thread.isHidden && thread.hasPendingInteraction).length;
}
