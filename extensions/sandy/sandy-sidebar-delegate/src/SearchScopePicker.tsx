import { useId } from "react";
import { Icon } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { SEARCH_SCOPES, type SearchScope } from "./search-contract";
import { cn } from "./lib/utils";

const SCOPE_LABELS: Record<SearchScope, string> = {
  both: "Names and content",
  name: "Session names",
  content: "Session content",
};

export function SearchScopePicker({ scope, onChange }: { scope: SearchScope; onChange: (scope: SearchScope) => void }) {
  const groupName = useId();
  const label = `Search in: ${SCOPE_LABELS[scope]}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "flex h-6 shrink-0 items-center rounded border border-border px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring",
            scope === "both"
              ? "bg-transparent text-muted-foreground hover:text-foreground"
              : "bg-primary text-primary-foreground",
          )}
        >
          <Icon name="Filter" className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Search in" className="min-w-48 p-1">
        <div role="radiogroup" aria-label="Search in">
          {SEARCH_SCOPES.map((value) => (
            <label key={value} className="block cursor-default">
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={scope === value}
                className="peer sr-only"
                onChange={() => onChange(value)}
              />
              <span className="flex items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover">
                {SCOPE_LABELS[value]}
                {scope === value && <Icon name="Check" className="size-3.5" aria-hidden />}
              </span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
