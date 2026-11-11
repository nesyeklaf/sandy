import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ThreadCard, type ThreadReorderControls } from "./ThreadCard";
import { memo, useCallback } from "react";
import { useInboxEnvironment, useInboxActions } from "./InboxContext";
import { useIsActiveThread } from "./useActiveThread";
import type { ActiveSortMode } from "./inbox-layout";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { shelfDensity } from "./density";
import type { ReorderShelf } from "./drag-reorder-geometry";
import type { LockableShelf } from "./thread-status";

type ActiveShelfKind = ReorderShelf;

const NO_CHILDREN: readonly PluginSidebarThread[] = [];

type ReorderControls = (thread: PluginSidebarThread, shelf: ActiveShelfKind) => ThreadReorderControls;

// The wrapper receives stable row inputs. Menu hooks and card rendering stay
// behind this boundary when another shelf expands or collapses.
const InboxThread = memo(function InboxThread({
  thread,
  shelf,
  reorderable,
  showProject,
  renameShelf,
  showEnvironment,
  isWoke,
  childrenExpanded,
  threadReorderControls,
  activeSortMode,
}: {
  thread: PluginSidebarThread;
  shelf: ActiveShelfKind;
  reorderable: boolean;
  showProject: boolean;
  renameShelf: LockableShelf;
  showEnvironment: boolean;
  isWoke: boolean;
  childrenExpanded: boolean;
  threadReorderControls: ReorderControls;
  activeSortMode: ActiveSortMode;
}) {
  const { sidebarSettings, lifecycle, childrenByParentId } = useInboxEnvironment();
  const isActive = useIsActiveThread(thread.id);
  const { setRenamingShelfLocks } = useInboxActions();
  const settings = sidebarSettings ?? DEFAULT_SIDEBAR_SETTINGS;
  const onRenamingChange = useCallback(
    (editing: boolean) => {
      setRenamingShelfLocks((current) => {
        const next = new Map(current);
        if (editing) next.set(thread.id, renameShelf);
        else next.delete(thread.id);
        return next;
      });
    },
    [thread.id, renameShelf, setRenamingShelfLocks],
  );
  return (
    <ThreadCard
      thread={thread}
      showProject={showProject}
      projectIconOnly={settings.compactProjectIconOnly}
      showEnvironment={showEnvironment}
      isActive={isActive}
      isWoke={isWoke}
      canPark={lifecycle.canPark(thread)}
      onRenamingChange={onRenamingChange}
      childThreads={childrenByParentId.get(thread.id) ?? NO_CHILDREN}
      childrenExpanded={childrenExpanded}
      reorder={
        !reorderable ||
        (shelf === "pinned" && thread.pinSortKey == null) ||
        (shelf !== "pinned" && (activeSortMode === "activity" || activeSortMode === "created"))
          ? undefined
          : threadReorderControls(thread, shelf)
      }
      density={shelfDensity(settings, shelf === "pinned" ? "pinned" : renameShelf)}
      keepFull={(shelf === "pinned" && settings.keepPinnedThreadsFull) || (isWoke && settings.keepWokeThreadsFull)}
    />
  );
});

export function createInboxThreadRenderer({
  wokeThreadIds,
  expandedChildParentIds,
  threadReorderControls,
  activeSortMode,
}: {
  wokeThreadIds: ReadonlySet<string>;
  expandedChildParentIds: ReadonlySet<string>;
  threadReorderControls: ReorderControls;
  activeSortMode: ActiveSortMode;
}) {
  return (
    thread: PluginSidebarThread,
    shelf: ActiveShelfKind,
    reorderable = true,
    showProject = true,
    renameShelf: LockableShelf = "idle",
    showEnvironment = true,
  ) => (
    <InboxThread
      key={thread.id}
      thread={thread}
      shelf={shelf}
      reorderable={reorderable}
      showProject={showProject}
      renameShelf={renameShelf}
      showEnvironment={showEnvironment}
      isWoke={wokeThreadIds.has(thread.id)}
      childrenExpanded={expandedChildParentIds.has(thread.id)}
      threadReorderControls={threadReorderControls}
      activeSortMode={activeSortMode}
    />
  );
}
