import { useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { matchesNeedle, type PickerItem } from "./tag-filter";
import { cn } from "./lib/utils";

const TRIGGER =
  "flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function PickerPopover({
  icon,
  noun,
  items,
  picked,
  onChange,
}: {
  icon: IconName;
  noun: string;
  items: readonly PickerItem[];
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [needle, setNeedle] = useState("");
  const label = picked.length === 0 ? `Filter by ${noun}` : `Filter by ${noun}: ${picked.join(", ")}`;
  const shown = matchesNeedle(items, needle);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            TRIGGER,
            picked.length > 0
              ? "bg-primary text-primary-foreground"
              : "bg-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={icon} className="size-3.5" aria-hidden />
          {picked.length > 0 && <span>{picked.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={noun}
        className="w-64 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <input
          value={needle}
          aria-label={`Search ${noun}`}
          placeholder={`Search ${noun}`}
          className="mb-1 h-6 w-full rounded border border-border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          onChange={(event) => setNeedle(event.target.value)}
        />
        <div role="group" aria-label={noun} className="max-h-64 overflow-y-auto overscroll-contain">
          {shown.map(({ value, count }) => {
            const selected = picked.includes(value);
            return (
              <label key={value} className="block cursor-default">
                <input
                  type="checkbox"
                  checked={selected}
                  className="peer sr-only"
                  onChange={() => onChange(selected ? picked.filter((entry) => entry !== value) : [...picked, value])}
                />
                <span className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover">
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {selected && <Icon name="Check" className="size-3.5" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{value}</span>
                  <span className="text-muted-foreground">{count}</span>
                </span>
              </label>
            );
          })}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing found</p>}
        </div>
        {picked.length > 0 && (
          <button
            type="button"
            className="mt-1 w-full rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover"
            onClick={() => onChange([])}
          >
            Clear {noun}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
