import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { childStatusKind, childSubtree, threadAsksForInput } from "./child-status";
import { isThreadWorking } from "./lifecycle";
import { threadShortStatus } from "./StatusSlot";

/**
 * Whether a thread, or anything under it, still has work running: its own
 * turn, its background agents, commands, workflows, and goals, and any
 * working descendant. The badge can prioritize unread success over a live
 * turn, so inspect activity as well as its displayed status.
 *
 * The thread itself needing you, or failing, outranks its children's work:
 * that is the user's cue, so such a thread never counts as working here.
 * A descendant waiting on the user outranks the rest of the tree's work too:
 * its question shows only inside this tree, so the tree must stay in view.
 *
 * Decides both the compact row and the Working shelf.
 */
export function isWorkingTree(
  thread: PluginSidebarThread,
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
): boolean {
  if (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    thread.queuedWork === "failed"
  ) {
    return false;
  }
  const descendants = childSubtree(childThreads, childrenByParent);
  if (descendants.some(threadAsksForInput)) return false;
  if (threadShortStatus(thread)?.showsDuration === true || isThreadWorking(thread)) return true;
  return descendants.some(
    (child) =>
      childStatusKind(child) === "working" ||
      (child.indicator !== "unread-error" && child.queuedWork !== "failed" && isThreadWorking(child)),
  );
}
