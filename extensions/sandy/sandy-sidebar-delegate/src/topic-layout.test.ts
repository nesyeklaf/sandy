import { describe, expect, it } from "vitest";
import { buildEntries, clipTitle, hueOf, layoutTurns, mapRuns, turnRange } from "./topic-layout";
import { groupTurns } from "./topic-turns";
import type { TopicMessage } from "./topics-contract";

const msg = (seq: number, role: TopicMessage["role"], tokens = 10): TopicMessage => ({
  seq,
  role,
  preview: "p" + seq,
  lines: 1,
  words: 1,
  tokens,
});
const turns = groupTurns([msg(1, "user"), msg(2, "assistant"), msg(3, "user"), msg(4, "assistant"), msg(5, "user")]);
const segment = { id: "s1", threadId: "t", fromSeq: 1, toSeq: 2, title: "Tagging", tags: [] };

describe("topic layout", () => {
  it("gives the same text the same hue", () => {
    expect(hueOf("Tagging")).toBe(hueOf("tagging"));
    expect(hueOf("a")).not.toBe(hueOf("b"));
  });

  it("drops a suggestion that overlaps a saved topic and sorts by start", () => {
    const entries = buildEntries(
      [segment],
      [
        { fromSeq: 2, toSeq: 3, title: "Overlap", tags: [] },
        { fromSeq: 5, toSeq: 5, title: "Later", tags: ["x"] },
      ],
    );
    expect(entries.map((e) => [e.title, e.suggested])).toEqual([
      ["Tagging", false],
      ["Later", true],
    ]);
  });

  it("assigns turns to the topic that covers them and marks where a topic starts", () => {
    const entries = buildEntries([segment], []);
    const slots = layoutTurns(turns, entries);
    expect(slots.map((s) => s.owner?.title ?? null)).toEqual(["Tagging", null, null]);
    expect(slots[0]?.starts.map((e) => e.title)).toEqual(["Tagging"]);
    expect(slots[1]?.starts).toEqual([]);
  });

  it("merges consecutive turns of one owner into one weighted run", () => {
    const runs = mapRuns(layoutTurns(turns, buildEntries([{ ...segment, toSeq: 4 }], [])));
    expect(runs.map((r) => [r.owner?.title ?? null, r.weight])).toEqual([
      ["Tagging", 40],
      [null, 10],
    ]);
  });

  it("maps two turn indexes to a seq range in either order", () => {
    expect(turnRange(turns, 2, 0)).toEqual({ from: 1, to: 5 });
    expect(turnRange(turns, 0, 9)).toBeNull();
  });

  it("clips long titles", () => {
    expect(clipTitle("a  b\nc", 10)).toBe("a b c");
    expect(clipTitle("x".repeat(80), 10)).toBe("xxxxxxxxx…");
  });
});
