import type { useSidebarThreads } from "./sandy-sdk";
import type { ReactNode } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ThreadListLoading, ActiveEmptyState, WorkingEmptyState } from "./ThreadInboxEmptyStates";
import { CompactShelf, DockableShelves, CollapsibleShelf, ProjectGroups, Shelf } from "./ThreadInboxShelves";
import type { ActiveSortMode, ProjectViewUnit } from "./inbox-layout";
import { cn } from "./lib/utils";
import { ActiveSortPicker } from "./ActiveSortPicker";
import type { IconName } from "./components/Icon";
import type { ReorderShelf } from "./drag-reorder-geometry";
import type { InboxShelfId, LockableShelf } from "./thread-status";
import type { SlimRowKind } from "./SlimRow";
import { ProjectScopeControls } from "./ProjectScopeControls";
import { TagFilterBar } from "./TagFilterBar";
import type { ThreadReorderControls } from "./ThreadCard";
import { useInboxActions } from "./InboxContext";
import { SCROLL_FADE_CLASS } from "./useScrollFade";
import type { useInboxProjectGroups } from "./useInboxProjectGroups";
import { ListViewSegment, ThreadTreeView } from "./ThreadTreeView";
import { listViewCodec } from "./lib/inbox-preference-codecs";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import type { TreeProjectInput, TreeSectionInput } from "./tree-layout";
import { MergedArchiveAll } from "./MergedArchiveAll";
import { ViewSheet } from "./ViewSheet";

export type ShelfExpansionState = Record<InboxShelfId, boolean>;

interface ShelfThreads {
  threads: readonly PluginSidebarThread[];
  visibleThreads: readonly PluginSidebarThread[];
}

type CardShelf = Exclude<InboxShelfId, "snoozed" | "archived">;

const SHELF_HEADERS: Record<InboxShelfId, { label: string; icon: IconName }> = {
  pinned: { label: "Pinned", icon: "Pin" },
  needs: { label: "Needs you", icon: "Pulse" },
  failed: { label: "Failed", icon: "Alert" },
  working: { label: "Working", icon: "Loading" },
  review: { label: "In review", icon: "GitPullRequest" },
  waiting: { label: "Waiting", icon: "Hourglass" },
  merged: { label: "Merged", icon: "GitMerge" },
  snoozed: { label: "Snoozed", icon: "Clock" },
  archived: { label: "Archived", icon: "Archive" },
};

interface ThreadInboxViewProps {
  shelves: Record<InboxShelfId, ShelfThreads>;
  scope: readonly string[];
  reorderAnnouncement: string;
  attachScrollFadeRef: (node: HTMLDivElement | null) => void;
  status: ReturnType<typeof useSidebarThreads>["status"];
  expandedChildParentIds: ReadonlySet<string>;
  dockShelvesEnabled: boolean;
  attachShelvesMotionRef: (node: HTMLDivElement | null) => void;
  attachDockMotionRef: (node: HTMLDivElement | null) => void;
  expandedShelves: ShelfExpansionState;
  renderActiveThread: (
    thread: PluginSidebarThread,
    shelf: ReorderShelf,
    reorderable?: boolean,
    showProject?: boolean,
    renameShelf?: LockableShelf,
    showEnvironment?: boolean,
  ) => ReactNode;
  activeSortMode: ActiveSortMode;
  inboxProjectView: readonly ProjectViewUnit[];
  environmentGrouping: Pick<
    ReturnType<typeof useInboxProjectGroups>,
    "groupEnvironments" | "setGroupEnvironments" | "toggleEnvironmentCollapse"
  >;
  reorderControls: (key: string, shelf: ReorderShelf, title: string) => ThreadReorderControls;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  archivedLimit: number;
  archivedHasMorePages: boolean;
  onLoadMoreArchived: () => void;
  slimRowKind: (thread: PluginSidebarThread) => SlimRowKind;
  sections: readonly TreeSectionInput[];
  projects: readonly TreeProjectInput[];
}

