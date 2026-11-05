import { useMemo } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { collapsedChildThreads } from "./ChildThreadList";
import { visibleShelfThreads } from "./inbox-layout";
import { orderPinnedThreads } from "./pinned-order";

/**
 * A shelf that keeps Active's manual order, so a thread that leaves for it
 * comes back to the slot it left, plus the rows visible while it is folded.
 */
export function useOrderedShelf(
  base: readonly PluginSidebarThread[],
  order: readonly string[] | null,
  expanded: boolean,
  activeThreadId: string | null,
  attentionParentIds?: ReadonlySet<string>,
) {
  const threads = useMemo(() => orderPinnedThreads(base, order), [base, order]);
  const visibleThreads = useMemo(
    () => visibleShelfThreads(threads, expanded, activeThreadId, undefined, attentionParentIds),
    [activeThreadId, attentionParentIds, expanded, threads],
  );
  return { threads, visibleThreads };
}

type Shelf = readonly PluginSidebarThread[];

type StatusShelf = "failed" | "orchestrators" | "working" | "review" | "ideas" | "merged";

export function useStatusShelves(
  bases: Readonly<Record<StatusShelf, Shelf>>,
  expanded: Readonly<Record<StatusShelf, boolean>>,
  activeThreadId: string | null,
  attentionParentIds: ReadonlySet<string>,
) {
  return {
    failed: useOrderedShelf(bases.failed, null, expanded.failed, activeThreadId, attentionParentIds),
    orchestrators: useOrderedShelf(
      bases.orchestrators,
      null,
      expanded.orchestrators,
      activeThreadId,
      attentionParentIds,
    ),
    working: useOrderedShelf(bases.working, null, expanded.working, activeThreadId, attentionParentIds),
    review: useOrderedShelf(bases.review, null, expanded.review, activeThreadId, attentionParentIds),
    ideas: useOrderedShelf(bases.ideas, null, expanded.ideas, activeThreadId, attentionParentIds),
    merged: useOrderedShelf(bases.merged, null, expanded.merged, activeThreadId, attentionParentIds),
  };
}

/** Keep the root of an attention path reachable when its shelf is folded. */
export function useAttentionParentIds(
  enabled: boolean,
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  shelves: readonly Shelf[],
) {
  return useMemo(() => {
    const ids = new Set<string>();
    if (!enabled) return ids;
    for (const thread of shelves.flat()) {
      if (collapsedChildThreads(childrenByParentId.get(thread.id) ?? [], childrenByParentId, null, true).length > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [childrenByParentId, enabled, ...shelves]);
}
