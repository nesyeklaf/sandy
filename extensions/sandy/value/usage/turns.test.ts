import { describe, expect, it } from "vitest";

import { attributeUsage, promptsByTurn, type OutlineItem } from "./turns.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 24, 9);

const outline: OutlineItem[] = [
  { id: "thr_widgets:user-seed:1", role: "user", preview: "Add a CSV export to the widgets report" },
  { id: "thr_widgets:assistant:kind:assistant|turn:t1|parent:root|item:i1", role: "assistant", preview: "Reading the report" },
  { id: "thr_widgets:assistant:kind:assistant|turn:t1|parent:root|item:i2", role: "assistant", preview: "Done" },
  { id: "thr_widgets:user-seed:40", role: "user", preview: "Run the whole test suite" },
  { id: "thr_widgets:assistant:kind:assistant|turn:t2|parent:root|item:i9", role: "assistant", preview: "Running" },
];

describe("promptsByTurn", () => {
  it("gives each turn the message before its first assistant item", () => {
    expect([...promptsByTurn(outline)]).toEqual([
      ["t1", "Add a CSV export to the widgets report"],
      ["t2", "Run the whole test suite"],
    ]);
  });

  it("describes a message with no text by what it attached", () => {
    const prompts = promptsByTurn([
      { id: "thr_widgets:user-seed:1", role: "user", preview: "", attachmentSummary: { imageCount: 2, fileCount: 1 } },
      { id: "thr_widgets:assistant:kind:assistant|turn:t1|parent:root|item:i1", role: "assistant", preview: "Looking" },
      { id: "thr_widgets:assistant:kind:assistant|turn:t2|parent:root|item:i2", role: "assistant", preview: "Retrying" },
    ]);
    // t2 began without a message of yours, so it has none.
    expect([...prompts]).toEqual([["t1", "2 images and 1 file"]]);
  });
});

describe("attributeUsage", () => {
  const started = [
    { turnId: "t1", at: T0 },
    { turnId: "t2", at: T0 + 30 * MIN },
  ];
  const completed = [{ turnId: "t1", at: T0 + 10 * MIN }];

  it("assigns each row to the latest turn that started before it", () => {
    const turns = attributeUsage(
      [
        { at: T0 + 9 * MIN, input: 1, cacheRead: 100, output: 2 },
        { at: T0 + 40 * MIN, input: 3, cacheRead: 300, output: 4 },
        { at: T0 + 55 * MIN, input: 5, cacheRead: 500, output: 6 },
      ],
      started,
      completed,
      promptsByTurn(outline),
    );
    expect(turns).toEqual([
      { turnId: "t1", startedAt: T0, endedAt: T0 + 10 * MIN, usageAt: T0 + 9 * MIN, prompt: "Add a CSV export to the widgets report", input: 1, cacheRead: 100, output: 2 },
      { turnId: "t2", startedAt: T0 + 30 * MIN, endedAt: null, usageAt: T0 + 55 * MIN, prompt: "Run the whole test suite", input: 8, cacheRead: 800, output: 10 },
    ]);
  });

  it("groups rows from before the first known turn without a message", () => {
    const [first] = attributeUsage([{ at: T0 - MIN, input: 1, cacheRead: 0, output: 0 }], started, completed, new Map());
    expect(first).toMatchObject({ turnId: null, prompt: null, input: 1 });
  });
});
