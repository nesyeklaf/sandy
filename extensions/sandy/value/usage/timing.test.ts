import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createStore, MIGRATIONS } from "./store.js";
import { timeBreakdown, timingRowsOf, turnSplits, type TimingEventLike } from "./timing.js";

const turn = { kind: "turn", turnId: "t1" };

function item(type: "item/started" | "item/completed", createdAt: number, body: Record<string, unknown>): TimingEventLike {
  return { type, createdAt, scope: turn, data: { item: body } };
}

const EVENTS: TimingEventLike[] = [
  { type: "turn/started", createdAt: 0, scope: turn, data: {} },
  item("item/started", 1_000, { id: "i1", type: "reasoning" }),
  item("item/started", 2_000, { id: "i2", type: "commandExecution", command: "npm test" }),
  item("item/completed", 62_000, { id: "i2", type: "commandExecution", command: "npm test" }),
  item("item/started", 63_000, { id: "i3", type: "toolCall", tool: "Skill" }),
  item("item/started", 64_000, { id: "i4", type: "delegation", background: true, label: "Research" }),
  item("item/started", 64_500, { id: "i5", type: "backgroundTask" }),
  {
    type: "system/interaction/lifecycle",
    createdAt: 70_000,
    scope: turn,
    data: { interaction: { id: "pint_1", status: "pending", payload: { kind: "user_question" } } },
  },
  {
    type: "system/interaction/lifecycle",
    createdAt: 130_000,
    scope: turn,
    data: { interaction: { id: "pint_1", status: "resolved", payload: { kind: "user_question" } } },
  },
  { type: "turn/completed", createdAt: 200_000, scope: turn, data: {} },
];

describe("timingRowsOf", () => {
  it("keeps turns, the tools a turn waits on, and questions to you", () => {
    const rows = timingRowsOf(EVENTS);
    expect(rows.turns).toEqual([
      { turnId: "t1", startedAt: 0, completedAt: null },
      { turnId: "t1", startedAt: null, completedAt: 200_000 },
    ]);
    // Reasoning is the model's own time; a background subagent or task does not hold the turn up.
    expect(rows.items.map((row) => [row.itemId, row.kind, row.label])).toEqual([
      ["i2", "commandExecution", "npm test"],
      ["i2", "commandExecution", "npm test"],
      ["i3", "toolCall", "Skill"],
    ]);
    expect(rows.waits.map((row) => [row.kind, row.startedAt, row.resolvedAt])).toEqual([
      ["user_question", 70_000, null],
      ["user_question", 130_000, 130_000],
    ]);
  });
});

describe("recording timings", () => {
  it("merges a start and an end read in different pages", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    store.recordTimings("thr_widgets", timingRowsOf(EVENTS.slice(0, 3)));
    store.recordTimings("thr_widgets", timingRowsOf(EVENTS.slice(3)));
    // A page read twice changes nothing.
    store.recordTimings("thr_widgets", timingRowsOf(EVENTS.slice(3)));

    const timings = store.threadTimings("thr_widgets");
    expect(timings.turns).toEqual([{ turnId: "t1", startedAt: 0, completedAt: 200_000 }]);
    expect(timings.items[0]).toMatchObject({ itemId: "i2", label: "npm test", startedAt: 2_000, completedAt: 62_000 });
    expect(timings.items[1]).toMatchObject({ itemId: "i3", startedAt: 63_000, completedAt: null });
    expect(timings.waits).toEqual([
      { interactionId: "pint_1", turnId: "t1", kind: "user_question", startedAt: 70_000, resolvedAt: 130_000 },
    ]);
  });
});

describe("turnSplits", () => {
  it("splits a turn into model, tools, and waiting on you, counting overlaps once", () => {
    const splits = turnSplits({
      turns: [{ turnId: "t1", startedAt: 0, completedAt: 100_000 }],
      items: [
        // Two commands that overlap for 10 seconds.
        { itemId: "a", turnId: "t1", kind: "commandExecution", label: "npm test", startedAt: 10_000, completedAt: 30_000 },
        { itemId: "b", turnId: "t1", kind: "commandExecution", label: "npm run build", startedAt: 20_000, completedAt: 40_000 },
        // The question tool call, which covers the wait.
        { itemId: "c", turnId: "t1", kind: "toolCall", label: "AskUserQuestion", startedAt: 50_000, completedAt: 70_000 },
        // Still open when the turn ended, so it counts to the turn's end.
        { itemId: "d", turnId: "t1", kind: "commandExecution", label: "npm run watch", startedAt: 90_000, completedAt: null },
      ],
      waits: [{ interactionId: "q", turnId: "t1", kind: "user_question", startedAt: 51_000, resolvedAt: 69_000 }],
    });
    expect(splits.get("t1")).toEqual({ tools: 30_000 + 2_000 + 10_000, waiting: 18_000, model: 40_000 });
  });

  it("leaves out a turn that has not finished", () => {
    const splits = turnSplits({ turns: [{ turnId: "t2", startedAt: 0, completedAt: null }], items: [], waits: [] });
    expect(splits.size).toBe(0);
  });
});

describe("timeBreakdown", () => {
  it("totals the split, each kind of tool outside waits, and turns by length", () => {
    const breakdown = timeBreakdown({
      turns: [
        { turnId: "t1", startedAt: 0, completedAt: 100_000 },
        { turnId: "t2", startedAt: 200_000, completedAt: 230_000 },
        { turnId: "t3", startedAt: 300_000, completedAt: null },
      ],
      items: [
        { itemId: "a", turnId: "t1", kind: "commandExecution", label: "npm test", startedAt: 10_000, completedAt: 30_000 },
        { itemId: "b", turnId: "t1", kind: "commandExecution", label: "npm run build", startedAt: 20_000, completedAt: 40_000 },
        { itemId: "c", turnId: "t1", kind: "toolCall", label: "AskUserQuestion", startedAt: 50_000, completedAt: 70_000 },
        { itemId: "d", turnId: "t2", kind: "fileRead", label: null, startedAt: 205_000, completedAt: 206_000 },
        { itemId: "e", turnId: "t3", kind: "commandExecution", label: "npm run e2e", startedAt: 300_000, completedAt: 400_000 },
      ],
      waits: [{ interactionId: "q", turnId: "t1", kind: "user_question", startedAt: 51_000, resolvedAt: 69_000 }],
    });
    expect(breakdown.turns).toBe(2);
    expect(breakdown.questions).toBe(1);
    expect(breakdown.split).toEqual({ model: 50_000 + 29_000, tools: 32_000 + 1_000, waiting: 18_000 });
    expect(breakdown.kinds).toEqual([
      { kind: "commandExecution", ms: 30_000, count: 2 },
      { kind: "toolCall", ms: 2_000, count: 1 },
      { kind: "fileRead", ms: 1_000, count: 1 },
    ]);
    expect(breakdown.lengths.map((length) => length.turns)).toEqual([1, 1, 0, 0]);
  });
});
