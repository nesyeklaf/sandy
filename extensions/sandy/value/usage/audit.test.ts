import { describe, expect, it } from "vitest";

import { audit } from "./audit.js";
import { DEFAULT_PRICES } from "./pricing.js";
import type { LimitSample } from "./limits.js";
import { DEFAULT_ACCOUNT_RULES } from "./value.js";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20);

const turn = (at: number, over = {}) => ({ at, hostId: "h1", model: "gpt-6.1-sol", input: 10, cacheRead: 0, output: 5, ...over });
const reading = (min: number, usedPercent: number): LimitSample => ({
  providerId: "codex",
  accountKey: "a",
  label: "Weekly limit",
  kind: "weekly",
  model: null,
  sampledAt: T0 + min * MIN,
  usedPercent,
  resetsAt: T0 + 7 * DAY,
});

describe("audit", () => {
  it("counts turns without model, host or price, and those since recording separately", () => {
    const found = audit(
      [turn(T0), turn(T0 + 1, { model: null }), turn(T0 + DAY, { hostId: null }), turn(T0 + DAY + 1, { model: "bogus/x" })],
      [],
      DEFAULT_PRICES,
      DEFAULT_ACCOUNT_RULES,
      T0 + DAY,
    );
    expect(found.turns).toEqual({ total: 4, noModel: 1, noHost: 1, unpriced: 2, unmapped: 1 });
    expect(found.sinceRecording).toEqual({ total: 2, noModel: 0, noHost: 1, unpriced: 1, unmapped: 1 });
    expect(found.hosts).toEqual({ h1: 3, "": 1 });
    expect(found.days.map((day) => [day.day, day.turns])).toEqual([["2026-10-20", 2], ["2026-10-21", 2]]);
    expect(found.models.find((model) => model.model === "gpt-6.1-sol")).toMatchObject({ priced: true, providerId: "codex" });
  });

  it("finds holes between readings and counts the percent moves", () => {
    const found = audit([], [reading(0, 1), reading(5, 1), reading(10, 2), reading(60, 2), reading(65, 3)], DEFAULT_PRICES, DEFAULT_ACCOUNT_RULES, T0);
    expect(found.windows).toEqual([expect.objectContaining({ readings: 5, gaps: 1, longestGapMs: 50 * MIN, moves: 2 })]);
  });
});
