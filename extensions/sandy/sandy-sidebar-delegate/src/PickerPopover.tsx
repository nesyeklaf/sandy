import { useId, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import {
  cycleItem,
  type ItemState,
  isSelecting,
  itemState,
  LABEL_LEVELS,
  type LabelLevel,
  matchesNeedle,
  NO_SELECTION,
  type MatchMode,
  type PickerItem,
  type Selection,
} from "./tag-filter";
import { cn } from "./lib/utils";

const TRIGGER =
  "flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATE_TEXT: Record<ItemState, string> = {
  neutral: "not selected",
  include: "included",
  exclude: "excluded",
};

const LEVEL_TEXT: Record<LabelLevel, string> = {
  session: "Session",
  segment: "In Bereichen",
};

const MATCH_MODES: ReadonlyArray<{ mode: MatchMode; text: string; hint: string }> = [
  { mode: "any", text: "Any", hint: "A session needs at least one included item" },
  { mode: "all", text: "All", hint: "A session needs every included item" },
];

export function PickerPopover({
  icon,
  noun,
  items,
  selection,
  onChange,
}: {
  icon: IconName;
  noun: string;
  items: readonly PickerItem[];
  selection: Selection;
  onChange: (next: Selection) => void;
}) {
  const [needle, setNeedle] = useState("");
  const sectionId = useId();
  const { include, exclude } = selection;
  const summary = [
    include.length > 0 ? `${include.length} included` : "",
    exclude.length > 0 ? `${exclude.length} excluded` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const label = summary === "" ? `Filter by ${noun}` : `Filter by ${noun}: ${summary}`;
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
            isSelecting(selection)
              ? "bg-primary text-primary-foreground"
              : "bg-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={icon} className="size-3.5" aria-hidden />
          {include.length > 0 && <span>{include.length} ✓</span>}
          {exclude.length > 0 && <span>{exclude.length} ✕</span>}
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
        <div role="radiogroup" aria-label={`Match ${noun}`} className="mb-1 flex gap-1">
          {MATCH_MODES.map(({ mode, text, hint }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selection.match === mode}
              title={hint}
              className={cn(
                "flex-1 rounded border border-border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                selection.match === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onChange({ ...selection, match: mode })}
            >
              {text}
            </button>
          ))}
        </div>
        <div role="group" aria-label={noun} className="max-h-64 overflow-y-auto overscroll-contain">
          {LABEL_LEVELS.map((level) => {
            const section = shown.filter((item) => item.level === level);
            if (section.length === 0) return null;
            return (
              <div key={level} role="group" aria-labelledby={`${sectionId}-${level}`}>
                <p id={`${sectionId}-${level}`} className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">
                  {LEVEL_TEXT[level]}
                </p>
                {section.map(({ key, value, count }) => {
                  const state = itemState(selection, key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`${value}, ${STATE_TEXT[state]}`}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-state-hover focus-visible:bg-state-hover"
                      onClick={() => onChange(cycleItem(selection, key))}
                    >
                      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
                        {state === "include" && <Icon name="Check" className="size-3.5" />}
                        {state === "exclude" && <span className="text-destructive">✕</span>}
                      </span>
                      <span className={cn("min-w-0 flex-1 truncate", state === "exclude" && "line-through")}>
                        {value}
                      </span>
                      <span className="text-muted-foreground">{count}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing found</p>}
        </div>
        {isSelecting(selection) && (
          <button
            type="button"
            className="mt-1 w-full rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover"
            onClick={() => onChange({ ...NO_SELECTION, match: selection.match })}
          >
            Clear {noun}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
