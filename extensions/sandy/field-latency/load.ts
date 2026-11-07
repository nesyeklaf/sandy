import { PRESSURE_STATES, type Load, type Sample } from "./contract.ts";

export const LOAD_WINDOW_MS = 5000;
export const TICK_MS = 200;
export const JITTER_FLOOR_MS = 4;
export const BUSY_PCT = 10;
const CAPACITY = 400;
const MIN_COVERAGE = 0.5;

export type LoadBucket = "idle" | "busy" | "unknown";

export class LagLog {
  private readonly at = new Float64Array(CAPACITY);
  private readonly lag = new Float64Array(CAPACITY);
  private readonly period = new Float64Array(CAPACITY);
  private next = 0;
  private size = 0;

  record(at: number, lag: number, period: number): void {
    this.at[this.next] = at;
    this.lag[this.next] = lag;
    this.period[this.next] = period;
    this.next = (this.next + 1) % CAPACITY;
    this.size = Math.min(CAPACITY, this.size + 1);
  }

  window(end: number, windowMs: number): { busyPct: number; maxLagMs: number } | null {
    const start = end - windowMs;
    let lagged = 0;
    let covered = 0;
    let maxLag = 0;
    for (let i = 0; i < this.size; i++) {
      const at = this.at[i] ?? 0;
      const lag = this.lag[i] ?? 0;
      const period = this.period[i] ?? 0;
      covered += overlap(at - period, at, start, end);
      const lagOverlap = overlap(at - lag, at, start, end);
      lagged += lagOverlap;
      if (lagOverlap > 0) maxLag = Math.max(maxLag, lag);
    }
    if (covered < windowMs * MIN_COVERAGE) return null;
    return { busyPct: Math.min(100, Math.round((lagged / windowMs) * 1000) / 10), maxLagMs: Math.round(maxLag) };
  }
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export interface LagEnv {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  visible(): boolean;
  random(): number;
  onVisibilityChange(callback: () => void): () => void;
}

const BROWSER_ENV: LagEnv = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => document.visibilityState === "visible",
  random: () => Math.random(),
  onVisibilityChange: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
};

export const TICK_SPREAD = 0.5;

export function nextDelay(random: number, tickMs: number): number {
  return Math.round(tickMs * (1 - TICK_SPREAD + random * 2 * TICK_SPREAD));
}

export function startLagSampler(log: LagLog, signal: AbortSignal, env: LagEnv = BROWSER_ENV, tickMs = TICK_MS): void {
  let lastAt = env.now();
  let handle: unknown = null;
  let running = false;
  const stop = () => {
    if (handle !== null) env.clearTimeout(handle);
    handle = null;
    running = false;
  };
  const schedule = () => {
    const delay = nextDelay(env.random(), tickMs);
    const expected = env.now() + delay;
    handle = env.setTimeout(() => {
      handle = null;
      if (signal.aborted || !running) return;
      const at = env.now();
      if (env.visible()) {
        log.record(at, Math.max(0, at - expected - JITTER_FLOOR_MS), at - lastAt);
        lastAt = at;
        schedule();
      } else {
        running = false;
      }
    }, delay);
  };
  const start = () => {
    if (running || signal.aborted) return;
    running = true;
    lastAt = env.now();
    schedule();
  };
  const unsubscribe = env.onVisibilityChange(() => {
    if (env.visible()) start();
    else stop();
  });
  if (env.visible()) start();
  signal.addEventListener(
    "abort",
    () => {
      stop();
      unsubscribe();
    },
    { once: true },
  );
}

interface PressureRecord {
  state?: unknown;
}

interface PressureObserverLike {
  observe(source: string, options?: { sampleInterval: number }): Promise<void>;
  disconnect(): void;
}

interface BatteryLike {
  charging: boolean;
  level: number;
}

export interface LoadProbe {
  read(end: number): Load | null;
}

function pressureState(value: unknown): Load["pressure"] {
  return PRESSURE_STATES.find((state) => state === value) ?? null;
}

export function startLoadProbe(signal: AbortSignal): LoadProbe {
  const log = new LagLog();
  startLagSampler(log, signal);
  let pressure: Load["pressure"] = null;
  let battery: BatteryLike | null = null;

  const Observer: unknown = Reflect.get(globalThis, "PressureObserver");
  if (typeof Observer === "function") {
    try {
      const observer = new (Observer as new (callback: (records: PressureRecord[]) => void) => PressureObserverLike)((records) => {
        pressure = pressureState(records[records.length - 1]?.state);
      });
      observer.observe("cpu", { sampleInterval: 1000 }).catch(() => {});
      signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    } catch {
      pressure = null;
    }
  }

  const getBattery: unknown = Reflect.get(navigator, "getBattery");
  if (typeof getBattery === "function") {
    Promise.resolve(getBattery.call(navigator))
      .then((value: BatteryLike) => {
        battery = value;
      })
      .catch(() => {});
  }

  return {
    read(end) {
      const lag = log.window(end, LOAD_WINDOW_MS);
      if (lag === null && pressure === null && battery === null) return null;
      return {
        windowMs: LOAD_WINDOW_MS,
        busyPct: lag?.busyPct ?? null,
        maxLagMs: lag?.maxLagMs ?? null,
        pressure,
        charging: battery?.charging ?? null,
        batteryPct: battery === null ? null : Math.round(battery.level * 100),
      };
    },
  };
}

export function loadBucket(load: Load | null): LoadBucket {
  if (load === null) return "unknown";
  if (load.pressure === "serious" || load.pressure === "critical") return "busy";
  if (load.busyPct === null) return "unknown";
  return load.busyPct >= BUSY_PCT ? "busy" : "idle";
}

export function loadCounts(samples: readonly Sample[]): Record<LoadBucket, number> {
  const counts: Record<LoadBucket, number> = { idle: 0, busy: 0, unknown: 0 };
  for (const sample of samples) counts[loadBucket(sample.load)]++;
  return counts;
}
