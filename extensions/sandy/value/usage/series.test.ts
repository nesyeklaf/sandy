import { describe, expect, it } from "vitest";

import { fillBars, formatTokens, niceTicks, timeBuckets, windowFor } from "./series.js";

const HOUR = 3_600_000;

describe("windowFor", () => {
  const now = new Date(2026, 8, 24, 14, 37);

  it("draws 24 hourly bars ending with the current hour", () => {
    const { bars, since, unit } = windowFor("day", now);
    expect(unit).toBe("hour");
    expect(bars).toHaveLength(24);
    expect(bars.at(-1)!.start).toBe(new Date(2026, 8, 24, 14).getTime());
    expect(since).toBe(new Date(2026, 8, 23, 15).getTime());
  });

  it("draws 72 hourly bars for three days", () => {
    expect(windowFor("three-days", now).bars).toHaveLength(72);
  });

  it("draws seven day bars counting today", () => {
    const { bars, since, unit } = windowFor("week", now);
    expect(unit).toBe("day");
    expect(bars).toHaveLength(7);
    expect(since).toBe(new Date(2026, 8, 18).getTime());
    expect(bars.at(-1)!.end).toBe(new Date(2026, 8, 25).getTime());
  });
});

describe("fillBars", () => {
  it("adds each hour to its bar and drops hours outside the window", () => {
    const { bars } = windowFor("week", new Date(2026, 8, 24, 14));
    const today = new Date(2026, 8, 24).getTime();
    const filled = fillBars(bars, [
      { hour: today + 2 * HOUR, input: 1, cacheRead: 2, output: 3 },
      { hour: today + 9 * HOUR, input: 10, cacheRead: 20, output: 30 },
      { hour: today - 30 * 24 * HOUR, input: 100, cacheRead: 0, output: 0 },
    ]);
    expect(filled.at(-1)).toMatchObject({ input: 11, cacheRead: 22, output: 33 });
    expect(filled.slice(0, -1).every((bar) => bar.input === 0)).toBe(true);
    expect(bars.at(-1)!.input).toBe(0);
  });
});

describe("formatTokens", () => {
  it("shortens to three significant figures", () => {
    expect([950, 12_345, 4_500_000, 71_406_250, 1_230_000_000].map(formatTokens)).toEqual([
      "950",
      "12.3K",
      "4.5M",
      "71.4M",
      "1.23B",
    ]);
  });
});

describe("niceTicks", () => {
  it("rounds the axis up to a step at or above the tallest bar", () => {
    expect(niceTicks(9_000_000)).toEqual([0, 2_500_000, 5_000_000, 7_500_000, 10_000_000]);
    expect(niceTicks(0)).toEqual([0]);
  });
});

describe("timeBuckets", () => {
  const at = (hour: number, minute: number) => new Date(2026, 8, 24, hour, minute).getTime();
  const item = (time: number, tokens: number) => ({ time, input: tokens, cacheRead: 0, output: 0 });

  it("picks a round size that keeps the count under the limit and starts on clock boundaries", () => {
    const items = [item(at(10, 7), 5), item(at(10, 12), 3), item(at(12, 50), 9)];
    const buckets = timeBuckets(items, (entry) => entry.time, at(10, 7), at(12, 50), 24);
    // 2h43m over at most 24 buckets: 15 minutes each, from 10:00 to 12:45.
    expect(buckets).toHaveLength(12);
    expect(buckets[0]!.start).toBe(at(10, 0));
    expect(buckets[0]).toMatchObject({ input: 8, items: [0, 1] });
    expect(buckets.at(-1)).toMatchObject({ start: at(12, 45), input: 9, items: [2] });
  });

  it("draws one bucket when everything happened at once", () => {
    const buckets = timeBuckets([item(at(9, 30), 4)], (entry) => entry.time, at(9, 30), at(9, 30), 24);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ input: 4, items: [0] });
  });
});
