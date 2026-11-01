// A subscription's usage limits, as Provider usage reports them, and where
// each is headed at the pace of the recent readings. Pure: the server stores
// the readings and passes them in.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One reading of one limit window, as the server stored it. */
export interface LimitSample {
  providerId: string;
  /** The provider's id for the account, so two subscriptions stay apart; null when it reports none. */
  accountKey: string | null;
  label: string;
  /** "five-hour" or "weekly" today; other values pass through. */
  kind: string;
  /** Set on a window that counts only one model, such as a weekly limit for one model family. */
  model: string | null;
  sampledAt: number;
  usedPercent: number;
  resetsAt: number;
}

export type LimitTone = "ok" | "warning" | "error";

/** A limit window with where it is headed. */
export interface LimitView {
  providerId: string;
  accountKey: string | null;
  label: string;
  kind: string;
  usedPercent: number;
  resetsAt: number;
  sampledAt: number;
  /** Percent used per hour over the recent readings; null until there are enough of them. */
  pacePerHour: number | null;
  /** Where the window will be at its reset at that pace; null without a pace. */
  projectedPercent: number | null;
  /** When it reaches 100% at that pace, if that comes before the reset; its latest reading's time once it is already full. */
  runsOutAt: number | null;
  tone: LimitTone;
}

/** How far back each kind of window reads its pace, and the least span that counts as one. */
const PACE_SPAN: Record<string, { lookback: number; least: number }> = {
  // A session lasts five hours, so its last hour is what's coming next.
  "five-hour": { lookback: HOUR, least: 10 * MINUTE },
  // A week's pace from one busy hour says it runs out in a day, so it reads a day.
  weekly: { lookback: 24 * HOUR, least: HOUR },
};

/** The width of each of a session's slots in the title bar's spark chart. */
export const SLOT_MS = 15 * MINUTE;

/** Past this projected percent a limit is amber. */
export const WARNING_PERCENT = 80;

/** Readings of the same window share these. */
export function windowKey(sample: Pick<LimitSample, "providerId" | "accountKey" | "label">): string {
  return `${sample.providerId}\u0000${sample.accountKey ?? ""}\u0000${sample.label}`;
}

/**
 * Percent used per hour across `samples`, oldest first, over the lookback
 * before `now`. A reading whose reset time moved on started a new window, so
 * its whole percent counts as new use.
 */
export function pacePerHour(samples: readonly LimitSample[], now: number, kind: string): number | null {
  const span = PACE_SPAN[kind] ?? PACE_SPAN["weekly"]!;
  const from = now - span.lookback;
  const inside = samples.findIndex((sample) => sample.sampledAt >= from);
  if (inside === -1) return null;
  // The last reading before the lookback is the baseline for the first one
  // in it, unless polling stopped for long enough that it says little.
  const baseline = samples[inside - 1];
  const start = baseline !== undefined && baseline.sampledAt >= from - span.lookback ? inside - 1 : inside;
  const recent = samples.slice(start).filter((sample) => sample.sampledAt <= now);
  if (recent.length < 2) return null;
  const first = recent[0]!;
  const last = recent.at(-1)!;
  if (last.sampledAt - first.sampledAt < span.least) return null;
  let used = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const before = recent[index - 1]!;
    const after = recent[index]!;
    // Reset times wobble by a few milliseconds between readings.
    const reset = Math.abs(after.resetsAt - before.resetsAt) > MINUTE;
    used += reset ? after.usedPercent : Math.max(0, after.usedPercent - before.usedPercent);
  }
  return (used / (last.sampledAt - first.sampledAt)) * HOUR;
}

/** The window's latest reading with where it's headed. `samples` are this window's, oldest first. */
export function viewOf(samples: readonly LimitSample[], now: number): LimitView {
  const latest = samples.at(-1)!;
  const pace = pacePerHour(samples, now, latest.kind);
  const left = Math.max(0, latest.resetsAt - now);
  const projectedPercent = pace === null ? null : latest.usedPercent + (pace * left) / HOUR;
  let runsOutAt: number | null = null;
  if (latest.usedPercent >= 100) runsOutAt = latest.sampledAt;
  else if (pace !== null && pace > 0) {
    const at = now + ((100 - latest.usedPercent) / pace) * HOUR;
    if (at < latest.resetsAt) runsOutAt = at;
  }
  const tone: LimitTone =
    runsOutAt !== null ? "error" : (projectedPercent ?? latest.usedPercent) >= WARNING_PERCENT ? "warning" : "ok";
  return {
    providerId: latest.providerId,
    accountKey: latest.accountKey,
    label: latest.label,
    kind: latest.kind,
    usedPercent: latest.usedPercent,
    resetsAt: latest.resetsAt,
    sampledAt: latest.sampledAt,
    pacePerHour: pace,
    projectedPercent,
    runsOutAt,
    tone,
  };
}

/** How long each kind of window lasts, so its start is its reset less this. */
export const WINDOW_LENGTH: Record<string, number> = { "five-hour": 5 * HOUR, weekly: 7 * 24 * HOUR };

/**
 * Below this percent a window's estimate isn't shown: a point of rounding
 * moves it too much, and so does use sandy doesn't see early in a session.
 */
