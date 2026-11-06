export const CONTENT_SETTLE_MS = 1000;
export const CONTENT_CAP_MS = 5000;

const CONTENT_ROOT = '[data-sidebar="inset"]';

export type ContentDoneStatus = "settled" | "capped" | "aborted";

export interface ContentDoneResult {
  status: ContentDoneStatus;
  doneMs: number | null;
}

interface Closest {
  closest(selector: string): unknown;
}

export interface ContentTarget {
  readonly isConnected: boolean;
  readonly parentElement: Closest | null;
}

function hasClosest(target: ContentTarget): target is ContentTarget & Closest {
  return "closest" in target && typeof target.closest === "function";
}

export function isContentTarget(target: ContentTarget): boolean {
  if (!target.isConnected) return false;
  const element = hasClosest(target) ? target : target.parentElement;
  return element !== null && element.closest(CONTENT_ROOT) !== null;
}

export class ContentRun {
  private readyAt: number | null = null;
  private lastPaintAt: number;
  private readonly t0: number;
  private readonly settleMs: number;
  private readonly capAt: number;

  constructor(t0: number, settleMs: number = CONTENT_SETTLE_MS, capMs: number = CONTENT_CAP_MS) {
    this.t0 = t0;
    this.settleMs = settleMs;
    this.lastPaintAt = t0;
    this.capAt = t0 + capMs;
  }

  markReady(at: number): void {
    this.readyAt = at;
  }

  paint(at: number): void {
    if (at > this.capAt) return;
    this.lastPaintAt = Math.max(this.lastPaintAt, at);
  }

  private doneAt(): number | null {
    return this.readyAt === null ? null : Math.max(this.readyAt, this.lastPaintAt);
  }

  nextCheckAt(): number {
    const done = this.doneAt();
    return done === null ? this.capAt : Math.min(done + this.settleMs, this.capAt);
  }

  evaluate(now: number): ContentDoneResult | null {
    const done = this.doneAt();
    if (done !== null && done + this.settleMs <= this.capAt && now >= done + this.settleMs) {
      return { status: "settled", doneMs: done - this.t0 };
    }
    if (now >= this.capAt) return { status: "capped", doneMs: done === null ? null : Math.min(done, this.capAt) - this.t0 };
    return null;
  }
}
