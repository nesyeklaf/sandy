// What 1% of a subscription limit is worth in list-price dollars: the cost of
// the turns sandy saw between two readings of a limit, divided by how far the
// reading moved. Pure: the server passes in the stored readings and turns.
//
// A reading is a whole percent (or close to it), so one step is noisy. Steps
// are kept raw and the headline adds them up over a period, where the
// rounding at each end cancels: the sum of the steps' costs over the sum of
// their percent points.

import { windowKey, type LimitSample } from "./limits.js";
import { costOf, priceOf, type PriceTable } from "./pricing.js";

const MINUTE = 60_000;

/** Reset times wobble by a few milliseconds between readings; a bigger move is a new window. */
const SAME_WINDOW_MS = MINUTE;

/**
 * Longest silence between two readings a step may span at either end. The
 * poll runs every five minutes; a longer gap leaves the moment the percent
 * ticked up too uncertain to credit turns to it.
 */
export const MAX_GAP_MS = 20 * MINUTE;

/** A period's value shows only from this many percent points of movement; below it one rounding step swings the result. */
export const LEAST_PERCENT_POINTS = 3;

/** Which quota provider a model draws on, by the start of its id; the first rule that matches wins. */
export interface AccountRule {
  prefix: string;
  providerId: string;
}

export const DEFAULT_ACCOUNT_RULES: readonly AccountRule[] = [
  { prefix: "gpt-", providerId: "codex" },
  { prefix: "claude-", providerId: "claude-code" },
];

/** Parses the `accountRules` setting: `prefix=providerId` separated by commas or lines; rules before the defaults. */
export function parseAccountRules(text: string): AccountRule[] {
  const rules: AccountRule[] = [];
  for (const part of text.split(/[,\n]/)) {
    const [prefix, providerId] = part.split("=").map((piece) => piece.trim());
    if (prefix !== undefined && prefix !== "" && providerId !== undefined && providerId !== "") rules.push({ prefix, providerId });
  }
  return rules;
}

/** The quota provider a model's turns count against; null when no rule matches. */
export function quotaProviderOf(model: string | null, rules: readonly AccountRule[] = DEFAULT_ACCOUNT_RULES): string | null {
  if (model === null) return null;
  const id = model.trim().toLowerCase();
  const name = id.slice(id.lastIndexOf("/") + 1);
  return rules.find((rule) => name.startsWith(rule.prefix.toLowerCase()))?.providerId ?? null;
}

/** One turn's list-price cost, with where and on what it ran. */
export interface PricedTurn {
  at: number;
  hostId: string | null;
  model: string | null;
  /** The quota provider it counts against; null when its model maps to none. */
  providerId: string | null;
  /** Dollars at list price; null when its model has no price. */
  cost: number | null;
  tokens: number;
}

/** Prices recorded turns at list price and assigns each to the quota provider its model draws on. */
export function pricedTurns(
  rows: ReadonlyArray<{ at: number; hostId: string | null; model: string | null; input: number; cacheRead: number; output: number; costUsd?: number | null }>,
  prices: PriceTable,
  rules: readonly AccountRule[],
): PricedTurn[] {
  return rows.map((row) => {
    const rate = priceOf(row.model, prices);
    return {
      at: row.at,
      hostId: row.hostId,
      model: row.model,
      providerId: quotaProviderOf(row.model, rules),
      cost: row.costUsd ?? (rate === null ? null : costOf(row, rate)),
      tokens: row.input + row.cacheRead + row.output,
    };
  });
}

/** The movement of one limit window from one reading to a later, higher one, and what sandy saw spent meanwhile. */
export interface ValueStep {
  providerId: string;
  accountKey: string | null;
  kind: string;
  /** The window's reset time, which identifies the window. */
  resetsAt: number;
  from: number;
  to: number;
  fromPercent: number;
  toPercent: number;
  percent: number;
  costUsd: number;
  tokens: number;
  turns: number;
  /** Turns in the step that sandy could not price or attribute; a step with any is left out of the totals. */
  unpricedTurns: number;
  /** Cost by host id, "" for a turn without one. */
  hostCost: Record<string, number>;
}

/** The steps of one limit window, from its readings, oldest first. */
export function valueSteps(samples: readonly LimitSample[], turns: readonly PricedTurn[]): ValueStep[] {
  const steps: ValueStep[] = [];
  let anchor: { sample: LimitSample; gapBefore: number } | null = null;
  let previous: LimitSample | null = null;
  for (const sample of samples) {
    const fresh: boolean =
      anchor === null ||
      Math.abs(sample.resetsAt - anchor.sample.resetsAt) > SAME_WINDOW_MS ||
      sample.usedPercent < anchor.sample.usedPercent;
    if (fresh || anchor === null || previous === null) {
      // A new window, or a reading that went down: only a baseline, no step.
      anchor = { sample, gapBefore: Number.POSITIVE_INFINITY };
      previous = sample;
      continue;
    }
    const gap = sample.sampledAt - previous.sampledAt;
    if (sample.usedPercent > anchor.sample.usedPercent) {
      // The first reading of a window is a baseline, not an uncertain tick.
      const startKnown = anchor.gapBefore === Number.POSITIVE_INFINITY || anchor.gapBefore <= MAX_GAP_MS;
      if (gap <= MAX_GAP_MS && startKnown) steps.push(stepOf(anchor.sample, sample, turns));
      anchor = { sample, gapBefore: gap };
    }
    previous = sample;
  }
  return steps;
}

