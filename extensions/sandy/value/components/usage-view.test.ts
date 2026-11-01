import { describe, expect, it } from "vitest";

import type { Limit } from "@/usage/contract";
import { ZERO_TOKENS } from "@/usage/breakdown";
import type { Bar } from "@/usage/series";

import { projectedTokens } from "./usage-chart";
import { withProjection } from "./usage-view";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 19, 13);
const NOW = START + 23 * HOUR + 20 * 60_000;

const bars: Bar[] = Array.from({ length: 24 }, (_, index) => ({
  start: START + index * HOUR,
  end: START + (index + 1) * HOUR,
  ...ZERO_TOKENS,
}));

function session(over: Partial<Limit> = {}): Limit {
  return {
    providerId: "claude-code",
    accountKey: "acct_acme",
    label: "Current session",
    kind: "five-hour",
    usedPercent: 28,
    resetsAt: NOW + 3.5 * HOUR,
    sampledAt: NOW,
    pacePerHour: 19,
    projectedPercent: 94.5,
    runsOutAt: null,
    tone: "warning",
    lastHourTokens: 45_000_000,
    ...over,
  };
}

describe("withProjection", () => {
  it("runs the past day on to the reset and keeps 24 bars", () => {
    const { bars: drawn, projection } = withProjection(bars, "hour", [session()], NOW);
    expect(drawn).toHaveLength(24);
    // The reset is 3h 30m away, in the fourth hour after the current one.
    expect(drawn.at(-1)!.end).toBe(bars.at(-1)!.end + 3 * HOUR);
    expect(drawn[0]!.start).toBe(bars[3]!.start);
    expect(projection).toEqual({ from: NOW, until: NOW + 3.5 * HOUR, tokensPerHour: 45_000_000, runsOutAt: null });
  });

  it("leaves a calm session's chart alone", () => {
    const calm = session({ tone: "ok", projectedPercent: 31 });
    expect(withProjection(bars, "hour", [calm], NOW)).toEqual({ bars, projection: null });
  });

  it("leaves the week's day bars alone", () => {
    expect(withProjection(bars, "day", [session()], NOW).projection).toBeNull();
  });

  it("needs a pace and some tokens in the past hour", () => {
    expect(withProjection(bars, "hour", [session({ pacePerHour: null })], NOW).projection).toBeNull();
    expect(withProjection(bars, "hour", [session({ lastHourTokens: 0 })], NOW).projection).toBeNull();
  });
});

describe("projectedTokens", () => {
  const projection = { from: NOW, until: NOW + 3.5 * HOUR, tokensPerHour: 60_000_000, runsOutAt: null };

  it("adds the rest of the current hour, whole hours, then the part before the reset", () => {
    const current = bars.at(-1)!;
    expect(projectedTokens(current, projection)).toBeCloseTo(40_000_000);
    const next = { ...current, start: current.end, end: current.end + HOUR };
    expect(projectedTokens(next, projection)).toBeCloseTo(60_000_000);
    const last = { ...current, start: current.end + 2 * HOUR, end: current.end + 3 * HOUR };
    expect(projectedTokens(last, projection)).toBeCloseTo(50_000_000);
  });

  it("adds nothing to past hours", () => {
    expect(projectedTokens(bars[0]!, projection)).toBe(0);
  });
});
