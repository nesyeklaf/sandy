import { describe, expect, it } from "vitest";
import {
  cycleItem,
  filterThreads,
  itemState,
  isFiltering,
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
  segments: [
    { id: "s1", threadId: "a", fromSeq: 1, toSeq: 4, title: "Tagging in der Sidebar", tags: ["sidebar", "tags"] },
    { id: "s2", threadId: "b", fromSeq: 1, toSeq: 9, title: "Tree-Ansicht", tags: ["sidebar"] },
    { id: "s3", threadId: "b", fromSeq: 10, toSeq: 12, title: "Tagging in der Sidebar", tags: [] },
  ],
};
const threads = [{ id: "a" }, { id: "b" }, { id: "c" }];
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

  it("matches a tag on the session or on one of its topics", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["bug"]) }, null))).toEqual(["a"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["sidebar"]) }, null))).toEqual(["a", "b"]);
  });

  it("keeps sessions that carry any of several picked tags", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["bug", "sidebar"]) }, null))).toEqual([
      "a",
      "b",
    ]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["tags", "unknown"]) }, null))).toEqual(["a"]);
  });

  it("requires every included tag when matching all, pooling a session's tags with its topics' tags", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["bug", "tags"], [], "all") }, null))).toEqual([
      "a",
    ]);
    expect(
      ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["bug", "sidebar"], [], "all") }, null)),
    ).toEqual(["a"]);
    expect(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["bug", "nope"], [], "all") }, null)).toEqual([]);
  });

  it("drops sessions with an excluded tag but keeps sessions without any tags", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([], ["sidebar"]) }, null))).toEqual(["c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick([], ["bug"]) }, null))).toEqual(["b", "c"]);
  });

  it("lets an exclusion beat an inclusion", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: pick(["sidebar"], ["bug"]) }, null))).toEqual(["b"]);
  });

  it("requires every included topic when matching all and excludes by topic title", () => {
    const both = pick(["Tagging in der Sidebar", "Tree-Ansicht"], [], "all");
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: both }, null))).toEqual(["b"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick([], ["Tree-Ansicht"]) }, null))).toEqual([
      "a",
      "c",
    ]);
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
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick(["Tree-Ansicht"]) }, null))).toEqual(["b"]);
    expect(
      ids(filterThreads(threads, index, { ...NO_FILTER, topics: pick(["Tagging in der Sidebar"]) }, null)),
    ).toEqual(["a", "b"]);
  });

  it("needs a session to fit both the tags and the topics when both are picked", () => {
    const filter = { ...NO_FILTER, tags: pick(["bug"]), topics: pick(["Tree-Ansicht"]) };
    expect(filterThreads(threads, index, filter, null)).toEqual([]);
  });

  it("narrows to the sessions the text search found, together with tags", () => {
    const found = new Set(["b", "c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, query: "x" }, found))).toEqual(["b", "c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, query: "x", tags: pick(["bug"]) }, found))).toEqual([]);
    expect(filterThreads(threads, index, { ...NO_FILTER, query: "x" }, new Set())).toEqual([]);
  });

  it("counts sessions per tag and per topic title, most used first", () => {
    expect(tagItems(index)).toEqual([
      { value: "sidebar", count: 2 },
      { value: "bug", count: 1 },
      { value: "tags", count: 1 },
    ]);
    expect(topicItems(index)).toEqual([
      { value: "Tagging in der Sidebar", count: 2 },
      { value: "Tree-Ansicht", count: 1 },
    ]);
  });

  it("lists a picked item that no session carries any more so it can be unpicked", () => {
    expect(withPicked(tagItems(index), ["gone", "bug"]).map((c) => [c.value, c.count])).toEqual([
      ["sidebar", 2],
      ["bug", 1],
      ["tags", 1],
      ["gone", 0],
    ]);
  });

  it("narrows a picker list by a case-insensitive needle", () => {
    expect(matchesNeedle(topicItems(index), " TREE ").map((c) => c.value)).toEqual(["Tree-Ansicht"]);
    expect(matchesNeedle(topicItems(index), "")).toEqual(topicItems(index));
  });
});
