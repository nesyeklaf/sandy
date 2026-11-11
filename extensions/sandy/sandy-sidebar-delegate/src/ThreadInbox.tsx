import { useSidebarThreads, useProviders, useThreadPullRequestsByEnvironment } from "./sandy-sdk";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { shareArray, shareArrayMap, shareShallowArray, useSharedValue } from "./lib/stable-identity";
import { useSandyNavigate, type PluginSidebarThread, type PluginThreadListProps } from "@sandy-sdk/plugin-sdk/app";
import { useInboxShelfThreads } from "./useInboxShelfThreads";
import { createDragReorderHandler } from "./drag-reorder";
import type { InboxDragOrder, ReorderShelf } from "./drag-reorder-geometry";
import { ThreadInboxView } from "./ThreadInboxView";
import { useQuantizedNow } from "./useQuantizedNow";
import { useProjectIconRevision } from "./useProjectIconRevision";
import { useRenamingShelfLocks } from "./useRenamingShelfLocks";
import { useDragClickSuppression } from "./useDragClickSuppression";
import { useListMotion, createListAnimationController } from "./useListMotion";
import {
  sameOrder,
  sortActiveThreads,
  visibleShelfThreads,
  type ReorderMode,
  type ReorderScope,
  projectUnitKey,
} from "./inbox-layout";
import type { ThreadReorderControls } from "./ThreadCard";
import { InboxProvider, useInboxContextValues } from "./InboxContext";
import { createInboxThreadRenderer } from "./InboxThreadRenderer";
import { childThreadsByParent } from "./ChildThreadList";
import { useChildThreadDisplayValue } from "./ChildThreadDisplay";
import { useLifecycle } from "./useLifecycle";
import { useSpaceViews } from "./useSpaceViews";
import { useChildExpansion } from "./useChildExpansion";
import type { createDragPreview } from "./drag-preview";
import { usePinnedReorder } from "./usePinnedReorder";
import { useParkActions } from "./useParkActions";
import { useCollapseChildrenOnSettle } from "./useCollapseChildrenOnSettle";
import { useActiveThreadStore } from "./useActiveThread";
import { useInboxReorder } from "./useInboxReorder";
import { useInboxProjectGroups } from "./useInboxProjectGroups";
import { environmentUnitKey } from "./environment-groups";
import { useWorkingSince } from "./useWorkingSince";
import { useSidebarSettingsState } from "./useSidebarSettings";
import { withoutFinishedDelegateChildren } from "./delegate-children";
import { useProjectScope } from "./useProjectScope";
import { useTagFilteredThreads } from "./useTagIndex";
import { threadDisplayTitle } from "./inbox";
import { useAttentionParentIds, useOrderedShelf, useStatusShelves } from "./useOrderedShelf";
import { movePinnedIdByOffset, orderPinnedThreads, rebaseMovedId } from "./pinned-order";
import { parseConfiguredSnoozePresets } from "./lifecycle";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { useScrollFade } from "./useScrollFade";
import { SETTLED_PAGE_SIZE } from "./ThreadInboxShelves";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import { activeSortCodec, shelfExpansionCodec, offByDefaultCodec, rowFieldsCodec } from "./lib/inbox-preference-codecs";
import type { SlimRowKind } from "./SlimRow";
const SETTLED_INITIAL_LIMIT = 10;

const SHELF_NAMES: Record<ReorderShelf, string> = { pinned: "Pinned", needs: "Needs you", inbox: "Waiting" };

/**
 * The sidebar's scrolling list. Manual order is durable; optional views sort
 * the same rows without changing their saved positions.
 *
 * The host owns New thread, and thread search lives in sandy's quick palette, so
 * this list ignores the deprecated `searchQuery` prop. It adds the plugin's
 * project scope picker.
 */
