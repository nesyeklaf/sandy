import { useMemo } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";
import { useOrchestratorIds } from "./useOrchestrators";
import {
  filterByProjects,
  hideChildrenOfVisibleParents,
  partitionPinned,
  sortByCreatedAtDescending,
  sortSettledThreads,
  visibleInboxThreads,
} from "./inbox";
import { activeRepresentativeThreadId, sortActiveThreads } from "./inbox-layout";
import { isWorkingTree } from "./working-tree";
import { childSubtree, threadAsksForInput, threadsWithAskingDescendants } from "./child-status";
import { threadPullRequestState, type PullRequestsByEnvironment } from "./in-review";
import { inboxShelfOf, threadFailed, threadInboxStatus, type InboxShelfId, type LockableShelf } from "./thread-status";

interface InboxShelfThreadsOptions {
  activeThreadId: string | null;
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  lifecycle: LifecycleApi;
  pullRequests: PullRequestsByEnvironment;
  renamingShelfLocks: ReadonlyMap<string, LockableShelf>;
  scope: readonly string[];
  threads: readonly PluginSidebarThread[];
}

export function useInboxShelfThreads({
  activeThreadId,
  childrenByParentId,
  lifecycle,
  pullRequests,
  renamingShelfLocks,
  scope,
  threads,
}: InboxShelfThreadsOptions) {
  const orchestratorIds = useOrchestratorIds();
  return useMemo(() => {
    const allVisible = visibleInboxThreads(threads);
    const visible = hideChildrenOfVisibleParents(filterByProjects(allVisible, scope));
    const coreArchived = hideChildrenOfVisibleParents(
      filterByProjects(
        threads.filter((thread) => thread.isArchived && !thread.isHidden),
        scope,
      ),
    );
    const askingParentIds = threadsWithAskingDescendants(threads);
    const shelves: Record<InboxShelfId, PluginSidebarThread[]> = {
      pinned: [],
      needs: [],
      failed: [],
      working: [],
      review: [],
      waiting: [],
      orchestrators: [],
      merged: [],
      snoozed: [],
      archived: [],
    };
    for (const thread of visible) {
      const children = childrenByParentId.get(thread.id) ?? [];
      const status = threadInboxStatus({
        lifecycleShelf: lifecycle.shelfFor(thread),
        asks: threadAsksForInput(thread) || askingParentIds.has(thread.id),
        failed: threadFailed(thread) || childSubtree(children, childrenByParentId).some(threadFailed),
        workingTree: isWorkingTree(thread, children, childrenByParentId),
        woke: lifecycle.wokeFor(thread),
        pullRequestState: threadPullRequestState(thread, pullRequests),
        orchestrator: orchestratorIds.has(thread.id),
        lockedShelf: renamingShelfLocks.get(thread.id),
      });
      shelves[inboxShelfOf(status, thread.isPinned)].push(thread);
    }
    const allSplit = partitionPinned(allVisible);
    return {
      activeListThreadId: activeRepresentativeThreadId(threads, activeThreadId, visible),
      pinnedBase: shelves.pinned,
      needsBase: sortByCreatedAtDescending(shelves.needs),
      statusBases: {
        failed: sortActiveThreads(shelves.failed, "activity"),
        orchestrators: sortActiveThreads(shelves.orchestrators, "activity"),
        working: sortActiveThreads(shelves.working, "activity"),
        review: sortActiveThreads(shelves.review, "activity"),
        merged: sortActiveThreads(shelves.merged, "activity"),
      },
      waitingBase: sortByCreatedAtDescending(shelves.waiting),
      allPinnedBase: allSplit.pinned,
      allInboxBase: sortByCreatedAtDescending(allSplit.inbox),
      snoozed: [...shelves.snoozed].sort(
        (left, right) =>
          (lifecycle.wakeAtFor(left) ?? Number.POSITIVE_INFINITY) -
            (lifecycle.wakeAtFor(right) ?? Number.POSITIVE_INFINITY) ||
          (lifecycle.parkedAtFor(right) ?? 0) - (lifecycle.parkedAtFor(left) ?? 0),
      ),
      archived: sortSettledThreads(
        [...shelves.archived, ...coreArchived],
        (thread) => lifecycle.settledAtFor(thread) ?? thread.archivedAt,
      ),
      settled: shelves.archived,
    };
  }, [
    activeThreadId,
    childrenByParentId,
    lifecycle,
    orchestratorIds,
    pullRequests,
    renamingShelfLocks,
    scope,
    threads,
  ]);
}
