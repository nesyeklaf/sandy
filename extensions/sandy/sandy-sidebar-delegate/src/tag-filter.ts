import type { SearchScope } from "./search-contract";
import type { TopicSegment } from "./topics-contract";

export interface TagIndex {
  threadTags: Record<string, string[]>;
  threadTopics: Record<string, string[]>;
  segments: TopicSegment[];
}

export type LabelLevel = "session" | "segment";

export const LABEL_LEVELS: readonly LabelLevel[] = ["session", "segment"];

const LEVEL_SEPARATOR = "\u001f";

export function labelKey(level: LabelLevel, value: string): string {
  return `${level}${LEVEL_SEPARATOR}${value}`;
}

function parseLabelKey(key: string): { level: LabelLevel; value: string } {
  const at = key.indexOf(LEVEL_SEPARATOR);
  const level = key.slice(0, at);
  return { level: level === "session" ? "session" : "segment", value: key.slice(at + 1) };
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
  key: string;
  level: LabelLevel;
  value: string;
  count: number;
}

export function isFiltering(filter: TagFilter): boolean {
  return isSelecting(filter.tags) || isSelecting(filter.topics) || filter.query.trim() !== "";
}

type Owners = Map<string, Set<string>>;

function addOwner(owners: Owners, value: string, threadId: string): void {
  const set = owners.get(value) ?? new Set<string>();
  set.add(threadId);
  owners.set(value, set);
}

function sessionOwners(labels: Record<string, string[]>): Owners {
  const owners: Owners = new Map();
  for (const [threadId, values] of Object.entries(labels)) for (const value of values) addOwner(owners, value, threadId);
  return owners;
}

export function tagItems(index: TagIndex): PickerItem[] {
  const segment: Owners = new Map();
  for (const entry of index.segments) for (const tag of entry.tags) addOwner(segment, tag, entry.threadId);
  return [...sortedItems("session", sessionOwners(index.threadTags)), ...sortedItems("segment", segment)];
}

export function topicItems(index: TagIndex): PickerItem[] {
  const segment: Owners = new Map();
  for (const entry of index.segments) addOwner(segment, entry.title, entry.threadId);
  return [...sortedItems("session", sessionOwners(index.threadTopics)), ...sortedItems("segment", segment)];
}

function sortedItems(level: LabelLevel, owners: Owners): PickerItem[] {
  return [...owners.entries()]
    .map(([value, set]) => ({ key: labelKey(level, value), level, value, count: set.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** The known items, then picked ones that no session carries any more, so they can still be unpicked. */
export function withPicked(items: readonly PickerItem[], picked: readonly string[]): PickerItem[] {
  const known = new Set(items.map((item) => item.key));
  const gone = picked.filter((key) => !known.has(key)).map((key) => ({ key, ...parseLabelKey(key), count: 0 }));
  return [...items, ...gone];
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

function levelKeys(session: readonly string[], segment: readonly string[]): string[] {
  return [
    ...session.map((value) => labelKey("session", value)),
    ...segment.map((value) => labelKey("segment", value)),
  ];
}

function matchesLabels(index: TagIndex, filter: TagFilter, threadId: string): boolean {
  const segments = index.segments.filter((segment) => segment.threadId === threadId);
  const tags = levelKeys(
    index.threadTags[threadId] ?? [],
    segments.flatMap((segment) => segment.tags),
  );
  const topics = levelKeys(
    index.threadTopics[threadId] ?? [],
    segments.map((segment) => segment.title),
  );
  return passes(filter.tags, tags) && passes(filter.topics, topics);
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