export function ThreadInbox({ activeThreadId, onNavigate, isCompactViewport }: PluginThreadListProps) {
  const [showArchived, setShowArchived] = usePersistedPreference(STORAGE_KEYS.showArchived.key, offByDefaultCodec);
  const [rowFields, setRowFields] = usePersistedPreference(STORAGE_KEYS.rowFields.key, rowFieldsCodec);
  const [activityOpen, setActivityOpen] = useState(false);
  const {
    status,
    threads: allThreads,
    projects: hostProjects,
    sections,
    delegateChildrenLoaded,
    experimental_archived: archivedPages,
  } = useSidebarThreads({ archived: showArchived || activityOpen });
  const projects = useSharedValue(hostProjects, shareShallowArray);
  const { settings: sidebarSettings, update: updateSidebarSettings } = useSidebarSettingsState();
  const hideFinishedSubagents =
    sidebarSettings?.hideFinishedSubagents ?? DEFAULT_SIDEBAR_SETTINGS.hideFinishedSubagents;
  const taggedThreads = useTagFilteredThreads(allThreads);
  const visibleThreads = useMemo(
    () =>
      hideFinishedSubagents ? withoutFinishedDelegateChildren(taggedThreads, activeThreadId ?? null) : taggedThreads,
    [taggedThreads, hideFinishedSubagents, activeThreadId],
  );
  const threads = useSharedValue(visibleThreads, shareArray);
  const workingSince = useWorkingSince(threads);
  const { providers } = useProviders();
  const navigate = useSandyNavigate();
  const lifecycle = useLifecycle(threads);
  const projectIconRevision = useProjectIconRevision();
  const listAnimationController = useMemo(() => createListAnimationController(!isCompactViewport), [isCompactViewport]);
  const attachShelvesMotionRef = useListMotion<HTMLDivElement>(listAnimationController);
  const attachDockMotionRef = useListMotion<HTMLDivElement>(listAnimationController);
  const attachScrollFadeRef = useScrollFade<HTMLDivElement>();
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const configuredSnoozePresets = sidebarSettings?.snoozePresets ?? DEFAULT_SIDEBAR_SETTINGS.snoozePresets;
  const snoozePresets = useMemo(() => parseConfiguredSnoozePresets(configuredSnoozePresets), [configuredSnoozePresets]);
  const dockShelvesEnabled = sidebarSettings?.dockShelves ?? DEFAULT_SIDEBAR_SETTINGS.dockShelves;
  const [scope, setScope] = useProjectScope({ projects, status });
  const spaces = useSpaceViews({ threads, sections, lifecycle, scope, includeArchived: showArchived });
  const now = useQuantizedNow();
  const projectNameById = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const [expandedShelves, setExpandedShelves] = usePersistedPreference(
    STORAGE_KEYS.shelfExpansion.key,
    shelfExpansionCodec,
  );
  const [activeSortMode, setActiveSortMode] = usePersistedPreference(STORAGE_KEYS.activeSort.key, activeSortCodec);
  const [settledLimit, setSettledLimit] = useState(SETTLED_INITIAL_LIMIT);
  const [renamingShelfLocks, setRenamingShelfLocks] = useRenamingShelfLocks(threads, lifecycle);
  const pullRequests = useThreadPullRequestsByEnvironment(threads);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const childDisplay = useChildThreadDisplayValue(sidebarSettings, providerById);
  const builtChildrenByParentId = useMemo(
    () => childThreadsByParent(threads, childDisplay.sort),
    [threads, childDisplay.sort],
  );
  const childrenByParentId = useSharedValue(builtChildrenByParentId, shareArrayMap);
  const { expandedChildParentIds, setExpandedChildParentIds, toggleChildExpansion } = useChildExpansion(
    childrenByParentId,
    delegateChildrenLoaded,
  );

  const {
    activeListThreadId,
    pinnedBase,
    needsBase,
    statusBases,
    waitingBase,
    allPinnedBase,
    allInboxBase,
    snoozed,
    archived,
    settled,
  } = useInboxShelfThreads({
    activeThreadId,
    childrenByParentId,
    lifecycle,
    pullRequests,
    renamingShelfLocks,
    scope,
    threads,
  });
  useCollapseChildrenOnSettle(settled, lifecycle, setExpandedChildParentIds);

  const pinnedReorder = usePinnedReorder(allPinnedBase);
  const inboxReorder = useInboxReorder(allInboxBase);
  // A "unit" drag moves whole project-view units, so its ids are unit keys
  // rather than thread ids.
  const [dragOrder, setDragOrder] = useState<InboxDragOrder | null>(null);
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;
  const dragPreviewRef = useRef<ReturnType<typeof createDragPreview> | null>(null);
  useLayoutEffect(() => {
    dragPreviewRef.current?.play();
  });
  const activeReorderCancelRef = useRef<(() => void) | null>(null);
  const suppressDragClick = useDragClickSuppression(activeReorderCancelRef);
  // A thread can be deleted from anywhere while it is being dragged. Unmounting
  // the whole sidebar already cancels; losing just this row has to as well, or
  // the drag keeps steering an order around an id that is gone. This catches
  // the thread leaving the host's list, not every way a row can stop being a
  // valid drag source — archiving or parking it still leaves the gesture
  // running until the drop rebases it.
  useEffect(() => {
    if (!dragOrder) return;
    const survives = threads.some(
      (thread) =>
        thread.id === dragOrder.movingId ||
        projectUnitKey(thread.projectId) === dragOrder.movingId ||
        (thread.environment?.id && environmentUnitKey(thread.projectId, thread.environment.id) === dragOrder.movingId),
    );
    if (!survives) activeReorderCancelRef.current?.();
  }, [dragOrder, threads]);
  const pinned = useMemo(() => {
    const ordered = orderPinnedThreads(pinnedBase, pinnedReorder.ids);
    return orderPinnedThreads(ordered, dragOrder?.shelf === "pinned" ? dragOrder.ids : null);
  }, [dragOrder, pinnedBase, pinnedReorder.ids]);
  const orderedInbox = useMemo(
    () => orderPinnedThreads(waitingBase, inboxReorder.ids),
    [waitingBase, inboxReorder.ids],
  );
  const attentionParentIds = useAttentionParentIds(
    sidebarSettings?.showRunningChildrenWhenCollapsed ?? DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed,
    childrenByParentId,
    [pinnedBase, needsBase, waitingBase, ...Object.values(statusBases)],
  );
  const visiblePinned = useMemo(
    () => visibleShelfThreads(pinned, expandedShelves.pinned, activeListThreadId, undefined, attentionParentIds),
    [attentionParentIds, activeListThreadId, expandedShelves.pinned, pinned],
  );
  const projectGroups = useInboxProjectGroups({
    orderedInbox,
    dragOrder,
    expanded: expandedShelves.waiting,
    activeThreadId: activeListThreadId,
    attentionIds: attentionParentIds,
    projectNameById,
  });
  const {
    inbox,
    visibleInbox,
    units: inboxProjectUnits,
    view: inboxProjectView,
    toggleProjectCollapse,
  } = projectGroups;
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  const needsOrder = useMemo(() => {
    const ordered = sortActiveThreads(orderPinnedThreads(needsBase, inboxReorder.ids), activeSortMode);
    return orderPinnedThreads(ordered, dragOrder?.shelf === "needs" ? dragOrder.ids : null);
  }, [activeSortMode, dragOrder, inboxReorder.ids, needsBase]);
  const needs = useOrderedShelf(needsOrder, null, expandedShelves.needs, activeListThreadId, attentionParentIds);
  const { failed, orchestrators, working, review, merged } = useStatusShelves(
    statusBases,
    expandedShelves,
    activeListThreadId,
    attentionParentIds,
  );
  const sortedVisibleInbox = useMemo(
    () => sortActiveThreads(visibleInbox, activeSortMode),
    [activeSortMode, visibleInbox],
  );
  const nextThreadCandidates = useMemo(
    () => [
      ...pinned,
      ...needs.threads,
      ...failed.threads,
      ...orchestrators.threads,
      ...working.threads,
      ...review.threads,
      ...(activeSortMode === "project"
        ? inboxProjectUnits.flatMap((unit) => (unit.kind === "thread" ? [unit.thread] : unit.threads))
        : sortActiveThreads(inbox, activeSortMode)),
      ...merged.threads,
    ],
    [activeSortMode, failed, inbox, inboxProjectUnits, merged, needs, orchestrators, pinned, review, working],
  );
  const nextThreadCandidatesRef = useRef(nextThreadCandidates);
  nextThreadCandidatesRef.current = nextThreadCandidates;

  // A drag installs its listeners once, at pointer-down, but the shelf keeps
  // moving underneath it: the host pushes order changes mid-gesture. The order
  // and the membership a drop depends on are therefore read through these refs
  // rather than captured, or the write reverts whatever landed while the
  // pointer was down. The row and shelf a gesture belongs to stay captured —
  // those are what the gesture is about.
  const reorderTargetsRef = useRef({
    pinned: pinnedReorder,
    needs: inboxReorder,
    inbox: inboxReorder,
  });
  reorderTargetsRef.current = { pinned: pinnedReorder, needs: inboxReorder, inbox: inboxReorder };
  const storedOrderUnitsRef = useRef(projectGroups.orderUnits);
  storedOrderUnitsRef.current = projectGroups.orderUnits;
  const activeSortModeRef = useRef(activeSortMode);
  activeSortModeRef.current = activeSortMode;
  /**
   * What a row or header reorders among. In the project view a thread inside
   * a group moves within its project; a lone thread or a group header moves
   * among the top-level units.
   */
  const reorderScope = useCallback(
    (key: string, shelf: ReorderShelf): ReorderScope => {
      if (shelf === "inbox" && activeSortMode === "project") {
        return projectGroups.reorderScope(key);
      }
      const visible = shelf === "pinned" ? visiblePinned : shelf === "needs" ? needs.visibleThreads : visibleInbox;
      return { mode: "thread", ids: visible.map((candidate) => candidate.id) };
    },
    [activeSortMode, needs.visibleThreads, projectGroups, visibleInbox, visiblePinned],
  );
  const reorderScopeRef = useRef(reorderScope);
  reorderScopeRef.current = reorderScope;
  const commitReorder = useCallback(
    (
      shelf: ReorderShelf,
      mode: ReorderMode,
      previewIds: readonly string[],
      movingId: string,
      parentKey: string | null = null,
    ) => {
      if (shelf === "pinned") {
        const live = reorderTargetsRef.current.pinned;
        void live.reorder(rebaseMovedId(live.ids, previewIds, movingId), movingId);
        return;
      }
      const live = reorderTargetsRef.current.inbox;
      const ids =
        shelf === "inbox" && (activeSortModeRef.current === "project" || mode === "unit")
          ? projectGroupsRef.current.rebaseOrder(live.ids, previewIds, movingId, parentKey)
          : rebaseMovedId(live.ids, previewIds, movingId);
      if (ids) void live.reorder(ids);
    },
    [],
  );
  // Keyboard reordering moves a row with no pointer to follow and no sound, so
  // the only feedback a screen reader gets is what this region says.
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");

  /**
   * Pointer and keyboard reordering for one row or project header. `key` is a
   * thread id, or a project unit key for a header.
   */
  const reorderControls = useCallback(
    (key: string, shelf: ReorderShelf, title: string): ThreadReorderControls => {
      const target = reorderTargetsRef.current[shelf];
      return {
        disabled: target.isReordering,
        isDragging: dragOrder?.shelf === shelf && dragOrder.movingId === key,
        onPointerDown: createDragReorderHandler({
          key,
          shelf,
          target,
          activeReorderCancelRef,
          dragOrderRef,
          dragPreviewRef,
          listAnimationController,
          suppressDragClick,
          reorderScopeRef,
          storedOrderUnitsRef,
          setDragOrder,
          commitReorder,
        }),
        onKeyDown: (event) => {
          if (!event.altKey || target.isReordering || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const { mode, ids: currentIds, parentKey } = reorderScopeRef.current(key, shelf);
          const ids = movePinnedIdByOffset(currentIds, key, event.key === "ArrowUp" ? -1 : 1);
          const shelfName = SHELF_NAMES[shelf];
          setReorderAnnouncement(
            sameOrder(ids, currentIds)
              ? `${title} is already ${event.key === "ArrowUp" ? "first" : "last"} in ${shelfName}`
              : `${title} moved to ${ids.indexOf(key) + 1} of ${ids.length} in ${shelfName}`,
          );
          commitReorder(shelf, mode, ids, key, parentKey);
        },
      };
    },
    [
      pinnedReorder.isReordering,
      inboxReorder.isReordering,
      dragOrder,
      listAnimationController,
      suppressDragClick,
      commitReorder,
    ],
  );
  const threadReorderControls = useCallback(
    (thread: PluginSidebarThread, shelf: ReorderShelf) => reorderControls(thread.id, shelf, threadDisplayTitle(thread)),
    [reorderControls],
  );

  const visibleSnoozed = useMemo(
    () => visibleShelfThreads(snoozed, expandedShelves.snoozed, activeListThreadId),
    [activeListThreadId, expandedShelves.snoozed, snoozed],
  );
  const visibleArchived = useMemo(
    () => visibleShelfThreads(archived, expandedShelves.archived, activeListThreadId, settledLimit),
    [activeListThreadId, expandedShelves.archived, archived, settledLimit],
  );
  const wokeThreadIds = useMemo(
    () =>
      new Set(
        [...pinned, ...needs.threads, ...failed.threads, ...inbox, ...review.threads, ...merged.threads]
          .filter((thread) => lifecycle.wokeFor(thread))
          .map((thread) => thread.id),
      ),
    [failed, inbox, lifecycle, merged, needs, pinned, review],
  );
  const slimRowKind = useCallback(
    (thread: PluginSidebarThread): SlimRowKind => {
      if (thread.isArchived) return "archived";
      const shelf = lifecycle.shelfFor(thread);
      return shelf === "parked" ? "parked" : shelf === "settled" ? "settled" : "snoozed";
    },
    [lifecycle],
  );
  const loadMoreArchived = useCallback(() => {
    setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE);
    if (archivedPages?.hasNextPage && !archivedPages.isFetchingNextPage) void archivedPages.fetchNextPage();
  }, [archivedPages]);

  const { parkThread, settleThread, snoozeThread } = useParkActions({
    lifecycle,
    navigate,
    onNavigate,
    activeThreadIdRef,
    nextThreadCandidatesRef,
  });

  const inboxContext = useInboxContextValues({
    providerById,
    projectNameById,
    projectIconRevision,
    projects,
    sidebarSettings,
    snoozePresets,
    lifecycle,
    childrenByParentId,
    rowFields,
    now,
    navigate,
    onNavigate,
    parkThread,
    settleThread,
    snoozeThread,
    toggleChildExpansion,
    setRenamingShelfLocks,
    setScope,
    setExpandedShelves,
    setActiveSortMode,
    setSettledLimit,
    setRowFields,
    toggleProjectCollapse,
    updateSidebarSettings,
  });
  const activeThreadStore = useActiveThreadStore(activeThreadId ?? null);
  const renderActiveThread = createInboxThreadRenderer({
    wokeThreadIds,
    expandedChildParentIds,
    threadReorderControls,
    activeSortMode,
  });

  return (
    <InboxProvider
      value={inboxContext}
      activeThread={activeThreadStore}
      listAnimationController={listAnimationController}
      workingSince={workingSince}
      childDisplay={childDisplay}
    >
      <ThreadInboxView
        shelves={{
          pinned: { threads: pinned, visibleThreads: visiblePinned },
          needs,
          failed,
          working,
          review,
          waiting: { threads: inbox, visibleThreads: sortedVisibleInbox },
          orchestrators,
          merged,
          snoozed: { threads: snoozed, visibleThreads: visibleSnoozed },
          archived: { threads: archived, visibleThreads: visibleArchived },
        }}
        scope={scope}
        reorderAnnouncement={reorderAnnouncement}
        attachScrollFadeRef={attachScrollFadeRef}
        status={status}
        expandedChildParentIds={expandedChildParentIds}
        dockShelvesEnabled={dockShelvesEnabled}
        attachShelvesMotionRef={attachShelvesMotionRef}
        attachDockMotionRef={attachDockMotionRef}
        expandedShelves={expandedShelves}
        renderActiveThread={renderActiveThread}
        activeSortMode={activeSortMode}
        inboxProjectView={inboxProjectView}
        environmentGrouping={projectGroups}
        reorderControls={reorderControls}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        allThreads={allThreads}
        activityOpen={activityOpen}
        onActivityOpenChange={setActivityOpen}
        archivedLimit={settledLimit}
        archivedHasMorePages={archivedPages?.hasNextPage ?? false}
        onLoadMoreArchived={loadMoreArchived}
        slimRowKind={slimRowKind}
        spaces={spaces}
        spaceHeaderDensity={sidebarSettings?.spaceHeaderDensity ?? DEFAULT_SIDEBAR_SETTINGS.spaceHeaderDensity}
        spacesFiltered={scope.length > 0 || taggedThreads.length !== allThreads.length}
      />
    </InboxProvider>
  );
}
