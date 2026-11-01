// Where the recorded data has holes: turns without model or host, turns that
// cannot be priced or assigned to a quota account, and limit readings that
// stopped coming. Pure: rows in, counts out.
import { priceOf, type PriceTable } from "./pricing.js";
import type { LimitSample } from "./limits.js";
import type { TurnRow } from "./store.js";
import { quotaProviderOf, type AccountRule } from "./value.js";

/** Readings come every 5 minutes; a longer silence than this is a hole. */
export const READING_GAP_MS = 15 * 60_000;

export interface DayAudit {
  day: string;
  turns: number;
  tokens: number;
  noModel: number;
  noHost: number;
  unpriced: number;
}

export interface WindowAudit {
  providerId: string;
  accountKey: string | null;
  label: string;
  kind: string;
  readings: number;
  first: number;
  last: number;
  /** Holes longer than READING_GAP_MS, and the longest one. */
  gaps: number;
  longestGapMs: number;
  /** Readings whose percent differed from the one before in the same window. */
  moves: number;
}

export interface Audit {
  turns: { total: number; noModel: number; noHost: number; unpriced: number; unmapped: number };
  /** Same counts, only for turns since model and host were recorded. */
  sinceRecording: { total: number; noModel: number; noHost: number; unpriced: number; unmapped: number };
  models: Array<{ model: string; turns: number; priced: boolean; providerId: string | null }>;
  /** Turns by host id, "" for turns without one. */
  hosts: Record<string, number>;
  days: DayAudit[];
  windows: WindowAudit[];
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function counts() {
  return { total: 0, noModel: 0, noHost: 0, unpriced: 0, unmapped: 0 };
}

export function audit(
  turns: readonly TurnRow[],
  samples: readonly LimitSample[],
  prices: PriceTable,
  rules: readonly AccountRule[],
  recordingSince: number,
): Audit {
  const all = counts();
  const recent = counts();
  const models = new Map<string, number>();
  const days = new Map<string, DayAudit>();
  const hosts: Record<string, number> = {};
  for (const turn of turns) {
    const noModel = turn.model === null;
    const noHost = turn.hostId === null || turn.hostId === "";
    const unpriced = noModel || priceOf(turn.model, prices) === null;
    const unmapped = !noModel && quotaProviderOf(turn.model, rules) === null;
    for (const bucket of turn.at >= recordingSince ? [all, recent] : [all]) {
      bucket.total += 1;
      if (noModel) bucket.noModel += 1;
      if (noHost) bucket.noHost += 1;
      if (unpriced) bucket.unpriced += 1;
      if (unmapped) bucket.unmapped += 1;
    }
    hosts[turn.hostId ?? ""] = (hosts[turn.hostId ?? ""] ?? 0) + 1;
    if (turn.model !== null) models.set(turn.model, (models.get(turn.model) ?? 0) + 1);
    const day = dayOf(turn.at);
    const entry = days.get(day) ?? { day, turns: 0, tokens: 0, noModel: 0, noHost: 0, unpriced: 0 };
    entry.turns += 1;
    entry.tokens += turn.input + turn.cacheRead + turn.output;
    if (noModel) entry.noModel += 1;
    if (noHost) entry.noHost += 1;
    if (unpriced) entry.unpriced += 1;
    days.set(day, entry);
  }

  const byWindow = new Map<string, LimitSample[]>();
  for (const sample of samples) {
    const key = [sample.providerId, sample.accountKey ?? "", sample.label, sample.model ?? ""].join("\u0000");
    const list = byWindow.get(key) ?? [];
    list.push(sample);
    byWindow.set(key, list);
  }
  const windows: WindowAudit[] = [];
  for (const list of byWindow.values()) {
    list.sort((a, b) => a.sampledAt - b.sampledAt);
    let gaps = 0;
    let longest = 0;
    let moves = 0;
    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i]!.sampledAt - list[i - 1]!.sampledAt;
      if (gap > READING_GAP_MS) gaps += 1;
      longest = Math.max(longest, gap);
      if (list[i]!.usedPercent !== list[i - 1]!.usedPercent) moves += 1;
    }
    const head = list[0]!;
    windows.push({
      providerId: head.providerId,
      accountKey: head.accountKey,
      label: head.label,
      kind: head.kind,
      readings: list.length,
      first: head.sampledAt,
      last: list.at(-1)!.sampledAt,
      gaps,
      longestGapMs: longest,
      moves,
    });
  }

  return {
    turns: all,
    sinceRecording: recent,
    models: [...models]
      .map(([model, count]) => ({ model, turns: count, priced: priceOf(model, prices) !== null, providerId: quotaProviderOf(model, rules) }))
      .sort((a, b) => b.turns - a.turns),
    hosts,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    windows: windows.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.label.localeCompare(b.label)),
  };
}
