import type { useSidebarThreads } from "./sandy-sdk";
import type { ReactNode } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ThreadListLoading, ActiveEmptyState, WorkingEmptyState } from "./ThreadInboxEmptyStates";
import {
  CompactShelf,
  DockableShelves,
  CollapsibleShelf,
  ProjectGroups,
  Shelf,
  SETTLED_PAGE_SIZE,
} from "./ThreadInboxShelves";
import type { ActiveSortMode, ProjectViewUnit } from "./inbox-layout";
import { cn } from "./lib/utils";
import { ActiveSortPicker } from "./ActiveSortPicker";
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

export interface ShelfExpansionState {
  active: boolean;
  pinned: boolean;
  working: boolean;
  review: boolean;
  inactive: boolean;
  parked: boolean;
  snoozed: boolean;
  settled: boolean;
}

interface ShelfThreads {
  threads: readonly PluginSidebarThread[];
  visibleThreads: readonly PluginSidebarThread[];
}

interface ThreadInboxViewProps {
  shelves: Record<
    "pinned" | "inbox" | "working" | "review" | "inactive" | "snoozed" | "parked" | "settled",
    ShelfThreads
  >;
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
    shelf: "pinned" | "inbox",
    reorderable?: boolean,
    showProject?: boolean,
    compact?: boolean,
    renameShelf?: "active" | "working" | "review" | "inactive",
    showEnvironment?: boolean,
  ) => ReactNode;
  activeSortMode: ActiveSortMode;
  inboxProjectView: readonly ProjectViewUnit[];
  environmentGrouping: Pick<
    ReturnType<typeof useInboxProjectGroups>,
    "groupEnvironments" | "setGroupEnvironments" | "toggleEnvironmentCollapse"
  >;
  reorderControls: (key: string, shelf: "pinned" | "inbox", title: string) => ThreadReorderControls;
  sortedVisibleInbox: readonly PluginSidebarThread[];
  settledLimit: number;
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
  sortedVisibleInbox,
  settledLimit,
  sections,
  projects,
}: ThreadInboxViewProps) {
  const [listView, setListView] = usePersistedPreference(STORAGE_KEYS.listView.key, listViewCodec);
  const { setExpandedShelves, setActiveSortMode, setSettledLimit } = useInboxActions();
  const { pinned, inbox, working, review, inactive, snoozed, parked, settled } = shelves;
  return (
    <div data-sandy-sidebar-root="" className="flex min-h-0 flex-1 flex-col">
      {/* Project scope is plugin-owned; New thread lives in sandy's chrome. */}
      <ProjectScopeControls scope={scope} status={status} />
      <TagFilterBar />
      <ListViewSegment view={listView} onChange={setListView} />

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
            threads={[
              ...pinned.visibleThreads,
              ...working.visibleThreads,
              ...inbox.visibleThreads,
              ...review.visibleThreads,
              ...inactive.visibleThreads,
              ...snoozed.visibleThreads,
              ...parked.visibleThreads,
            ]}
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
                {pinned.threads.length > 0 ? (
                  <CollapsibleShelf
                    label="Pinned"
                    icon="Pin"
                    count={pinned.threads.length}
                    expanded={expandedShelves.pinned}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        pinned: !current.pinned,
                      }))
                    }
                  >
                    <Shelf label={null}>
                      {pinned.visibleThreads.map((thread) => renderActiveThread(thread, "pinned"))}
                    </Shelf>
                  </CollapsibleShelf>
                ) : null}
                {inbox.threads.length > 0 ? (
                  <CollapsibleShelf
                    label="Needs you"
                    icon="Pulse"
                    count={inbox.threads.length}
                    expanded={expandedShelves.active}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        active: !current.active,
                      }))
                    }
                    action={
                      <ActiveSortPicker
                        mode={activeSortMode}
                        onModeChange={setActiveSortMode}
                        groupEnvironments={environmentGrouping.groupEnvironments}
                        onGroupEnvironmentsChange={environmentGrouping.setGroupEnvironments}
                      />
                    }
                  >
                    {activeSortMode === "project" ? (
                      <ProjectGroups
                        units={inboxProjectView}
                        onToggleEnvironment={environmentGrouping.toggleEnvironmentCollapse}
                        reorderControls={(unit, name) =>
                          reorderControls(unit.key, "inbox", `${name} ${unit.environment ? "environment" : "project"}`)
                        }
                        renderThread={(thread, grouped, environmentGrouped) =>
                          renderActiveThread(thread, "inbox", true, !grouped, false, "active", !environmentGrouped)
                        }
                      />
                    ) : inbox.visibleThreads.length > 0 ? (
                      <Shelf label={null}>
                        {sortedVisibleInbox.map((thread) => renderActiveThread(thread, "inbox"))}
                      </Shelf>
                    ) : null}
                  </CollapsibleShelf>
                ) : null}
                {pinned.threads.length === 0 &&
                inbox.threads.length === 0 &&
                working.threads.length === 0 &&
                review.threads.length === 0 &&
                inactive.threads.length === 0 ? (
                  <ActiveEmptyState />
                ) : null}
                {pinned.threads.length === 0 &&
                inbox.threads.length === 0 &&
                working.threads.length > 0 &&
                review.threads.length === 0 &&
                inactive.threads.length === 0 ? (
                  <WorkingEmptyState />
                ) : null}
              </>
            }
            lower={
              <>
                {working.threads.length > 0 ? (
                  <CollapsibleShelf
                    label="Working"
                    icon="Loading"
                    animateIcon
                    count={working.threads.length}
                    expanded={expandedShelves.working}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        working: !current.working,
                      }))
                    }
                  >
                    <Shelf label={null}>
                      {/* One line, like every shelf after Active. */}
                      {working.visibleThreads.map((thread) =>
                        renderActiveThread(thread, "inbox", false, true, true, "working"),
                      )}
                    </Shelf>
                  </CollapsibleShelf>
                ) : null}
                {review.threads.length > 0 ? (
                  <CollapsibleShelf
                    label="In review"
                    icon="GitPullRequest"
                    count={review.threads.length}
                    expanded={expandedShelves.review}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        review: !current.review,
                      }))
                    }
                  >
                    <Shelf label={null}>
                      {review.visibleThreads.map((thread) =>
                        renderActiveThread(thread, "inbox", false, true, false, "review"),
                      )}
                    </Shelf>
                  </CollapsibleShelf>
                ) : null}
                {inactive.threads.length > 0 ? (
                  <CollapsibleShelf
                    label="Inactive"
                    icon="PauseCircle"
                    count={inactive.threads.length}
                    expanded={expandedShelves.inactive}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        inactive: !current.inactive,
                      }))
                    }
                  >
                    <Shelf label={null}>
                      {inactive.visibleThreads.map((thread) =>
                        renderActiveThread(thread, "inbox", false, true, false, "inactive"),
                      )}
                    </Shelf>
                  </CollapsibleShelf>
                ) : null}
                <CompactShelf
                  label="Snoozed"
                  icon="Clock"
                  threads={snoozed.threads}
                  expanded={expandedShelves.snoozed}
                  onToggle={() =>
                    setExpandedShelves((current) => ({
                      ...current,
                      snoozed: !current.snoozed,
                    }))
                  }
                  shelf="snoozed"
                  expandedChildParentIds={expandedChildParentIds}
                  visibleThreads={snoozed.visibleThreads}
                />
                <CompactShelf
                  label="Parked"
                  icon="Car"
                  threads={parked.threads}
                  expanded={expandedShelves.parked}
                  onToggle={() =>
                    setExpandedShelves((current) => ({
                      ...current,
                      parked: !current.parked,
                    }))
                  }
                  shelf="parked"
                  expandedChildParentIds={expandedChildParentIds}
                  visibleThreads={parked.visibleThreads}
                />
                <CompactShelf
                  label="Settled"
                  icon="Meditation"
                  threads={settled.threads}
                  expanded={expandedShelves.settled}
                  onToggle={() =>
                    setExpandedShelves((current) => ({
                      ...current,
                      settled: !current.settled,
                    }))
                  }
                  shelf="settled"
                  expandedChildParentIds={expandedChildParentIds}
                  visibleThreads={settled.visibleThreads}
                  settledLimit={settledLimit}
                  onLoadMore={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)}
                />
              </>
            }
          />
        )}
      </div>
    </div>
  );
}
