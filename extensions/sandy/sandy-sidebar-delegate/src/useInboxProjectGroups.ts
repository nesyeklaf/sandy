import { useCallback, useMemo } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { InboxDragOrder } from "./drag-reorder-geometry";
import { allOrderUnits, layoutActiveGroups, projectGroupView, siblingScope, unitsAtScope } from "./environment-groups";
import { projectOrderUnits, visibleShelfThreads } from "./inbox-layout";
import type { ProjectViewUnit, ReorderScope } from "./inbox-layout";
import { orderSubsetInPlace, rebaseMovedUnit } from "./pinned-order";
import { environmentGroupingCodec, projectCollapseCodec } from "./lib/inbox-preference-codecs";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";

function toggleId(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function useInboxProjectGroups({
  orderedInbox,
  dragOrder,
  expanded,
  activeThreadId,
  attentionIds,
  projectNameById,
}: {
  orderedInbox: PluginSidebarThread[];
  dragOrder: InboxDragOrder | null;
  expanded: boolean;
  activeThreadId: string | null;
  attentionIds: ReadonlySet<string>;
  projectNameById: ReadonlyMap<string, string>;
}) {
  const [groupEnvironments, setGroupEnvironments] = usePersistedPreference(
    STORAGE_KEYS.environmentGrouping.key,
    environmentGroupingCodec,
  );
  const collapseCodec = useMemo(
    () => ({
      ...projectCollapseCodec,
      prune: (ids: Set<string>) =>
        new Set([...ids].filter((id) => projectNameById.size === 0 || projectNameById.has(id))),
    }),
    [projectNameById],
  );
  const [collapsedProjects, setCollapsedProjects] = usePersistedPreference(
    STORAGE_KEYS.projectCollapse.key,
    collapseCodec,
  );
  const [collapsedEnvironments, setCollapsedEnvironments] = usePersistedPreference(
    STORAGE_KEYS.environmentCollapse.key,
    projectCollapseCodec,
  );
  const toggleProjectCollapse = useCallback((id: string) => setCollapsedProjects((ids) => toggleId(ids, id)), []);
  const toggleEnvironmentCollapse = useCallback(
    (id: string) => setCollapsedEnvironments((ids) => toggleId(ids, id)),
    [],
  );
  const storedUnits = useMemo(
    () => layoutActiveGroups(orderedInbox, groupEnvironments),
    [orderedInbox, groupEnvironments],
  );
  // Rows move across environments when their environment headers are hidden.
  // Keep the full thread lists so rebasing preserves hidden siblings' slots.
  const reorderUnits = useMemo(
    () =>
      groupEnvironments && !expanded
        ? layoutActiveGroups(orderedInbox, false)
        : storedUnits.map((unit) =>
            unit.kind === "group" && collapsedProjects.has(unit.projectId) ? { ...unit, children: undefined } : unit,
          ),
    [orderedInbox, storedUnits, groupEnvironments, expanded, collapsedProjects],
  );
  const orderUnits = useMemo(() => allOrderUnits(storedUnits), [storedUnits]);
  const inbox = useMemo(() => {
    if (dragOrder?.shelf !== "inbox") return orderedInbox;
    const scope = unitsAtScope(reorderUnits, dragOrder.parentKey ?? null);
    if (dragOrder.mode === "unit" && !scope.some((unit) => unit.key === dragOrder.movingId)) return orderedInbox;
    const idsByKey = new Map(projectOrderUnits(scope).map((unit) => [unit.key, unit.ids]));
    return orderSubsetInPlace(
      orderedInbox,
      dragOrder.mode === "unit" ? dragOrder.ids.flatMap((key) => idsByKey.get(key) ?? []) : dragOrder.ids,
    );
  }, [orderedInbox, reorderUnits, dragOrder]);
  const units = useMemo(() => layoutActiveGroups(inbox, groupEnvironments), [inbox, groupEnvironments]);
  const visibleInbox = useMemo(
    () => visibleShelfThreads(inbox, expanded, activeThreadId, undefined, attentionIds),
    [inbox, expanded, activeThreadId, attentionIds],
  );
  const view = useMemo(
    (): ProjectViewUnit[] =>
      expanded
        ? projectGroupView(units, collapsedProjects, collapsedEnvironments, activeThreadId, attentionIds)
        : visibleInbox.map((thread) => ({ kind: "thread", key: thread.id, thread })),
    [expanded, units, collapsedProjects, collapsedEnvironments, activeThreadId, attentionIds, visibleInbox],
  );
  const reorderScope = (key: string): ReorderScope => {
    const visibleKeys = new Set(allOrderUnits(view).map((unit) => unit.key));
    const { units: scopeUnits, parentKey } = siblingScope(reorderUnits, key);
    const siblings = scopeUnits.filter(
      (unit) =>
        visibleKeys.has(unit.key) ||
        (unit.kind === "group" && unit.threads.some((thread) => visibleKeys.has(thread.id))),
    );
    return {
      mode: parentKey === null || siblings.some((unit) => unit.kind === "group") ? "unit" : "thread",
      ids: siblings.map((unit) => unit.key),
      parentKey,
    };
  };
  const rebaseOrder = (
    liveIds: readonly string[],
    previewIds: readonly string[],
    movingId: string,
    parentKey: string | null,
  ) => {
    const participating = new Set(previewIds);
    const liveUnits = projectOrderUnits(unitsAtScope(reorderUnits, parentKey)).filter((unit) =>
      participating.has(unit.key),
    );
    if (!liveUnits.some((unit) => unit.key === movingId)) return null;
    return rebaseMovedUnit(liveIds, liveUnits, previewIds, movingId);
  };
  return {
    inbox,
    visibleInbox,
    units,
    view,
    orderUnits,
    reorderScope,
    rebaseOrder,
    groupEnvironments,
    setGroupEnvironments,
    toggleProjectCollapse,
    toggleEnvironmentCollapse,
  };
}
