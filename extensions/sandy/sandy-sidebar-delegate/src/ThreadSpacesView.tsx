import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { SpaceHeader, type SpaceFilter } from "./SpaceHeader";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import { treeMigratingExpansionCodec } from "./lib/space-preferences";
import type { SpaceHeaderDensity } from "./sidebar-settings-values";
import { SPACE_SHELVES, type SpaceShelf, type SpaceSignal, type SpaceView } from "./spaces-model";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { CreateSpaceForm } from "./SpaceManagement";

const SHELF_LABELS: Record<SpaceShelf, string> = {
  needs: "Needs you",
  failed: "Failed",
  working: "Working",
  review: "In review",
  merged: "Merged",
  orchestrators: "Orchestrators",
  dormant: "Dormant",
  idle: "Idle",
  snoozed: "Snoozed",
  archived: "Archived",
};

const NO_SPACE_KEY = "none";

function spaceKey(space: SpaceView): string {
  return space.id ?? NO_SPACE_KEY;
}

export function ThreadSpacesView({
  spaces,
  threads,
  density,
  filtered,
  renderThread,
}: {
  spaces: readonly SpaceView[];
  threads: readonly PluginSidebarThread[];
  density: SpaceHeaderDensity;
  filtered: boolean;
  renderThread: (thread: PluginSidebarThread, shelf: SpaceShelf) => ReactNode;
}) {
  const [expansionCodec] = useState(() => treeMigratingExpansionCodec(spaces.map(spaceKey)));
  const [expanded, setExpanded] = usePersistedPreference(STORAGE_KEYS.spaceExpansion.key, expansionCodec);
  const [filters, setFilters] = useState<ReadonlyMap<string, SpaceSignal>>(new Map());
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const toggle = useCallback(
    (key: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [setExpanded],
  );
  const filter = useCallback((key: string, signal: SpaceSignal) => {
    setFilters((current) => {
      const next = new Map(current);
      if (next.get(key) === signal) next.delete(key);
      else next.set(key, signal);
      return next;
    });
  }, []);
  return (
    <div className="flex flex-col">
      {spaces.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet.</p>
      ) : null}
      {spaces.map((space) => {
        const key = spaceKey(space);
        const open = expanded.has(key);
        const active: SpaceFilter = filters.get(key) ?? null;
        const roots = space.roots.filter((root) => active === null || root.signals[active]);
        return (
          <section key={key} aria-label={space.name}>
            <SpaceHeader
              space={space}
              density={density}
              filtered={filtered}
              expanded={open}
              filter={active}
              onToggle={() => toggle(key)}
              onFilter={(signal) => {
                filter(key, signal);
                if (!open) toggle(key);
              }}
            />
            {open ? (
              <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/70">
                {SPACE_SHELVES.map((shelf) => {
                  const shelfRoots = roots.filter((root) => root.shelf === shelf);
                  if (shelfRoots.length === 0) return null;
                  return (
                    <li key={shelf} className="list-none" data-space-shelf={shelf}>
                      <p
                        className={cn(
                          "mt-0.5 flex items-center gap-1.5 py-1 pl-4 text-2xs font-medium text-muted-foreground",
                          shelf === "needs" && "text-amber-500",
                        )}
                      >
                        <span>{SHELF_LABELS[shelf]}</span>
                        <span className="tabular-nums">{shelfRoots.length}</span>
                      </p>
                      <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/70">
                        {shelfRoots.map((root) => {
                          const thread = byId.get(root.rootId);
                          if (!thread) return null;
                          if (!thread.isPinned) return renderThread(thread, shelf);
                          return (
                            <li key={thread.id} data-space-pinned-row="" className="relative list-none">
                              <span
                                role="img"
                                aria-label="Pinned"
                                className="pointer-events-none absolute -left-[7px] top-2 z-10 grid size-3 place-items-center rounded-full bg-sidebar text-muted-foreground"
                              >
                                <Icon name="Pin" className="size-2.5" />
                              </span>
                              <ul className="flex flex-col">{renderThread(thread, shelf)}</ul>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
                {roots.length === 0 ? (
                  <li className="list-none px-2 py-2 text-2xs text-muted-foreground">
                    {space.roots.length === 0 ? "No sessions in this Space yet." : "No sessions match this filter."}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </section>
        );
      })}
      <CreateSpaceForm />
    </div>
  );
}
