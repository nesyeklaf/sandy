import type { ScrollStats } from "./contract.ts";

export const SESSION_GAP_MS = 300;
export const MAX_SESSION_MS = 20000;
export const MIN_SESSION_FRAMES = 12;
export const INPUT_WINDOW_MS = 500;
export const DROP_FACTOR = 1.5;
export const FRAME_BUFFER_SIZE = 4096;
export const CALIBRATION_FRAMES = 60;
export const REFRESH_CORRECTION = 0.9;

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function quantile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

function intervalsOf(timestamps: Float64Array): Float64Array {
  const count = Math.max(0, timestamps.length - 1);
  const intervals = new Float64Array(count);
  for (let i = 0; i < count; i++) intervals[i] = (timestamps[i + 1] ?? 0) - (timestamps[i] ?? 0);
  return intervals;
}

export function estimateRefreshMs(timestamps: Float64Array): number | null {
  if (timestamps.length < 3) return null;
  const sorted = intervalsOf(timestamps).sort();
  const estimate = quantile(sorted, 25);
  return estimate > 0 ? round(estimate) : null;
}

export function trimToEnd(timestamps: Float64Array, endTimestamp: number): Float64Array {
  let count = timestamps.length;
  while (count > 0 && (timestamps[count - 1] ?? 0) > endTimestamp) count--;
  return timestamps.subarray(0, count);
}

export function summarizeScroll(timestamps: Float64Array, refreshMs: number, truncated: boolean): ScrollStats | null {
  if (timestamps.length < 2 || refreshMs <= 0) return null;
  const intervals = intervalsOf(timestamps);
  const span = (timestamps[timestamps.length - 1] ?? 0) - (timestamps[0] ?? 0);
  if (span <= 0) return null;
  let dropped = 0;
  let max = 0;
  for (const interval of intervals) {
    if (interval > refreshMs * DROP_FACTOR) dropped++;
    if (interval > max) max = interval;
  }
  const sorted = intervals.slice().sort();
  const smoothness = Math.min(100, (intervals.length * refreshMs * 100) / span);
  return {
    durationMs: round(span),
    frames: intervals.length,
    dropped,
    refreshMs: round(refreshMs),
    p95FrameMs: round(quantile(sorted, 95)),
    maxFrameMs: round(max),
    smoothnessPct: round(smoothness),
    truncated,
  };
}

const LABEL_ATTRIBUTE = /^data-.*(scroll|viewport|timeline)/;

export interface LabelSource {
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  tagName: string;
}

export function scrollContainerLabel(element: LabelSource | null): string {
  if (element === null) return "page";
  const dataName = element.getAttributeNames().find((name) => LABEL_ATTRIBUTE.test(name));
  if (dataName) return dataName.slice("data-".length).slice(0, 80);
  const named = element.getAttribute("id") ?? element.getAttribute("aria-label") ?? element.getAttribute("role");
  if (named) return named.replace(/\s+/g, " ").trim().slice(0, 60);
  return element.tagName.toLowerCase();
}

export class ScrollSession {
  readonly timestamps = new Float64Array(FRAME_BUFFER_SIZE);
  count = 0;
  startedAt = 0;
  lastEventAt = 0;
  label = "page";
  truncated = false;

  begin(at: number, label: string): void {
    this.count = 0;
    this.startedAt = at;
    this.lastEventAt = at;
    this.label = label;
    this.truncated = false;
  }

  record(timestamp: number): void {
    if (this.count < this.timestamps.length) this.timestamps[this.count++] = timestamp;
    if (this.count >= this.timestamps.length) this.truncated = true;
  }

  shouldEnd(timestamp: number): boolean {
    if (this.truncated) return true;
    if (timestamp - this.lastEventAt > SESSION_GAP_MS) return true;
    if (timestamp - this.startedAt > MAX_SESSION_MS) {
      this.truncated = true;
      return true;
    }
    return false;
  }

  finish(refreshMs: number | null): { stats: ScrollStats; start: number; end: number; refreshMs: number } | null {
    const frames = this.timestamps.slice(0, this.count);
    const own = estimateRefreshMs(frames);
    const refresh = refreshMs === null ? own : own !== null && own < refreshMs * REFRESH_CORRECTION ? own : refreshMs;
    if (refresh === null) return null;
    const trimmed = this.truncated ? frames : trimToEnd(frames, this.lastEventAt + refresh * DROP_FACTOR);
    if (trimmed.length < MIN_SESSION_FRAMES) return null;
    const stats = summarizeScroll(trimmed, refresh, this.truncated);
    if (stats === null) return null;
    return { stats, start: trimmed[0] ?? this.startedAt, end: trimmed[trimmed.length - 1] ?? this.lastEventAt, refreshMs: refresh };
  }
}
