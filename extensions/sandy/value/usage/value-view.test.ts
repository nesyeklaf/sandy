import { describe, expect, it } from "vitest";

import type { ValueSeriesView } from "./contract.js";
import { accountsOf, currentWindow, formatValueReport, hostShares, kindsOf, pick, providersOf, seriesOf, usd } from "./value-view.js";

const summary = { percent: 0, costUsd: 0, usdPerPercent: null, steps: 0, skipped: 0, hostCost: {} };
const entry = (providerId: string, kind: string): ValueSeriesView => ({ providerId, accountKey: null, kind, total: summary, windows: [], steps: [] });

describe("value view", () => {
  const series = [entry("claude-code", "five-hour"), entry("codex", "five-hour"), entry("codex", "weekly")];

  it("lists providers and their kinds, weekly first", () => {
    expect(providersOf(series)).toEqual(["claude-code", "codex"]);
    expect(kindsOf(series, "codex")).toEqual(["weekly", "five-hour"]);
  });

  it("falls back to the provider's first series when the kind is gone", () => {
    expect(pick(series, "claude-code", "weekly")?.kind).toBe("five-hour");
    expect(pick(series, "nobody", "weekly")).toBeNull();
  });

  it("lists every account with a value or a limit once", () => {
    const limits = [{ providerId: "codex", accountKey: null }, { providerId: "claude-code", accountKey: "a" }];
    expect(accountsOf(series, limits)).toEqual([
      { providerId: "claude-code", accountKey: null },
      { providerId: "codex", accountKey: null },
      { providerId: "claude-code", accountKey: "a" },
    ]);
  });

  it("takes one account's series, weekly first", () => {
    expect(seriesOf(series, { providerId: "codex", accountKey: null }).map((e) => e.kind)).toEqual(["weekly", "five-hour"]);
    expect(seriesOf(series, { providerId: "codex", accountKey: "x" })).toEqual([]);
  });

  it("finds the window that has not reset", () => {
    const windows = [{ resetsAt: 100, summary }, { resetsAt: 200, summary }];
    expect(currentWindow({ ...entry("codex", "weekly"), windows }, 150)?.resetsAt).toBe(200);
    expect(currentWindow({ ...entry("codex", "weekly"), windows }, 250)).toBeNull();
  });

  it("formats dollars", () => {
    expect(usd(12.4)).toBe("$12.40");
    expect(usd(0.05)).toBe("$0.050");
    expect(usd(1234.5)).toBe("$1,235");
  });

  it("prints the report for the terminal", () => {
    const withValue: ValueSeriesView = { ...entry("codex", "weekly"), total: { ...summary, percent: 4, costUsd: 10, usdPerPercent: 2.5, steps: 3, hostCost: { a: 10 } } };
    expect(formatValueReport({ series: [withValue], unpricedModels: [{ model: "x", turns: 2 }], invalidPrices: [] })).toBe(
      "codex Weekly: $2.50 per 1% · $10.00 over 4 points, 3 steps · a 100%\nNo price for x (2 turns); set it in the prices setting.",
    );
    expect(formatValueReport({ series: [], unpricedModels: [], invalidPrices: [] })).toMatch(/No limit readings/);
  });

  it("shares cost by host, biggest first", () => {
    expect(hostShares({ a: 1, "": 3 })).toEqual([
      { hostId: "unknown", costUsd: 3, share: 0.75 },
      { hostId: "a", costUsd: 1, share: 0.25 },
    ]);
    expect(hostShares({})).toEqual([]);
  });
});
