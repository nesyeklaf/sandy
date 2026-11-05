import { useMemo } from "react";
import { PickerPopover } from "./PickerPopover";
import { SearchScopePicker } from "./SearchScopePicker";
import { selectedValues, tagItems, topicItems, withPicked } from "./tag-filter";
import { setTagFilter, useTagFilter } from "./useTagFilter";
import { useTagIndex } from "./useTagIndex";

export function TagFilterBar() {
  const filter = useTagFilter();
  const index = useTagIndex();
  const tags = useMemo(() => withPicked(tagItems(index), selectedValues(filter.tags)), [index, filter.tags]);
  const topics = useMemo(() => withPicked(topicItems(index), selectedValues(filter.topics)), [index, filter.topics]);
  return (
    <div role="group" aria-label="Session filter" className="flex shrink-0 items-center gap-1 px-2 pb-1">
      <input
        value={filter.query}
        aria-label="Search sessions"
        placeholder="Search sessions"
        className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        onChange={(event) => setTagFilter({ query: event.target.value })}
      />
      <SearchScopePicker scope={filter.scope} onChange={(scope) => setTagFilter({ scope })} />
      {topics.length > 0 && (
        <PickerPopover
          icon="Bookmark"
          noun="topics"
          items={topics}
          selection={filter.topics}
          onChange={(topics) => setTagFilter({ topics })}
        />
      )}
      {tags.length > 0 && (
        <PickerPopover
          icon="Tag"
          noun="tags"
          items={tags}
          selection={filter.tags}
          onChange={(tags) => setTagFilter({ tags })}
        />
      )}
    </div>
  );
}
