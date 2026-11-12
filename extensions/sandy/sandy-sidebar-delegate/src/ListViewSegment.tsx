import { cn } from "./lib/utils";
import type { ListView } from "./lib/inbox-preference-codecs";

const SEGMENTS: readonly { value: ListView; label: string }[] = [
  { value: "flow", label: "Flow" },
  { value: "spaces", label: "Spaces" },
];

export function ListViewSegment({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="List layout"
      className="mx-1.5 mt-1 flex gap-px rounded-md bg-sidebar-accent/40 p-px"
    >
      {SEGMENTS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "flex-1 rounded-[5px] px-2 py-0.5 text-2xs font-medium transition-colors",
            view === value ? "bg-sidebar text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
