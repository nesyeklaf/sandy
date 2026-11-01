import { describe, expect, it } from "vitest";
import type { TopicEntry } from "./topic-layout";
import { entryAt, stepEntry } from "./topic-rail";

const entry = (fromSeq: number, toSeq: number): TopicEntry => ({
  key: String(fromSeq),
  id: String(fromSeq),
  fromSeq,
  toSeq,
  title: "t" + fromSeq,
  tags: [],
  suggested: false,
  hue: 0,
});
const entries = [entry(1, 4), entry(10, 12), entry(20, 25)];

describe("entryAt", () => {
  it("finds the topic holding a seq", () => {
    expect(entryAt(entries, 11)?.fromSeq).toBe(10);
    expect(entryAt(entries, 5)).toBeNull();
    expect(entryAt(entries, null)).toBeNull();
  });
});

describe("stepEntry", () => {
  it("moves to the neighbour and wraps", () => {
    expect(stepEntry(entries, 2, 1)?.fromSeq).toBe(10);
    expect(stepEntry(entries, 22, 1)?.fromSeq).toBe(1);
    expect(stepEntry(entries, 2, -1)?.fromSeq).toBe(20);
  });
  it("goes to the nearest topic in that direction from a gap", () => {
    expect(stepEntry(entries, 6, 1)?.fromSeq).toBe(10);
    expect(stepEntry(entries, 6, -1)?.fromSeq).toBe(1);
    expect(stepEntry(entries, 30, 1)?.fromSeq).toBe(1);
  });
  it("starts at the ends without a position and is null without topics", () => {
    expect(stepEntry(entries, null, 1)?.fromSeq).toBe(1);
    expect(stepEntry(entries, null, -1)?.fromSeq).toBe(20);
    expect(stepEntry([], 3, 1)).toBeNull();
  });
});
