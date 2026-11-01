import { describe, expect, it } from "vitest";

import type { LimitSample } from "./limits.js";
import { DEFAULT_PRICES } from "./pricing.js";
import { DEFAULT_ACCOUNT_RULES, LEAST_PERCENT_POINTS, parseAccountRules, pricedTurns, quotaProviderOf, summarize, valueSeries, valueSteps, type PricedTurn } from "./value.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 24, 10);
const RESET = T0 + 5 * 24 * 3_600_000;

function sample(minute: number, usedPercent: number, extra: Partial<LimitSample> = {}): LimitSample {
  return {
    providerId: "codex",
    accountKey: "acct_1",
    label: "Weekly",
    kind: "weekly",
    model: null,
    sampledAt: T0 + minute * MIN,
    usedPercent,
    resetsAt: RESET,
    ...extra,
  };
}

function turn(minute: number, cost: number | null, extra: Partial<PricedTurn> = {}): PricedTurn {
  return { at: T0 + minute * MIN, hostId: "host_a", model: "gpt-5.6-sol", providerId: "codex", cost, tokens: 1000, ...extra };
}

describe("quotaProviderOf", () => {
  it("maps model families to the provider whose limit they use", () => {
    expect(quotaProviderOf("gpt-5.6-sol")).toBe("codex");
    expect(quotaProviderOf("openai-codex/gpt-6-astra")).toBe("codex");
    expect(quotaProviderOf("claude-opus-5-5")).toBe("claude-code");
    expect(quotaProviderOf("mystery")).toBeNull();
    expect(quotaProviderOf(null)).toBeNull();
  });
});

describe("pricedTurns", () => {
  it("prices known models, leaves unknown ones unpriced and unmapped ones unattributed", () => {
    const row = { at: 1, hostId: "h", input: 100_000, cacheRead: 0, output: 0 };
    const [known, unknown, none] = pricedTurns(
      [{ ...row, model: "gpt-5.6-sol" }, { ...row, model: "gpt-9" }, { ...row, model: null }],
      DEFAULT_PRICES,
      DEFAULT_ACCOUNT_RULES,
    );
    expect(known).toMatchObject({ providerId: "codex", cost: 0.4, tokens: 100_000 });
    expect(unknown).toMatchObject({ providerId: "codex", cost: null });
    expect(none).toMatchObject({ providerId: null, cost: null });
  });

  it("takes the cost the provider gave over the price table's", () => {
    const [turn] = pricedTurns(
      [{ at: 1, hostId: "h", model: "gpt-5.6-sol", input: 100_000, cacheRead: 0, output: 0, costUsd: 1.5 }],
      DEFAULT_PRICES,
      DEFAULT_ACCOUNT_RULES,
    );
    expect(turn?.cost).toBe(1.5);
  });
});

describe("parseAccountRules", () => {
  it("reads prefix=provider pairs, which win over the defaults when listed first", () => {
    const rules = parseAccountRules("gpt-5.6-luna=cheap, claude-=claude-code\nbad");
    expect(rules).toEqual([{ prefix: "gpt-5.6-luna", providerId: "cheap" }, { prefix: "claude-", providerId: "claude-code" }]);
    expect(quotaProviderOf("gpt-5.6-luna", [...rules])).toBe("cheap");
  });
});

