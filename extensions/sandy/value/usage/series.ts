// The page's time ranges and bars, in the viewer's time zone. The server sums
// usage by hour; this groups those hours into the bars a range draws.
import { addTokens, ZERO_TOKENS, type Tokens } from "./breakdown.js";

export type RangeId = "day" | "three-days" | "week";

export interface Range {
  id: RangeId;
  label: string;
}

export const RANGES: readonly Range[] = [
  { id: "day", label: "Past day" },
  { id: "three-days", label: "Past 3 days" },
  { id: "week", label: "Past week" },
];

export interface Bar extends Tokens {
  start: number;
  end: number;
}

export interface Window {
  since: number;
  /** Empty bars, oldest first; fill them with `fillBars`. */
  bars: Bar[];
  /** Whether each bar is an hour or a day. */
  unit: "hour" | "day";
}

function hourBars(now: Date, count: number): Bar[] {
  const current = new Date(now);
  current.setMinutes(0, 0, 0);
  const bars: Bar[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = new Date(current);
    start.setHours(current.getHours() - back);
    const end = new Date(start);
    end.setHours(start.getHours() + 1);
    bars.push({ start: start.getTime(), end: end.getTime(), ...ZERO_TOKENS });
  }
  return bars;
}

function dayBars(now: Date, count: number): Bar[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const bars: Bar[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = new Date(today);
    start.setDate(today.getDate() - back);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    bars.push({ start: start.getTime(), end: end.getTime(), ...ZERO_TOKENS });
  }
  return bars;
}

/** The bars for a range ending now: 24 or 72 hours, or 7 days counting today. */
export function windowFor(range: RangeId, now: Date): Window {
  const bars = range === "week" ? dayBars(now, 7) : hourBars(now, range === "day" ? 24 : 72);
  return { since: bars[0]!.start, bars, unit: range === "week" ? "day" : "hour" };
}

/** Adds each hour's usage to the bar it falls in; hours outside every bar are dropped. */
export function fillBars(bars: readonly Bar[], hours: ReadonlyArray<Tokens & { hour: number }>): Bar[] {
  const filled = bars.map((bar) => ({ ...bar }));
  for (const hour of hours) {
    const bar = filled.find((candidate) => hour.hour >= candidate.start && hour.hour < candidate.end);
    if (bar !== undefined) Object.assign(bar, addTokens(bar, hour));
  }
  return filled;
}

/** 950, 12K, 4.5M, 1.2B: three significant figures at most. */
export function formatTokens(count: number): string {
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (count >= size) {
      const value = count / size;
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
      return `${Number(value.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(count));
}

/** A round axis maximum at or above `max`, and the gridline values below it. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const ticks: number[] = [0];
  while (ticks.at(-1)! < max) ticks.push(ticks.length * step);
  return ticks;
}

const MINUTE = 60_000;
/** Bucket sizes a thread's chart picks from, smallest first. */
const BUCKET_SIZES = [1, 5, 15, 30, 60, 180, 360, 720, 1440].map((minutes) => minutes * MINUTE);

export interface TimeBucket extends Tokens {
  start: number;
  end: number;
  /** Indexes into the items that fell in this bucket. */
  items: number[];
}

/**
 * Buckets items by time over [from, to], using the smallest round size that
 * keeps the count at or under `maxBuckets`. Buckets start on local clock
 * boundaries, so a 15-minute bucket starts at :00, :15, :30, or :45.
 */
export function timeBuckets<T extends Tokens>(
  items: readonly T[],
  timeOf: (item: T) => number,
  from: number,
  to: number,
  maxBuckets: number,
): TimeBucket[] {
  const span = Math.max(0, to - from);
  const size = BUCKET_SIZES.find((candidate) => span / candidate < maxBuckets) ?? BUCKET_SIZES.at(-1)!;
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const floor = (time: number) => Math.floor((time - offset) / size) * size + offset;
  const first = floor(from);
  const count = Math.floor((floor(to) - first) / size) + 1;
  const buckets: TimeBucket[] = Array.from({ length: count }, (_, index) => ({
    start: first + index * size,
    end: first + (index + 1) * size,
    items: [],
    ...ZERO_TOKENS,
  }));
  items.forEach((item, index) => {
    const bucket = buckets[Math.floor((floor(timeOf(item)) - first) / size)];
    if (bucket === undefined) return;
    Object.assign(bucket, addTokens(bucket, item));
    bucket.items.push(index);
  });
  return buckets;
}
