import { describe, expect, it } from "vitest";

import type { ThreadUsage } from "@/usage/contract";

import { pastDayTokens } from "./thread-token-count";
import { splitArchived, threadBars, threadContextLevel } from "./thread-usage-list";
import { logPosition, nearestDot, turnStats } from "./turn-dots";

const HOUR = 3_600_000;

function thread(
  threadId: string,
  archivedAt: number | null,
  hours: ThreadUsage["hours"] = [],
  context: number | null = null,
): ThreadUsage {
  return { threadId, title: null, projectId: "prj_acme", projectName: "widgets", providerId: "claude-code", archivedAt, turns: 1, context, hours, input: 0, cacheRead: 0, output: 0 };
}

describe("splitArchived", () => {
  it("lists active threads, then archived ones however long ago, each with the most tokens first", () => {
    const threads = [
      { ...thread("thr_recent", 8 * HOUR), cacheRead: 5 },
      { ...thread("thr_active", null), cacheRead: 1 },
      { ...thread("thr_older", 1 * HOUR), cacheRead: 9 },
      { ...thread("thr_second", null), cacheRead: 3 },
    ];
    const { active, archived } = splitArchived(threads);
    expect(active.map((t) => t.threadId)).toEqual(["thr_second", "thr_active"]);
    expect(archived.map((t) => t.threadId)).toEqual(["thr_older", "thr_recent"]);
  });
});

describe("threadBars", () => {
  it("adds each hour to the page bar it falls in", () => {
    const bars = [0, 1, 2].map((index) => ({ start: index * 2 * HOUR, end: (index + 1) * 2 * HOUR, input: 0, cacheRead: 0, output: 0 }));
    const totals = threadBars(
      thread("thr_active", null, [
        { hour: 0, total: 5 },
        { hour: HOUR, total: 3 },
        { hour: 4 * HOUR, total: 7 },
        { hour: 9 * HOUR, total: 100 },
      ]),
      bars,
    );
    expect(totals).toEqual([8, 0, 7]);
  });
});

describe("threadContextLevel", () => {
  const thresholds = { warning: 300_000, error: 550_000 };

  it("rates an active thread's latest context against both settings", () => {
    expect(threadContextLevel(thread("thr_small", null, [], 180_000), thresholds)).toBeNull();
    expect(threadContextLevel(thread("thr_edge", null, [], 300_000), thresholds)).toBe("warning");
    expect(threadContextLevel(thread("thr_big", null, [], 510_000), thresholds)).toBe("warning");
    expect(threadContextLevel(thread("thr_huge", null, [], 629_000), thresholds)).toBe("error");
  });

  it("leaves out archived threads and threads with no recorded context", () => {
    expect(threadContextLevel(thread("thr_archived", 1, [], 629_000), thresholds)).toBeNull();
    expect(threadContextLevel(thread("thr_unknown", null, [], null), thresholds)).toBeNull();
  });

  it("skips a level whose setting is off", () => {
    expect(threadContextLevel(thread("thr_big", null, [], 510_000), { warning: null, error: 550_000 })).toBeNull();
    expect(threadContextLevel(thread("thr_huge", null, [], 629_000), { warning: 300_000, error: null })).toBe("warning");
  });
});

describe("turn dots", () => {
  it("puts ten seconds at the left, an hour at the right, and clamps past either", () => {
    expect(logPosition(10_000, 240)).toBe(0);
    expect(logPosition(3_600_000, 240)).toBeCloseTo(240);
    expect(logPosition(2_000, 240)).toBe(0);
    expect(logPosition(11 * 3_600_000, 240)).toBeCloseTo(240);
    // A minute is well left of the middle on a log scale from 10s to 1h.
    expect(logPosition(60_000, 240)).toBeCloseTo(73, 0);
  });

  it("summarizes a thread's turns with the median, the longest, and the total", () => {
    expect(turnStats([60_000, 30_000, 2_340_000, 240_000])).toEqual({ median: 150_000, longest: 2_340_000, total: 2_670_000 });
    expect(turnStats([])).toBeNull();
  });
});

describe("nearestDot", () => {
  it("picks the closest dot within reach, or none", () => {
    expect(nearestDot([10, 40, 44], 43)).toBe(2);
    expect(nearestDot([10, 40, 44], 39)).toBe(1);
    expect(nearestDot([10, 40], 25)).toBeNull();
  });
});

describe("pastDayTokens", () => {
  it("adds up the rows from the 24 hours before now", () => {
    const now = 10 * 24 * HOUR;
    const row = (at: number, cacheRead: number) => ({ at, input: 0, cacheRead, output: 0 });
    expect(pastDayTokens([row(now - 25 * HOUR, 5), row(now - 23 * HOUR, 7), row(now - HOUR, 11)], now)).toBe(18);
  });
});
