import { useMemo, useState } from "react";
import { Icon } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { pickerTags, tagCounts, toggleTag } from "./tag-filter";
import { setTagFilter, useTagFilter } from "./useTagFilter";
import { useTagIndex } from "./useTagIndex";
import { cn } from "./lib/utils";

export function TagFilterBar() {
  const filter = useTagFilter();
  const index = useTagIndex();
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => tagCounts(index), [index]);
  const tags = useMemo(() => pickerTags(counts, filter.tags), [counts, filter.tags]);
  if (tags.length === 0 && filter.query === "") return null;
  const picked = filter.tags.length;
  const label = picked === 0 ? "Filter by tags" : `Filter by tags: ${filter.tags.join(", ")}`;
  return (
    <div role="group" aria-label="Tag filter" className="flex shrink-0 items-center gap-1 px-2 pb-1">
      <input
        value={filter.query}
        aria-label="Search topics and tags"
        placeholder="Search topics and tags"
        className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        onChange={(event) => setTagFilter({ query: event.target.value })}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={label}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
              picked > 0
                ? "bg-primary text-primary-foreground"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name="Tag" className="size-3.5" />
            {picked > 0 && <span>{picked}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" aria-label="Tags" className="w-60 p-1">
          <div role="group" aria-label="Tags" className="max-h-72 overflow-y-auto overscroll-contain">
            {tags.map(({ tag, count }) => {
              const selected = filter.tags.includes(tag);
              return (
                <label key={tag} className="block cursor-default">
                  <input
                    type="checkbox"
                    checked={selected}
                    className="peer sr-only"
                    onChange={() => setTagFilter({ tags: toggleTag(filter.tags, tag) })}
                  />
                  <span className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover">
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      {selected && <Icon name="Check" className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{tag}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {picked > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover"
              onClick={() => setTagFilter({ tags: [] })}
            >
              Clear tags
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
