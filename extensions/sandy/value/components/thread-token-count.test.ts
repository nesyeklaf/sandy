import { describe, expect, it } from "vitest";

import { bucketSpan } from "./thread-token-count";

const bucket = (minutes: number) => ({ start: 0, end: minutes * 60_000, input: 0, cacheRead: 0, output: 0, items: [] });

describe("bucketSpan", () => {
  it("names the span one bar covers", () => {
    expect([1, 15, 60, 180, 1_440].map((minutes) => bucketSpan(bucket(minutes)))).toEqual([
      "minute",
      "15 minutes",
      "hour",
      "3 hours",
      "day",
    ]);
  });
});
