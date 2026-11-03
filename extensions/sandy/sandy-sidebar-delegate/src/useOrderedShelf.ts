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

/** Keep the root of an attention path reachable when its shelf is folded. */
export function useAttentionParentIds(
  enabled: boolean,
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  shelves: readonly [Shelf, Shelf, Shelf, Shelf, Shelf, Shelf, Shelf],
) {
  const [pinned, needs, failed, working, review, waiting, merged] = shelves;
  return useMemo(() => {
    const ids = new Set<string>();
    if (!enabled) return ids;
    for (const thread of [...pinned, ...needs, ...failed, ...working, ...review, ...waiting, ...merged]) {
      if (collapsedChildThreads(childrenByParentId.get(thread.id) ?? [], childrenByParentId, null, true).length > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [childrenByParentId, enabled, pinned, needs, failed, working, review, waiting, merged]);
}
