import { useId, useState, type ReactNode } from "react";
import { Icon } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { cn } from "./lib/utils";
import { useInboxActions, useInboxEnvironment } from "./InboxContext";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { ROW_FIELDS, ROW_FIELD_LABELS } from "./row-fields";
import { useSelection } from "./SelectionHost";
import {
  SHELF_DENSITIES,
  THREAD_DENSITIES,
  type DensityShelf,
  type ShelfDensity,
  type ThreadDensity,
} from "./sidebar-settings-values";

export const DENSITY_LABELS: Record<ThreadDensity | ShelfDensity, string> = {
  default: "Default",
  auto: "Auto",
  comfortable: "Comfortable",
  compact: "Compact",
  dense: "Dense",
};

const DENSITY_HINTS: Record<ThreadDensity, string> = {
  auto: "Needs you and Failed get full cards, Working two lines, the rest one line",
  comfortable: "Three lines per thread",
  compact: "Two lines per thread",
  dense: "One line per thread",
};

const OPTION_ROW =
  "flex items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover";

function RadioOptions<const T extends string>({
  label,
  options,
  value,
  labels,
  hints,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  labels: Record<T, string>;
  hints?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option} className="block cursor-default" title={hints?.[option]}>
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            className="peer sr-only"
            onChange={() => onChange(option)}
          />
          <span className={OPTION_ROW}>
            {labels[option]}
            <span className="flex size-3.5 items-center justify-center">
              {value === option ? <Icon name="Check" className="size-4" aria-hidden /> : null}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-border pt-1 first:border-t-0 first:pt-0">
      <h3 className="px-2 pb-0.5 pt-1 text-2xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function ViewSheet({
  showArchived,
  onShowArchivedChange,
}: {
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { sidebarSettings, rowFields } = useInboxEnvironment();
  const { updateSidebarSettings, setRowFields } = useInboxActions();
  const selection = useSelection();
  const density = sidebarSettings?.threadDensity ?? DEFAULT_SIDEBAR_SETTINGS.threadDensity;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`View options: ${DENSITY_LABELS[density]}`}
          title="View options"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="View" className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="View options" className="w-72 max-w-[calc(100vw-1rem)] p-1">
        <SheetSection title="Density">
          <RadioOptions
            label="Density"
            options={THREAD_DENSITIES}
            value={density}
            labels={DENSITY_LABELS}
            hints={DENSITY_HINTS}
            onChange={(threadDensity) => void updateSidebarSettings({ threadDensity })}
          />
        </SheetSection>
        <SheetSection title="Show">
          <label className="block cursor-default">
            <input
              type="checkbox"
              checked={showArchived}
              className="peer sr-only"
              onChange={(event) => onShowArchivedChange(event.target.checked)}
            />
            <span className={OPTION_ROW}>
              Show archived
              <span className="flex size-3.5 items-center justify-center">
                {showArchived ? <Icon name="Check" className="size-4" aria-hidden /> : null}
              </span>
            </span>
          </label>
        </SheetSection>
        <SheetSection title="Show on rows">
          <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5">
            {ROW_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                aria-pressed={rowFields[field]}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  rowFields[field]
                    ? "border-transparent bg-sidebar-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setRowFields((current) => ({ ...current, [field]: !current[field] }))}
              >
                {ROW_FIELD_LABELS[field]}
              </button>
            ))}
          </div>
        </SheetSection>
        <SheetSection title="Select">
          <button
            type="button"
            className={cn(OPTION_ROW, "w-full outline-none focus-visible:bg-state-hover")}
            onClick={() => {
              setOpen(false);
              selection.enter();
            }}
          >
            Select threads
            <Icon name="CheckSquare" className="size-3.5" aria-hidden />
          </button>
        </SheetSection>
      </PopoverContent>
    </Popover>
  );
}

export function ShelfDensityMenu({ shelf, label }: { shelf: DensityShelf; label: string }) {
  const [open, setOpen] = useState(false);
  const { sidebarSettings } = useInboxEnvironment();
  const { updateSidebarSettings } = useInboxActions();
  const shelfDensities = sidebarSettings?.shelfDensities ?? DEFAULT_SIDEBAR_SETTINGS.shelfDensities;
  const value = shelfDensities[shelf];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Density for ${label}: ${DENSITY_LABELS[value]}`}
          title={`${label} options`}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 transition-colors duration-150 hover:bg-sidebar-accent hover:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value !== "default" && "bg-sidebar-accent/60 text-muted-foreground/80",
          )}
        >
          <Icon name="More" className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={`${label} options`} className="min-w-44 p-1">
        <SheetSection title="Density">
          <RadioOptions
            label={`${label} density`}
            options={SHELF_DENSITIES}
            value={value}
            labels={DENSITY_LABELS}
            onChange={(next) => {
              void updateSidebarSettings({ shelfDensities: { ...shelfDensities, [shelf]: next } });
              setOpen(false);
            }}
          />
        </SheetSection>
      </PopoverContent>
    </Popover>
  );
}
