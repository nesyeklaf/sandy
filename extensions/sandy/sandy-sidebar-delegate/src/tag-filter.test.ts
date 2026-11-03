import { describe, expect, it } from "vitest";
import { filterByTags, isFiltering, NO_FILTER, pickerTags, tagCounts, toggleTag, type TagIndex } from "./tag-filter";

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
    expect(filterByTags(threads, index, { tags: ["bug"], query: "" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterByTags(threads, index, { tags: ["sidebar"], query: "" }).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keeps sessions that carry any of several picked tags", () => {
    expect(filterByTags(threads, index, { tags: ["bug", "sidebar"], query: "" }).map((t) => t.id)).toEqual(["a", "b"]);
    expect(filterByTags(threads, index, { tags: ["tags", "unknown"], query: "" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("searches topic titles and tags, case-insensitively, together with the tag", () => {
    expect(filterByTags(threads, index, { tags: [], query: "tree" }).map((t) => t.id)).toEqual(["b"]);
    expect(filterByTags(threads, index, { tags: ["sidebar"], query: "TAGGING" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterByTags(threads, index, { tags: ["bug"], query: "tree" })).toEqual([]);
  });

  it("toggles a tag in the picked list", () => {
    expect(toggleTag(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTag(["a", "b"], "a")).toEqual(["b"]);
  });

  it("lists a picked tag that no session carries any more so it can be unpicked", () => {
    expect(pickerTags(tagCounts(index), ["gone"]).map((c) => [c.tag, c.count])).toEqual([
      ["sidebar", 2],
      ["bug", 1],
      ["tags", 1],
      ["gone", 0],
    ]);
  });

  it("counts sessions per tag, most used first", () => {
    expect(tagCounts(index)).toEqual([
      { tag: "sidebar", count: 2 },
      { tag: "bug", count: 1 },
      { tag: "tags", count: 1 },
    ]);
  });
});
