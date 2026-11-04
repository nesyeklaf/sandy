import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { ThreadShelf } from "./lifecycle";
import type { PullRequestState } from "./github-pr-status";

export const INBOX_SHELVES = [
  "pinned",
  "needs",
  "failed",
  "working",
  "review",
  "waiting",
  "ideas",
  "merged",
  "snoozed",
  "archived",
] as const;
export type InboxShelfId = (typeof INBOX_SHELVES)[number];
export type ThreadInboxStatus = Exclude<InboxShelfId, "pinned">;
export type LockableShelf = Extract<
  ThreadInboxStatus,
  "needs" | "failed" | "working" | "review" | "waiting" | "ideas" | "merged"
>;

export interface ThreadStatusSignals {
  lifecycleShelf: ThreadShelf;
  asks: boolean;
  failed: boolean;
  workingTree: boolean;
  woke: boolean;
  pullRequestState: PullRequestState | null;
  idea: boolean;
  lockedShelf?: LockableShelf;
}

export function threadFailed(thread: Pick<PluginSidebarThread, "status" | "indicator" | "queuedWork">): boolean {
  return thread.status === "error" || thread.indicator === "unread-error" || thread.queuedWork === "failed";
}

export function threadInboxStatus(signals: ThreadStatusSignals): ThreadInboxStatus {
  const { lifecycleShelf, asks, failed, workingTree, woke, pullRequestState, idea, lockedShelf } = signals;
  if (lifecycleShelf === "snoozed" || lifecycleShelf === "parked") return "snoozed";
  if (lifecycleShelf === "settled") return "archived";
  if (lockedShelf) return lockedShelf;
  if (asks) return "needs";
  if (failed) return "failed";
  if (workingTree && !woke) return "working";
  if (!woke && pullRequestState === "open") return "review";
  if (!woke && pullRequestState === "merged") return "merged";
  return idea ? "ideas" : "waiting";
}

export function inboxShelfOf(status: ThreadInboxStatus, isPinned: boolean): InboxShelfId {
  if (!isPinned) return status;
  return status === "needs" || status === "failed" || status === "snoozed" || status === "archived" ? status : "pinned";
}
