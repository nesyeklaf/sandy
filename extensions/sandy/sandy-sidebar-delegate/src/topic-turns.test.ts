import { describe, expect, it } from "vitest";
import { groupTurns, pickRange } from "./topic-turns";

const m = (seq: number, role: "user" | "assistant") => ({ seq, role, preview: "x", lines: 1, words: 1, tokens: 1 });

describe("groupTurns", () => {
  it("starts a turn at each user prompt and collects the agent messages after it", () => {
    const turns = groupTurns([m(1, "user"), m(2, "assistant"), m(3, "assistant"), m(5, "user")]);
    expect(turns.map((t) => [t.fromSeq, t.toSeq, t.agents.length])).toEqual([
      [1, 3, 2],
      [5, 5, 0],
    ]);
  });

  it("keeps agent messages that come before any prompt in a turn without a user", () => {
    const [turn] = groupTurns([m(4, "assistant")]);
    expect(turn?.user).toBeNull();
    expect(turn?.agents).toHaveLength(1);
  });
});

describe("pickRange", () => {
  it("sets the start with the first tap and the end with the second", () => {
    const first = pickRange(null, { from: 5, to: 7 }, false);
    expect(first).toEqual({ from: 5, to: 7, open: true });
    expect(pickRange(first, { from: 1, to: 3 }, false)).toMatchObject({ from: 1, to: 7, open: false });
  });

  it("starts over on a tap once the range is complete", () => {
    const done = { from: 1, to: 7, open: false };
    expect(pickRange(done, { from: 9, to: 9 }, false)).toEqual({ from: 9, to: 9, open: true });
  });

  it("extends a finished range with Shift and keeps the topic being edited", () => {
    const done = { from: 5, to: 5, editingId: "s1", open: false };
    expect(pickRange(done, { from: 8, to: 9 }, true)).toEqual({ from: 5, to: 9, editingId: "s1", open: false });
  });
});