describe("valueSteps", () => {
  it("prices the turns between two readings and divides by the percent moved", () => {
    const steps = valueSteps(
      [sample(0, 10), sample(5, 10), sample(10, 12)],
      [turn(2, 3), turn(7, 5), turn(20, 99)],
    );
    expect(steps).toHaveLength(1);
    // The step runs from the first reading showing 10% to the first showing 12%.
    expect(steps[0]).toMatchObject({ percent: 2, costUsd: 8, fromPercent: 10, toPercent: 12, turns: 2 });
  });

  it("starts nothing at a reset and does not turn it into a negative step", () => {
    const steps = valueSteps(
      [sample(0, 90), sample(5, 95), sample(10, 2, { resetsAt: RESET + 7 * 24 * 3_600_000 }), sample(15, 3, { resetsAt: RESET + 7 * 24 * 3_600_000 })],
      [turn(3, 10), turn(12, 4)],
    );
    expect(steps.map((step) => [step.fromPercent, step.toPercent, step.costUsd])).toEqual([
      [90, 95, 10],
      [2, 3, 4],
    ]);
  });

  it("ignores a few milliseconds of wobble in the reset time", () => {
    const steps = valueSteps([sample(0, 10), sample(5, 11, { resetsAt: RESET + 4 })], [turn(3, 2)]);
    expect(steps).toHaveLength(1);
  });

  it("treats a reading that goes down in the same window as a new baseline", () => {
    const steps = valueSteps([sample(0, 40), sample(5, 30), sample(10, 31)], [turn(8, 6)]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ fromPercent: 30, toPercent: 31, costUsd: 6 });
  });

  it("drops a step whose end follows a long silence", () => {
    const steps = valueSteps([sample(0, 10), sample(5, 10), sample(120, 14)], [turn(60, 20)]);
    expect(steps).toEqual([]);
  });

  it("drops a step whose start came after a long silence, but not a window's first reading", () => {
    const steps = valueSteps(
      [sample(0, 10), sample(120, 11), sample(125, 11), sample(130, 12)],
      [turn(126, 1)],
    );
    // 10→11 spans the silence; 11→12 starts at a reading that followed it.
    expect(steps).toEqual([]);
    const later = valueSteps([sample(0, 10), sample(120, 11), sample(125, 11), sample(130, 11), sample(135, 12)], [turn(131, 1)]);
    expect(later).toEqual([]);
  });

  it("counts a turn without a price as unpriced, and a turn of another provider not at all", () => {
    const [step] = valueSteps(
      [sample(0, 10), sample(5, 11)],
      [turn(1, null), turn(2, 4), turn(3, 50, { providerId: "claude-code", model: "claude-opus-5" }), turn(4, 1, { providerId: null, model: null })],
    );
    expect(step).toMatchObject({ costUsd: 4, turns: 3, unpricedTurns: 2 });
    expect(step!.hostCost).toEqual({ host_a: 4 });
  });
});

describe("summarize and valueSeries", () => {
  it("adds steps up so rounding at the ends cancels", () => {
    // True use 4.0 points; readings 10 -> 11 -> 13 -> 14 though each tick came a bit early or late.
    const samples = [sample(0, 10), sample(5, 11), sample(10, 11), sample(15, 13), sample(20, 14)];
    const turns = [turn(3, 2), turn(8, 3), turn(12, 3), turn(18, 2)];
    const [series] = valueSeries(samples, turns);
    expect(series!.total).toMatchObject({ percent: 4, costUsd: 10, usdPerPercent: 2.5 });
  });

  it("shows no value below the least movement, and never counts unpriced steps as free", () => {
    const samples = [sample(0, 10), sample(5, 11), sample(10, 12)];
    const [series] = valueSeries(samples, [turn(3, 2), turn(8, null)]);
    expect(series!.total!.percent).toBeLessThan(LEAST_PERCENT_POINTS);
    expect(series!.total!.usdPerPercent).toBeNull();
    expect(series!.total).toMatchObject({ steps: 1, skipped: 1 });
  });

  it("keeps accounts, kinds and windows apart and skips single-model windows", () => {
    const week2 = RESET + 7 * 24 * 3_600_000;
    const samples = [
      sample(0, 10),
      sample(5, 20),
      sample(10, 5, { resetsAt: week2 }),
      sample(15, 9, { resetsAt: week2 }),
      sample(0, 1, { providerId: "claude-code", accountKey: "acct_2", kind: "five-hour", label: "Session" }),
      sample(5, 3, { providerId: "claude-code", accountKey: "acct_2", kind: "five-hour", label: "Session" }),
      sample(0, 1, { model: "gpt-5.6-sol", label: "Sol weekly" }),
      sample(5, 9, { model: "gpt-5.6-sol", label: "Sol weekly" }),
    ];
    const turns = [turn(3, 20), turn(12, 8), turn(2, 6, { providerId: "claude-code", model: "claude-opus-5" })];
    const series = valueSeries(samples, turns);
    expect(series.map((entry) => [entry.providerId, entry.kind])).toEqual([
      ["claude-code", "five-hour"],
      ["codex", "weekly"],
    ]);
    const codex = series[1]!;
    expect(codex.windows.map((window) => window.summary.costUsd)).toEqual([20, 8]);
    expect(codex.total).toMatchObject({ percent: 14, costUsd: 28, usdPerPercent: 2 });
    expect(series[0]!.total).toMatchObject({ percent: 2, costUsd: 6, usdPerPercent: null });
  });

  it("summarizes nothing without steps", () => {
    expect(summarize([])).toBeNull();
  });
});
