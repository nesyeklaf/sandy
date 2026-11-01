import type { TopicSegment } from "./topics-contract";

export interface TagIndex {
  threadTags: Record<string, string[]>;
  segments: TopicSegment[];
}

interface TagFilter {
  tag: string | null;
  query: string;
}

export const NO_FILTER: TagFilter = { tag: null, query: "" };

export function isFiltering(filter: TagFilter): boolean {
  return filter.tag !== null || filter.query.trim() !== "";
}

/** Tags with the number of sessions that carry them, directly or through a topic. */
export function tagCounts(index: TagIndex): Array<{ tag: string; count: number }> {
  const owners = new Map<string, Set<string>>();
  const add = (tag: string, threadId: string) => {
    const set = owners.get(tag) ?? new Set<string>();
    set.add(threadId);
    owners.set(tag, set);
  };
  for (const [threadId, tags] of Object.entries(index.threadTags)) for (const tag of tags) add(tag, threadId);
  for (const segment of index.segments) for (const tag of segment.tags) add(tag, segment.threadId);
  return [...owners.entries()]
    .map(([tag, set]) => ({ tag, count: set.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Thread ids that match the tag and the text; the text searches topic titles and tags. */
function matchingThreadIds(index: TagIndex, filter: TagFilter): Set<string> {
  const needle = filter.query.trim().toLowerCase();
  const ids = new Set<string>();
  const tagsOf = (threadId: string) => index.threadTags[threadId] ?? [];
  const candidates = new Set<string>([...Object.keys(index.threadTags), ...index.segments.map((s) => s.threadId)]);
  for (const threadId of candidates) {
    const segments = index.segments.filter((segment) => segment.threadId === threadId);
    const tags = [...tagsOf(threadId), ...segments.flatMap((segment) => segment.tags)];
    if (filter.tag !== null && !tags.includes(filter.tag)) continue;
    if (needle !== "") {
      const haystack = [...tags, ...segments.map((segment) => segment.title)];
      if (!haystack.some((text) => text.toLowerCase().includes(needle))) continue;
    }
    ids.add(threadId);
  }
  return ids;
}

export function filterByTags<T extends { id: string }>(threads: readonly T[], index: TagIndex, filter: TagFilter): T[] {
  if (!isFiltering(filter)) return threads as T[];
  const ids = matchingThreadIds(index, filter);
  return threads.filter((thread) => ids.has(thread.id));
}
