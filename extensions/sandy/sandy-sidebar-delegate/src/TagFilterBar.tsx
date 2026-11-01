import { useMemo } from "react";
import { tagCounts } from "./tag-filter";
import { setTagFilter, useTagFilter } from "./useTagFilter";
import { useTagIndex } from "./useTagIndex";
import { cn } from "./lib/utils";

/** Tag chips and a topic search above the list; picking a tag narrows the sessions. */
export function TagFilterBar() {
  const filter = useTagFilter();
  const index = useTagIndex();
  const counts = useMemo(() => tagCounts(index), [index]);
  if (counts.length === 0 && filter.tag === null && filter.query === "") return null;
  return (
    <div role="group" aria-label="Tag filter" className="flex shrink-0 flex-col gap-1 px-2 pb-1">
      <input
        value={filter.query}
        aria-label="Search topics and tags"
        placeholder="Search topics and tags"
        className="h-6 rounded border border-border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        onChange={(event) => setTagFilter({ query: event.target.value })}
      />
      <div className="flex flex-wrap gap-1">
        {counts.map(({ tag, count }) => {
          const active = filter.tag === tag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={active}
              title={`Show sessions tagged ${tag}`}
              onClick={() => setTagFilter({ tag: active ? null : tag })}
              className={cn(
                "rounded-full px-2 py-0.5 text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-sidebar-accent text-muted-foreground hover:text-foreground",
              )}
            >
              {tag} {count}
            </button>
          );
        })}
      </div>
    </div>
  );
}
