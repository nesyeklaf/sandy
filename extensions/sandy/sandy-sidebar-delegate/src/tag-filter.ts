import type { SearchScope } from "./search-contract";
import type { TopicSegment } from "./topics-contract";

export interface TagIndex {
  threadTags: Record<string, string[]>;
  segments: TopicSegment[];
}

export type MatchMode = "any" | "all";

export interface Selection {
  include: readonly string[];
  exclude: readonly string[];
  match: MatchMode;
}

export const NO_SELECTION: Selection = { include: [], exclude: [], match: "any" };

interface TagFilter {
  tags: Selection;
  topics: Selection;
  query: string;
  scope: SearchScope;
}

export const NO_FILTER: TagFilter = { tags: NO_SELECTION, topics: NO_SELECTION, query: "", scope: "both" };

export type ItemState = "neutral" | "include" | "exclude";

export function itemState(selection: Selection, value: string): ItemState {
  if (selection.include.includes(value)) return "include";
  return selection.exclude.includes(value) ? "exclude" : "neutral";
}

/** Neutral becomes included, included becomes excluded, excluded becomes neutral. */
export function cycleItem(selection: Selection, value: string): Selection {
  const without = (list: readonly string[]) => list.filter((entry) => entry !== value);
  switch (itemState(selection, value)) {
    case "neutral":
      return { ...selection, include: [...selection.include, value] };
    case "include":
      return { ...selection, include: without(selection.include), exclude: [...selection.exclude, value] };
    case "exclude":
      return { ...selection, exclude: without(selection.exclude) };
  }
}

export function isSelecting(selection: Selection): boolean {
  return selection.include.length > 0 || selection.exclude.length > 0;
}

export function selectedValues(selection: Selection): string[] {
  return [...selection.include, ...selection.exclude];
}

export interface PickerItem {
  value: string;
  count: number;
}

export function isFiltering(filter: TagFilter): boolean {
  return isSelecting(filter.tags) || isSelecting(filter.topics) || filter.query.trim() !== "";
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

function passes(selection: Selection, have: readonly string[]): boolean {
  if (selection.exclude.some((value) => have.includes(value))) return false;
  if (selection.include.length === 0) return true;
  return selection.match === "all"
    ? selection.include.every((value) => have.includes(value))
    : selection.include.some((value) => have.includes(value));
}

function matchesLabels(index: TagIndex, filter: TagFilter, threadId: string): boolean {
  const segments = index.segments.filter((segment) => segment.threadId === threadId);
  const tags = [...(index.threadTags[threadId] ?? []), ...segments.flatMap((segment) => segment.tags)];
  return (
    passes(filter.tags, tags) &&
    passes(
      filter.topics,
      segments.map((segment) => segment.title),
    )
  );
}

/** `found` holds the sessions the text search matched, or null when there is no text. */
export function filterThreads<T extends { id: string }>(
  threads: readonly T[],
  index: TagIndex,
  filter: TagFilter,
  found: ReadonlySet<string> | null,
): T[] {
  if (!isFiltering(filter)) return threads as T[];
  const labelled = isSelecting(filter.tags) || isSelecting(filter.topics);
  return threads.filter(
    (thread) => (!labelled || matchesLabels(index, filter, thread.id)) && (found === null || found.has(thread.id)),
  );
}
