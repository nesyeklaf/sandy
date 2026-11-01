import { describe, expect, it } from "vitest";
import { filterByTags, isFiltering, NO_FILTER, tagCounts, type TagIndex } from "./tag-filter";

const index: TagIndex = {
  threadTags: { a: ["bug"], b: [] },
  segments: [
    { id: "s1", threadId: "a", fromSeq: 1, toSeq: 4, title: "Tagging in der Sidebar", tags: ["sidebar", "tags"] },
    { id: "s2", threadId: "b", fromSeq: 1, toSeq: 9, title: "Tree-Ansicht", tags: ["sidebar"] },
  ],
};
const threads = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("tag filter", () => {
  it("passes everything through without a filter", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(filterByTags(threads, index, NO_FILTER)).toEqual(threads);
  });

  it("matches a tag on the session or on one of its topics", () => {
    expect(filterByTags(threads, index, { tag: "bug", query: "" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterByTags(threads, index, { tag: "sidebar", query: "" }).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("searches topic titles and tags, case-insensitively, together with the tag", () => {
    expect(filterByTags(threads, index, { tag: null, query: "tree" }).map((t) => t.id)).toEqual(["b"]);
    expect(filterByTags(threads, index, { tag: "sidebar", query: "TAGGING" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterByTags(threads, index, { tag: "bug", query: "tree" })).toEqual([]);
  });

  it("counts sessions per tag, most used first", () => {
    expect(tagCounts(index)).toEqual([
      { tag: "sidebar", count: 2 },
      { tag: "bug", count: 1 },
      { tag: "tags", count: 1 },
    ]);
  });
});