function stepOf(start: LimitSample, end: LimitSample, turns: readonly PricedTurn[]): ValueStep {
  const step: ValueStep = {
    providerId: end.providerId,
    accountKey: end.accountKey,
    kind: end.kind,
    resetsAt: end.resetsAt,
    from: start.sampledAt,
    to: end.sampledAt,
    fromPercent: start.usedPercent,
    toPercent: end.usedPercent,
    percent: end.usedPercent - start.usedPercent,
    costUsd: 0,
    tokens: 0,
    turns: 0,
    unpricedTurns: 0,
    hostCost: {},
  };
  for (const turn of turns) {
    if (turn.at <= start.sampledAt || turn.at > end.sampledAt) continue;
    // A turn of another provider draws on another limit; one with no provider could be either.
    if (turn.providerId !== null && turn.providerId !== end.providerId) continue;
    step.turns += 1;
    step.tokens += turn.tokens;
    if (turn.providerId === null || turn.cost === null) {
      step.unpricedTurns += 1;
      continue;
    }
    step.costUsd += turn.cost;
    const host = turn.hostId ?? "";
    step.hostCost[host] = (step.hostCost[host] ?? 0) + turn.cost;
  }
  return step;
}

/** One account's steps and what they add up to, for one kind of window. */
export interface ValueSummary {
  providerId: string;
  accountKey: string | null;
  kind: string;
  /** Percent points moved by the steps that count. */
  percent: number;
  costUsd: number;
  /** Dollars per percent point; null below LEAST_PERCENT_POINTS or without cost. */
  usdPerPercent: number | null;
  /** Steps that count, and steps left out for unpriced turns. */
  steps: number;
  skipped: number;
  hostCost: Record<string, number>;
}

/** Adds up steps of one account and kind. Steps with unpriced turns or no cost are left out, never counted as free. */
export function summarize(steps: readonly ValueStep[]): ValueSummary | null {
  const first = steps[0];
  if (first === undefined) return null;
  const summary: ValueSummary = {
    providerId: first.providerId,
    accountKey: first.accountKey,
    kind: first.kind,
    percent: 0,
    costUsd: 0,
    usdPerPercent: null,
    steps: 0,
    skipped: 0,
    hostCost: {},
  };
  for (const step of steps) {
    if (step.unpricedTurns > 0 || step.costUsd <= 0) {
      summary.skipped += 1;
      continue;
    }
    summary.steps += 1;
    summary.percent += step.percent;
    summary.costUsd += step.costUsd;
    for (const [host, cost] of Object.entries(step.hostCost)) summary.hostCost[host] = (summary.hostCost[host] ?? 0) + cost;
  }
  if (summary.percent >= LEAST_PERCENT_POINTS) summary.usdPerPercent = summary.costUsd / summary.percent;
  return summary;
}

/** A period of one account and kind, for the page: the headline over the range and one value per window. */
export interface ValueSeries {
  providerId: string;
  accountKey: string | null;
  kind: string;
  total: ValueSummary | null;
  /** One summary per limit window, oldest first, keyed by its reset time. */
  windows: Array<{ resetsAt: number; summary: ValueSummary }>;
  steps: ValueStep[];
}

/**
 * Every account's value for each kind of window. Windows that count one model
 * only are left out: their percent follows that model's use, not the cost of
 * all turns. `samples` need not be sorted.
 */
export function valueSeries(samples: readonly LimitSample[], turns: readonly PricedTurn[]): ValueSeries[] {
  const byWindow = new Map<string, LimitSample[]>();
  for (const sample of [...samples].sort((a, b) => a.sampledAt - b.sampledAt)) {
    if (sample.model !== null) continue;
    const key = windowKey(sample);
    byWindow.set(key, [...(byWindow.get(key) ?? []), sample]);
  }
  const bySeries = new Map<string, ValueStep[]>();
  for (const windowSamples of byWindow.values()) {
    const latest = windowSamples.at(-1)!;
    const key = `${latest.providerId}\u0000${latest.accountKey ?? ""}\u0000${latest.kind}`;
    bySeries.set(key, [...(bySeries.get(key) ?? []), ...valueSteps(windowSamples, turns)]);
  }
  const result: ValueSeries[] = [];
  for (const steps of bySeries.values()) {
    steps.sort((a, b) => a.to - b.to);
    const total = summarize(steps);
    if (total === null) continue;
    const perWindow = new Map<number, ValueStep[]>();
    for (const step of steps) {
      const known = [...perWindow.keys()].find((resetsAt) => Math.abs(resetsAt - step.resetsAt) <= SAME_WINDOW_MS);
      const key = known ?? step.resetsAt;
      perWindow.set(key, [...(perWindow.get(key) ?? []), step]);
    }
    result.push({
      providerId: total.providerId,
      accountKey: total.accountKey,
      kind: total.kind,
      total,
      windows: [...perWindow.entries()].map(([resetsAt, windowSteps]) => ({ resetsAt, summary: summarize(windowSteps)! })),
      steps,
    });
  }
  return result.sort((a, b) => a.providerId.localeCompare(b.providerId) || (a.kind === "weekly" ? -1 : 1));
}