export const LEAST_SIZING_PERCENT: Record<string, number> = { "five-hour": 25, weekly: 10 };

/** How many past windows a size reads, newest first. */
const SIZING_WINDOWS = 10;

/**
 * About how many tokens the whole window holds. Each window read far enough
 * in (LEAST_SIZING_PERCENT) gives one estimate: the provider's tokens from
 * its start to its latest such reading, divided by the share used. The
 * typical one is the median of the past windows' estimates. The current
 * window's own estimate counts for as much of the result as the window is
 * used, 40% at 40% used, since early readings are rounded and swing with a
 * cache rewrite or a compaction. The limit isn't counted purely in tokens,
 * so this is an estimate either way.
 *
 * Null while no window has been read far enough in; undefined for a window
 * it can't size, one for a single model or of an unknown length, since
 * tokens aren't recorded per model. `samples` are one window key's, oldest
 * first.
 */
export function sizeOf(
  samples: readonly LimitSample[],
  tokensBetween: (from: number, to: number) => number,
): number | null | undefined {
  const latest = samples.at(-1);
  const length = latest === undefined ? undefined : WINDOW_LENGTH[latest.kind];
  if (latest === undefined || latest.model !== null || length === undefined) return undefined;
  const least = LEAST_SIZING_PERCENT[latest.kind]!;
  // Each window's latest reading far enough in, newest window first.
  const readings: Array<{ sample: LimitSample; current: boolean }> = [];
  let resetsAt: number | null = null;
  for (let index = samples.length - 1; index >= 0 && readings.length <= SIZING_WINDOWS; index -= 1) {
    const sample = samples[index]!;
    // Reset times wobble by a few milliseconds between readings.
    if (resetsAt !== null && Math.abs(sample.resetsAt - resetsAt) <= MINUTE) continue;
    if (sample.usedPercent < least || sample.usedPercent > 100) continue;
    resetsAt = sample.resetsAt;
    readings.push({ sample, current: Math.abs(sample.resetsAt - latest.resetsAt) <= MINUTE });
  }
  const estimate = ({ sample }: { sample: LimitSample }) => {
    const tokens = tokensBetween(sample.resetsAt - length, sample.sampledAt);
    return tokens > 0 ? tokens / (sample.usedPercent / 100) : null;
  };
  const current = readings[0]?.current ? estimate(readings[0]) : null;
  const past = readings
    .filter((reading) => !reading.current)
    .map(estimate)
    .filter((size): size is number => size !== null)
    .sort((a, b) => a - b);
  const typical = past.length === 0 ? null : (past[Math.floor((past.length - 1) / 2)]! + past[Math.ceil((past.length - 1) / 2)]!) / 2;
  if (current === null) return typical;
  if (typical === null) return current;
  const weight = Math.min(1, latest.usedPercent / 100);
  return weight * current + (1 - weight) * typical;
}

/**
 * One view per window in the latest reading of each account, session first.
 * A window for one model shows only once it has been used, since most
 * accounts never touch it. Readings older than `staleAfter` are dropped, so a
 * provider that stopped reporting disappears.
 */
export function limitViews(samples: readonly LimitSample[], now: number, staleAfter: number): LimitView[] {
  const byWindow = new Map<string, LimitSample[]>();
  for (const sample of [...samples].sort((a, b) => a.sampledAt - b.sampledAt)) {
    const key = windowKey(sample);
    byWindow.set(key, [...(byWindow.get(key) ?? []), sample]);
  }
  const views: LimitView[] = [];
  for (const windowSamples of byWindow.values()) {
    const latest = windowSamples.at(-1)!;
    if (now - latest.sampledAt > staleAfter) continue;
    if (latest.model !== null && latest.usedPercent === 0) continue;
    views.push(viewOf(windowSamples, now));
  }
  const order = (view: LimitView) => (view.kind === "five-hour" ? 0 : 1);
  return views.sort((a, b) => order(a) - order(b) || a.providerId.localeCompare(b.providerId));
}

/**
 * The readings in one response from sandy's usage limits, which maps each
 * provider to its status and windows. Providers that failed or report no
 * windows give none.
 */
export function samplesFromUsage(response: unknown, sampledAt: number): LimitSample[] {
  if (response === null || typeof response !== "object") return [];
  const samples: LimitSample[] = [];
  for (const [providerId, usage] of Object.entries(response as Record<string, unknown>)) {
    const entry = usage as { status?: unknown; accountKey?: unknown; windows?: unknown } | null;
    if (entry?.status !== "ok" || !Array.isArray(entry.windows)) continue;
    const accountKey = typeof entry.accountKey === "string" ? entry.accountKey : null;
    for (const window of entry.windows as Array<Record<string, unknown>>) {
      const resetsAt = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
      if (typeof window.label !== "string" || typeof window.usedPercent !== "number" || Number.isNaN(resetsAt)) continue;
      samples.push({
        providerId,
        accountKey,
        label: window.label,
        kind: typeof window.kind === "string" ? window.kind : "weekly",
        model: typeof window.model === "string" ? window.model : null,
        sampledAt,
        usedPercent: window.usedPercent,
        resetsAt,
      });
    }
  }
  return samples;
}
