import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { threadAsksForInput } from "./child-status";
import { threadFailed } from "./thread-status";

export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 50;
const BUSY_STATUSES: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

type ActivityKind = "asked" | "failed" | "finished" | "archived";

interface ActivityItem {
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

function otherItemOf(thread: PluginSidebarThread, since: number): ActivityItem | null {
  if (thread.isHidden) return null;
  if (thread.isArchived) {
    return thread.archivedAt !== null && thread.archivedAt >= since
      ? { kind: "archived", thread, at: thread.archivedAt }
      : null;
  }
  const at = thread.latestAttentionAt;
  if (at < since || threadAsksForInput(thread)) return null;
  if (threadFailed(thread)) return { kind: "failed", thread, at };
  if (thread.isUnread && !BUSY_STATUSES.has(thread.status)) return { kind: "finished", thread, at };
  return null;
}

function latestQuestionAt(
  threads: readonly PluginSidebarThread[],
  needs: readonly PluginSidebarThread[],
): Map<string, number> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rowIds = new Set(needs.map((thread) => thread.id));
  const latest = new Map<string, number>();
  for (const thread of threads) {
    if (thread.isArchived || !threadAsksForInput(thread)) continue;
    const visited = new Set<string>();
    let current: PluginSidebarThread | undefined = thread;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (rowIds.has(current.id)) {
        latest.set(current.id, Math.max(latest.get(current.id) ?? 0, thread.latestAttentionAt));
      }
      current = current.parentThreadId === null ? undefined : byId.get(current.parentThreadId);
    }
  }
  return latest;
}

export function activityFeed(
  threads: readonly PluginSidebarThread[],
  needs: readonly PluginSidebarThread[],
  now: number,
): ActivityItem[] {
  const since = now - ACTIVITY_WINDOW_MS;
  const askedAt = latestQuestionAt(threads, needs);
  const needIds = new Set(needs.map((thread) => thread.id));
  const asked = needs.flatMap((thread): ActivityItem[] => {
    const at = askedAt.get(thread.id) ?? thread.latestAttentionAt;
    return at >= since ? [{ kind: "asked", thread, at }] : [];
  });
  const others = threads.flatMap((thread) => {
    if (needIds.has(thread.id)) return [];
    const item = otherItemOf(thread, since);
    return item ? [item] : [];
  });
  return [...asked, ...others].sort((left, right) => right.at - left.at).slice(0, ACTIVITY_LIMIT);
}
