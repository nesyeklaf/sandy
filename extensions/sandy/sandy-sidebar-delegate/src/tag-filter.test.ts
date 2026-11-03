import { describe, expect, it } from "vitest";
import {
  filterThreads,
  isFiltering,
  matchesNeedle,
  NO_FILTER,
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
const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);

describe("tag filter", () => {
  it("passes everything through without a filter", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(filterThreads(threads, index, NO_FILTER, null)).toEqual(threads);
  });

  it("matches a tag on the session or on one of its topics", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: ["bug"] }, null))).toEqual(["a"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: ["sidebar"] }, null))).toEqual(["a", "b"]);
  });

  it("keeps sessions that carry any of several picked tags", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: ["bug", "sidebar"] }, null))).toEqual(["a", "b"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, tags: ["tags", "unknown"] }, null))).toEqual(["a"]);
  });

  it("keeps sessions with any of the picked topics", () => {
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: ["Tree-Ansicht"] }, null))).toEqual(["b"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, topics: ["Tagging in der Sidebar"] }, null))).toEqual([
      "a",
      "b",
    ]);
  });

  it("needs a session to fit both the tags and the topics when both are picked", () => {
    const filter = { ...NO_FILTER, tags: ["bug"], topics: ["Tree-Ansicht"] };
    expect(filterThreads(threads, index, filter, null)).toEqual([]);
  });

  it("narrows to the sessions the text search found, together with tags", () => {
    const found = new Set(["b", "c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, query: "x" }, found))).toEqual(["b", "c"]);
    expect(ids(filterThreads(threads, index, { ...NO_FILTER, query: "x", tags: ["bug"] }, found))).toEqual([]);
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
