import { useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { SpaceAddOrchestrator } from "./SpaceAddOrchestrator";
import { SpaceActions, SpaceDeleteConfirm, SpaceRenameForm } from "./SpaceManagement";
import { cn } from "./lib/utils";
import type { SpaceHeaderDensity } from "./sidebar-settings-values";
import type { SpaceSignal, SpaceView } from "./spaces-model";

export type SpaceFilter = SpaceSignal | null;

interface StatSpec {
  signal: SpaceSignal;
  label: string;
  icon: IconName;
  tone: string;
  urgent?: string;
}

const STATS: readonly StatSpec[] = [
  { signal: "needs", label: "needs you", icon: "CircleQuestion", tone: "text-amber-500", urgent: "bg-amber-500/15" },
  { signal: "working", label: "working", icon: "Loading", tone: "text-sky-500" },
  { signal: "openPr", label: "open PR", icon: "GitPullRequest", tone: "text-foreground/80" },
  { signal: "dormant", label: "dormant", icon: "Clock", tone: "text-muted-foreground" },
  { signal: "failed", label: "failed", icon: "Alert", tone: "text-destructive", urgent: "bg-destructive/15" },
];

function visibleStats(counts: SpaceView["counts"], density: SpaceHeaderDensity): StatSpec[] {
  if (density === "minimal")
    return STATS.filter(({ signal }) => (signal === "needs" || signal === "failed") && counts[signal] > 0);
  return STATS.filter(({ signal }) => signal !== "failed" || counts.failed > 0);
}

function StatButton({
  stat,
  count,
  spaceName,
  pressed,
  words,
  onClick,
}: {
  stat: StatSpec;
  count: number;
  spaceName: string;
  pressed: boolean;
  words: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={count === 0}
      aria-pressed={pressed}
      aria-label={`${count} ${stat.label} in ${spaceName}`}
      title={stat.label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs tabular-nums hover:bg-sidebar-accent max-md:min-h-8 max-md:min-w-8 max-md:justify-center",
        words && "border border-sidebar-border/60",
        count === 0 ? "text-muted-foreground" : stat.tone,
        count > 0 && stat.urgent,
        pressed && "bg-sidebar-accent ring-1 ring-ring",
      )}
    >
      <Icon name={stat.icon} className="size-3.5 shrink-0" aria-hidden />
      <span>{count}</span>
      {words ? <span>{stat.label}</span> : null}
    </button>
  );
}

export function SpaceHeader({
  space,
  density,
  filtered,
  expanded,
  filter,
  onToggle,
  onFilter,
}: {
  space: SpaceView;
  density: SpaceHeaderDensity;
  filtered: boolean;
  expanded: boolean;
  filter: SpaceFilter;
  onToggle: () => void;
  onFilter: (signal: SpaceSignal) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingOrchestrator, setAddingOrchestrator] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const repoLabel = space.repositories === 1 ? "1 repository" : `${space.repositories} repositories`;
  const stats = visibleStats(space.counts, density);
  const activeStat = STATS.find(({ signal }) => signal === filter);
  const statButton = (stat: StatSpec, words: boolean) => (
    <StatButton
      key={stat.signal}
      stat={stat}
      count={space.counts[stat.signal]}
      spaceName={space.name}
      pressed={filter === stat.signal}
      words={words}
      onClick={() => onFilter(stat.signal)}
    />
  );
  return (
    <>
      <div data-space-header={density} className="mt-2 rounded-md bg-sidebar-accent/40 px-2 py-1">
        <div className="flex items-center gap-1">
          {renaming && space.id !== null ? (
            <SpaceRenameForm spaceId={space.id} name={space.name} onDone={() => setRenaming(false)} />
          ) : (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={`${space.name} (${space.total})`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left max-md:min-h-11"
            >
              <Icon
                name={expanded ? "ChevronDown" : "ChevronRight"}
                className="size-3 shrink-0 text-muted-foreground/60"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{space.name}</span>
              {filtered ? <span className="text-2xs text-muted-foreground/70">filtered</span> : null}
              <span className="text-2xs tabular-nums text-muted-foreground/60">{space.total}</span>
            </button>
          )}
          {density === "minimal" && !renaming ? stats.map((stat) => statButton(stat, false)) : null}
          {space.id !== null && !renaming ? (
            <SpaceActions
              name={space.name}
              deleteRef={deleteRef}
              onRenaming={setRenaming}
              onDelete={() => setDeleting(true)}
              onAddOrchestrator={() => setAddingOrchestrator(true)}
            />
          ) : null}
        </div>
        {density === "minimal" ? null : (
          <div className="mt-1 flex flex-wrap gap-1 pl-4">
            {stats.map((stat) => statButton(stat, density === "detailed"))}
          </div>
        )}
        {density === "detailed" ? (
          <p className="mt-1 pl-4 text-2xs text-muted-foreground">
            {repoLabel} · {space.idle} idle
          </p>
        ) : null}
        {activeStat ? (
          <div className="mt-1 flex items-center gap-2 pl-4 text-2xs text-muted-foreground">
            <span>Filter: {activeStat.label}</span>
            <button
              type="button"
              aria-label={`Show all in ${space.name}`}
              onClick={() => onFilter(activeStat.signal)}
              className="rounded px-1.5 py-0.5 underline hover:bg-sidebar-accent max-md:min-h-8"
            >
              Show all
            </button>
          </div>
        ) : null}
      </div>
      {addingOrchestrator && space.id !== null ? (
        <SpaceAddOrchestrator spaceId={space.id} name={space.name} onClose={() => setAddingOrchestrator(false)} />
      ) : null}
      {deleting && space.id !== null ? (
        <SpaceDeleteConfirm
          spaceId={space.id}
          name={space.name}
          total={space.total}
          onClose={() => {
            setDeleting(false);
            deleteRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
