import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";

/** A settle this close before the sidebar loaded still counts as new. */
const RECENT_SETTLE_MS = 60_000;

/**
 * Settling a parent folds its children, whether the user or an automatic rule
 * settled it. Children expanded again inside Settled stay expanded, including
 * across reloads: only a settle the sidebar sees happen collapses them.
 */
export function useCollapseChildrenOnSettle(
  settled: readonly PluginSidebarThread[],
  lifecycle: Pick<LifecycleApi, "settledAtFor">,
  setExpandedChildParentIds: Dispatch<SetStateAction<Set<string>>>,
) {
  const startedAt = useRef(Date.now());
  const seen = useRef(new Map<string, number | null>());

  useEffect(() => {
    const collapse: string[] = [];
    for (const thread of settled) {
      const settledAt = lifecycle.settledAtFor(thread);
      const before = seen.current.get(thread.id);
      seen.current.set(thread.id, settledAt);
      if (settledAt === null || before === settledAt) continue;
      // First sight of a settled thread: only a settle from this session.
      if (before === undefined && settledAt < startedAt.current - RECENT_SETTLE_MS) continue;
      collapse.push(thread.id);
    }
    if (collapse.length === 0) return;
    setExpandedChildParentIds((current) => {
      if (!collapse.some((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of collapse) next.delete(id);
      return next;
    });
  }, [settled, lifecycle, setExpandedChildParentIds]);
}
