import type { SearchScope } from "./search-contract";
import type { TopicSegment } from "./topics-contract";

export interface TagIndex {
  threadTags: Record<string, string[]>;
  segments: TopicSegment[];
}

interface TagFilter {
  tags: readonly string[];
  topics: readonly string[];
  query: string;
  scope: SearchScope;
}

export const NO_FILTER: TagFilter = { tags: [], topics: [], query: "", scope: "both" };

export interface PickerItem {
  value: string;
  count: number;
}

export function isFiltering(filter: TagFilter): boolean {
  return filter.tags.length > 0 || filter.topics.length > 0 || filter.query.trim() !== "";
}

/** Tags with the number of sessions that carry them, directly or through a topic. */
export function tagItems(index: TagIndex): PickerItem[] {
  const owners = new Map<string, Set<string>>();
  const add = (tag: string, threadId: string) => {
    const set = owners.get(tag) ?? new Set<string>();
    set.add(threadId);
    owners.set(tag, set);
  };
  for (const [threadId, tags] of Object.entries(index.threadTags)) for (const tag of tags) add(tag, threadId);
  for (const segment of index.segments) for (const tag of segment.tags) add(tag, segment.threadId);
  return sortedItems(owners);
}

/** Topic titles with the number of sessions that have a topic of that title. */
export function topicItems(index: TagIndex): PickerItem[] {
  const owners = new Map<string, Set<string>>();
  for (const segment of index.segments) {
    const set = owners.get(segment.title) ?? new Set<string>();
    set.add(segment.threadId);
    owners.set(segment.title, set);
  }
  return sortedItems(owners);
}

function sortedItems(owners: ReadonlyMap<string, ReadonlySet<string>>): PickerItem[] {
  return [...owners.entries()]
    .map(([value, set]) => ({ value, count: set.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** The known items, then picked ones that no session carries any more, so they can still be unpicked. */
export function withPicked(items: readonly PickerItem[], picked: readonly string[]): PickerItem[] {
  const known = new Set(items.map((item) => item.value));
  return [...items, ...picked.filter((value) => !known.has(value)).map((value) => ({ value, count: 0 }))];
}

export function matchesNeedle(items: readonly PickerItem[], needle: string): PickerItem[] {
  const text = needle.trim().toLowerCase();
  return text === "" ? [...items] : items.filter((item) => item.value.toLowerCase().includes(text));
}

/** Thread ids that carry at least one picked tag and have at least one picked topic, where picked. */
function labelledThreadIds(index: TagIndex, filter: TagFilter): Set<string> {
  const ids = new Set<string>();
  const candidates = new Set<string>([...Object.keys(index.threadTags), ...index.segments.map((s) => s.threadId)]);
  for (const threadId of candidates) {
    const segments = index.segments.filter((segment) => segment.threadId === threadId);
    const tags = [...(index.threadTags[threadId] ?? []), ...segments.flatMap((segment) => segment.tags)];
    if (filter.tags.length > 0 && !filter.tags.some((tag) => tags.includes(tag))) continue;
    if (filter.topics.length > 0 && !segments.some((segment) => filter.topics.includes(segment.title))) continue;
    ids.add(threadId);
  }
  return ids;
}

/** `found` holds the sessions the text search matched, or null when there is no text. */
export function filterThreads<T extends { id: string }>(
  threads: readonly T[],
  index: TagIndex,
  filter: TagFilter,
  found: ReadonlySet<string> | null,
): T[] {
  if (!isFiltering(filter)) return threads as T[];
  const labelled = filter.tags.length > 0 || filter.topics.length > 0 ? labelledThreadIds(index, filter) : null;
  return threads.filter(
    (thread) => (labelled === null || labelled.has(thread.id)) && (found === null || found.has(thread.id)),
  );
}
