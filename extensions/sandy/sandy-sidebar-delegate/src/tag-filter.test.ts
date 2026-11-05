import { describe, expect, it } from "vitest";
import {
  cycleItem,
  filterThreads,
  itemState,
  isFiltering,
  labelKey,
  matchesNeedle,
  NO_FILTER,
  NO_SELECTION,
  type Selection,
  tagItems,
  topicItems,
  withPicked,
  type TagIndex,
} from "./tag-filter";

const index: TagIndex = {
  threadTags: { a: ["bug"], b: [] },
  threadTopics: { a: ["Release"], c: ["Tree-Ansicht"] },
  segments: [
    { id: "s1", threadId: "a", fromSeq: 1, toSeq: 4, title: "Tagging in der Sidebar", tags: ["sidebar", "tags"] },
    { id: "s2", threadId: "b", fromSeq: 1, toSeq: 9, title: "Tree-Ansicht", tags: ["sidebar"] },
    { id: "s3", threadId: "b", fromSeq: 10, toSeq: 12, title: "Tagging in der Sidebar", tags: [] },
  ],
};
const threads = [{ id: "a" }, { id: "b" }, { id: "c" }];
const session = (value: string) => labelKey("session", value);
const area = (value: string) => labelKey("segment", value);
const pick = (include: string[], exclude: string[] = [], match: Selection["match"] = "any"): Selection => ({
  include,
  exclude,
  match,
});
const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);

describe("tag filter", () => {
  it("passes everything through without a filter", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(filterThreads(threads, index, NO_FILTER, null)).toEqual(threads);
  });

  it("matches a session tag only on the session and an area tag only in its areas", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([session("bug")]) }, null))).toEqual(["a"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([area("sidebar")]) }, null))).toEqual([
      "a",
      "b",
    ]);
    expect(filterThreads(threads, index, { ...NO_FILTER, tags: pick([session("sidebar")]) }, null)).toEqual([]);
    expect(filterThreads(threads, index, { ...NO_FILTER, tags: pick([area("bug")]) }, null)).toEqual([]);
  });

  it("keeps sessions that carry any of several picked tags across both levels", () => {
    const filter = { ...NO_FILTER, tags: pick([session("bug"), area("sidebar")]) };
    expect(ids(filterThreads(threads, index, filter, null))).toEqual(["a", "b"]);
    expect(
      ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([area("tags"), area("unknown")]) }, null)),
    ).toEqual(["a"]);
  });

  it("requires every included tag when matching all, each on its own level", () => {
    const all = (include: string[]) => ({ ...NO_FILTER, tags: pick(include, [], "all") });
    expect(ids(filterThreads(threads, index, all([session("bug"), area("tags")]), null))).toEqual(["a"]);
    expect(ids(filterThreads(threads, index, all([session("bug"), area("sidebar")]), null))).toEqual(["a"]);
    expect(filterThreads(threads, index, all([session("bug"), session("tags")]), null)).toEqual([]);
  });

  it("drops sessions with an excluded tag on that level but keeps sessions without any tags", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([], [area("sidebar")]) }, null))).toEqual([
      "c",
    ]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([], [session("bug")]) }, null))).toEqual([
      "b",
      "c",
    ]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([], [area("bug")]) }, null))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("lets an exclusion beat an inclusion", () => {
    const filter = { ...NO_FILTER, tags: pick([area("sidebar")], [session("bug")]) };
    expect(ids(filterThreads(threads, index, filter, null))).toEqual(["b"]);
  });

  it("matches a session topic only on the session and an area topic only by its title", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([session("Tree-Ansicht")]) }, null))).toEqual(
      ["c"],
    );
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([area("Tree-Ansicht")]) }, null))).toEqual([
      "b",
    ]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([session("Release")]) }, null))).toEqual([
      "a",
    ]);
  });

  it("requires every included topic when matching all and excludes by topic title", () => {
    const both = pick([area("Tagging in der Sidebar"), area("Tree-Ansicht")], [], "all");
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: both }, null))).toEqual(["b"]);
    const mixed = pick([session("Release"), area("Tagging in der Sidebar")], [], "all");
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: mixed }, null))).toEqual(["a"]);
    expect(
      ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([], [area("Tree-Ansicht")]) }, null)),
    ).toEqual(["a", "c"]);
  });

  it("cycles an item from neutral to included to excluded and back", () => {
    const included = cycleItem(NO_SELECTION, "x");
    const excluded = cycleItem(included, "x");
    expect([itemState(included, "x"), itemState(excluded, "x"), itemState(cycleItem(excluded, "x"), "x")]).toEqual([
      "include",
      "exclude",
      "neutral",
    ]);
    expect(cycleItem(pick(["y"], [], "all"), "x")).toEqual(pick(["y", "x"], [], "all"));
  });

  it("keeps sessions with any of the picked topics", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([area("Tree-Ansicht")]) }, null))).toEqual([
      "b",
    ]);
    expect(
      ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([area("Tagging in der Sidebar")]) }, null)),
    ).toEqual(["a", "b"]);
  });

  it("needs a session to fit both the tags and the topics when both are picked", () => {
    const filter = { ...NO_FILTER, tags: pick([session("bug")]), topics: pick([area("Tree-Ansicht")]) };
    expect(filterThreads(threads, index, filter, null)).toEqual([]);
  });

  it("narrows to the sessions the text search found, together with tags", () => {
    const found = new Set(["b", "c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, query: "x" }, found))).toEqual(["b", "c"]);
    const tagged = { ...NO_FILTER, query: "x", tags: pick([session("bug")]) };
    expect(ids(filterThreads(threads, index, tagged, found))).toEqual([]);
    expect(filterThreads(threads, index, { ...NO_FILTER, query: "x" }, new Set())).toEqual([]);
  });

  it("counts sessions per level, so a value on both levels appears in both", () => {
    const rows = (items: ReturnType<typeof tagItems>) => items.map((item) => [item.level, item.value, item.count]);
    expect(rows(tagItems({ ...index, threadTags: { a: ["bug", "sidebar"], b: [] } }))).toEqual([
      ["session", "bug", 1],
      ["session", "sidebar", 1],
      ["segment", "sidebar", 2],
      ["segment", "tags", 1],
    ]);
    expect(rows(topicItems(index))).toEqual([
      ["session", "Release", 1],
      ["session", "Tree-Ansicht", 1],
      ["segment", "Tagging in der Sidebar", 2],
      ["segment", "Tree-Ansicht", 1],
    ]);
  });

  it("lists a picked item that no session carries any more so it can be unpicked", () => {
    expect(
      withPicked(tagItems(index), [area("gone"), session("bug"), area("bug")]).map((c) => [c.level, c.value, c.count]),
    ).toEqual([
      ["session", "bug", 1],
      ["segment", "sidebar", 2],
      ["segment", "tags", 1],
      ["segment", "gone", 0],
      ["segment", "bug", 0],
    ]);
  });

  it("narrows a picker list by a case-insensitive needle", () => {
    expect(matchesNeedle(topicItems(index), " TREE ").map((c) => c.key)).toEqual([
      session("Tree-Ansicht"),
      area("Tree-Ansicht"),
    ]);
    expect(matchesNeedle(topicItems(index), "")).toEqual(topicItems(index));
  });
});