export function ThreadInboxView({
  shelves,
  scope,
  reorderAnnouncement,
  attachScrollFadeRef,
  status,
  expandedChildParentIds,
  dockShelvesEnabled,
  attachShelvesMotionRef,
  attachDockMotionRef,
  expandedShelves,
  renderActiveThread,
  activeSortMode,
  inboxProjectView,
  environmentGrouping,
  reorderControls,
  showArchived,
  onShowArchivedChange,
  archivedLimit,
  archivedHasMorePages,
  onLoadMoreArchived,
  slimRowKind,
  sections,
  projects,
}: ThreadInboxViewProps) {
  const [listView, setListView] = usePersistedPreference(STORAGE_KEYS.listView.key, listViewCodec);
  const { setExpandedShelves, setActiveSortMode } = useInboxActions();
  const toggle = (shelf: InboxShelfId) => () =>
    setExpandedShelves((current) => ({ ...current, [shelf]: !current[shelf] }));
  const sortPicker = (
    <ActiveSortPicker
      mode={activeSortMode}
      onModeChange={setActiveSortMode}
      groupEnvironments={environmentGrouping.groupEnvironments}
      onGroupEnvironmentsChange={environmentGrouping.setGroupEnvironments}
    />
  );
  const cardShelf = (shelf: CardShelf, children: ReactNode, action?: ReactNode) =>
    shelves[shelf].threads.length > 0 ? (
      <CollapsibleShelf
        key={shelf}
        label={SHELF_HEADERS[shelf].label}
        icon={SHELF_HEADERS[shelf].icon}
        animateIcon={shelf === "working"}
        densityShelf={shelf}
        count={shelves[shelf].threads.length}
        expanded={expandedShelves[shelf]}
        onToggle={toggle(shelf)}
        action={action}
      >
        {children}
      </CollapsibleShelf>
    ) : null;
  const plainShelf = (shelf: Exclude<CardShelf, "pinned" | "needs" | "waiting">, action?: ReactNode) =>
    cardShelf(
      shelf,
      <Shelf label={null}>
        {shelves[shelf].visibleThreads.map((thread) => renderActiveThread(thread, "inbox", false, true, shelf))}
      </Shelf>,
      action,
    );
  const compactShelf = (shelf: "snoozed" | "archived") => (
    <CompactShelf
      key={shelf}
      label={SHELF_HEADERS[shelf].label}
      icon={SHELF_HEADERS[shelf].icon}
      threads={shelves[shelf].threads}
      expanded={expandedShelves[shelf]}
      onToggle={toggle(shelf)}
      kindFor={slimRowKind}
      expandedChildParentIds={expandedChildParentIds}
      visibleThreads={shelves[shelf].visibleThreads}
      limit={shelf === "archived" ? archivedLimit : undefined}
      hasMorePages={shelf === "archived" && archivedHasMorePages}
      onLoadMore={shelf === "archived" ? onLoadMoreArchived : undefined}
    />
  );
  const cardShelfCount = (["pinned", "needs", "failed", "working", "review", "waiting", "merged"] as const).filter(
    (shelf) => shelves[shelf].threads.length > 0,
  );
  return (
    <div data-sandy-sidebar-root="" className="flex min-h-0 flex-1 flex-col">
      {/* Project scope is plugin-owned; New thread lives in sandy's chrome. */}
      <ProjectScopeControls scope={scope} status={status} />
      <TagFilterBar />
      <div className="flex items-center gap-1 pr-1.5">
        <div className="min-w-0 flex-1">
          <ListViewSegment view={listView} onChange={setListView} />
        </div>
        <ViewSheet showArchived={showArchived} onShowArchivedChange={onShowArchivedChange} />
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {reorderAnnouncement}
      </p>

      <div
        data-list-motion-scroller=""
        ref={attachScrollFadeRef}
        className={cn("min-h-0 flex-1 overflow-y-auto px-1.5 pb-2", SCROLL_FADE_CLASS)}
      >
        {status === "loading" ? (
          <ThreadListLoading />
        ) : status === "error" ? (
          <p role="status" className="px-2 py-6 text-center text-xs text-muted-foreground">
            Could not load threads.
          </p>
        ) : listView === "tree" ? (
          <ThreadTreeView
            threads={(
              ["pinned", "needs", "failed", "working", "review", "waiting", "merged", "snoozed"] as const
            ).flatMap((shelf) => shelves[shelf].visibleThreads)}
            sections={sections}
            projects={projects}
            renderThread={(thread) => renderActiveThread(thread, "inbox", false, false)}
          />
        ) : (
          <DockableShelves
            docked={dockShelvesEnabled}
            attachUpperRef={attachShelvesMotionRef}
            attachLowerRef={attachDockMotionRef}
            upper={
              <>
                {cardShelf(
                  "pinned",
                  <Shelf label={null}>
                    {shelves.pinned.visibleThreads.map((thread) => renderActiveThread(thread, "pinned"))}
                  </Shelf>,
                )}
                {cardShelf(
                  "needs",
                  <Shelf label={null}>
                    {shelves.needs.visibleThreads.map((thread) =>
                      renderActiveThread(thread, "needs", true, true, "needs"),
                    )}
                  </Shelf>,
                  sortPicker,
                )}
                {plainShelf("failed")}
                {plainShelf("working")}
                {plainShelf("review")}
                {cardShelf(
                  "waiting",
                  activeSortMode === "project" ? (
                    <ProjectGroups
                      units={inboxProjectView}
                      onToggleEnvironment={environmentGrouping.toggleEnvironmentCollapse}
                      reorderControls={(unit, name) =>
                        reorderControls(unit.key, "inbox", `${name} ${unit.environment ? "environment" : "project"}`)
                      }
                      renderThread={(thread, grouped, environmentGrouped) =>
                        renderActiveThread(thread, "inbox", true, !grouped, "waiting", !environmentGrouped)
                      }
                    />
                  ) : (
                    <Shelf label={null}>
                      {shelves.waiting.visibleThreads.map((thread) => renderActiveThread(thread, "inbox"))}
                    </Shelf>
                  ),
                  sortPicker,
                )}
                {cardShelfCount.length === 0 ? <ActiveEmptyState /> : null}
                {cardShelfCount.length === 1 && cardShelfCount[0] === "working" ? <WorkingEmptyState /> : null}
              </>
            }
            lower={
              <>
                {plainShelf("merged", <MergedArchiveAll threads={shelves.merged.threads} />)}
                {compactShelf("snoozed")}
                {showArchived ? compactShelf("archived") : null}
              </>
            }
          />
        )}
      </div>
    </div>
  );
}
