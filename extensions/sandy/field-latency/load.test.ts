import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_PCT, JITTER_FLOOR_MS, LagLog, loadBucket, nextDelay, startLagSampler, startLoadProbe, type LagEnv } from "./load.ts";
import type { Load } from "./contract.ts";

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const realEnv: LagEnv = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => true,
  random: () => Math.random(),
  onVisibilityChange: () => () => {},
};

function load(overrides: Partial<Load>): Load {
  return { windowMs: 5000, busyPct: 0, maxLagMs: 0, pressure: null, charging: null, batteryPct: null, ...overrides };
}

test("a window of regular ticks without lag is idle", () => {
  const log = new LagLog();
  for (let at = 200; at <= 5000; at += 200) log.record(at, 0, 200);
  assert.deepEqual(log.window(5000, 5000), { busyPct: 0, maxLagMs: 0 });
});

test("lag counts only where it overlaps the window, also when the tick fires after the interaction", () => {
  const log = new LagLog();
  for (let at = 200; at <= 3000; at += 200) log.record(at, 0, 200);
  log.record(4500, 1300, 1500);
  for (let at = 4700; at <= 6000; at += 200) log.record(at, 0, 200);
  const inside = log.window(5000, 5000);
  assert.equal(inside?.busyPct, 26);
  assert.equal(inside?.maxLagMs, 1300);
  assert.equal(log.window(3000, 3000)?.busyPct, 0);
  assert.equal(log.window(3500, 3000)?.busyPct, 10);
  const startedBeforeEnd = new LagLog();
  for (let at = 200; at <= 2000; at += 200) startedBeforeEnd.record(at, 0, 200);
  startedBeforeEnd.record(4000, 1800, 2000);
  assert.equal(startedBeforeEnd.window(3000, 2000)?.busyPct, 40);
});

test("a window the sampler barely covered, such as right after a page load, has no busy share", () => {
  const log = new LagLog();
  log.record(200, 0, 200);
  log.record(400, 0, 200);
  assert.equal(log.window(5000, 5000), null);
});

interface Virtual {
  env: LagEnv;
  now(): number;
  pending(): number;
  setVisible(visible: boolean): void;
  runUntil(end: number): void;
}

function virtualLoop(options: { random: () => number; block?: { period: number; duration: number; phase: number } }): Virtual {
  let now = 0;
  let visible = true;
  let nextId = 1;
  const timers = new Map<number, { due: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const blockEnd = (t: number): number => {
    const block = options.block;
    if (!block) return t;
    const offset = (((t - block.phase) % block.period) + block.period) % block.period;
    return offset < block.duration ? t + block.duration - offset : t;
  };
  const env: LagEnv = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++;
      timers.set(id, { due: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    visible: () => visible,
    random: options.random,
    onVisibilityChange: (callback) => {
      listeners.add(callback);
      return () => void listeners.delete(callback);
    },
  };
  return {
    env,
    now: () => now,
    pending: () => timers.size,
    setVisible(value) {
      visible = value;
      for (const listener of [...listeners]) listener();
    },
    runUntil(end) {
      for (;;) {
        let next: [number, { due: number; run: () => void }] | null = null;
        for (const entry of timers) if (next === null || entry[1].due < next[1].due) next = entry;
        if (next === null) break;
        const fires = blockEnd(next[1].due);
        if (fires > end) break;
        timers.delete(next[0]);
        now = Math.max(now, fires);
        next[1].run();
      }
      now = Math.max(now, end);
    },
  };
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function measure(random: () => number, period: number, duty: number, phase: number): ReturnType<LagLog["window"]> {
  const loop = virtualLoop({ random, block: { period, duration: period * duty, phase } });
  const log = new LagLog();
  startLagSampler(log, new AbortController().signal, loop.env, 200);
  loop.runUntil(30000);
  return log.window(loop.now(), 5000);
}

test("the next delay stays within half a tick either way and averages one tick", () => {
  assert.equal(nextDelay(0, 200), 100);
  assert.equal(nextDelay(0.5, 200), 200);
  assert.equal(nextDelay(0.999, 200), 300);
  const random = mulberry32(7);
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum += nextDelay(random(), 200);
  assert.ok(Math.abs(sum / 10000 - 200) < 3);
});

test("a main thread busy 75 % of the time with period 200 ms is invisible to a fixed cadence", () => {
  const fixed = measure(() => 0.5, 200, 0.75, 50);
  assert.equal(fixed?.busyPct, 0);
});

test("periodic work reads busy at many periods and phases with the jittered cadence", () => {
  const periods = [120, 150, 200, 250, 300, 500, 1000];
  const phases = [0, 0.25, 0.5, 0.75];
  for (const period of periods) {
    for (const fraction of phases) {
      for (const seed of [1, 2, 3]) {
        const result = measure(mulberry32(seed * 1000 + period), period, 0.72, period * fraction);
        assert.ok(result !== null && result.busyPct >= BUSY_PCT, `period ${period} phase ${fraction} seed ${seed}: ${result?.busyPct}`);
      }
    }
  }
});

test("an idle loop stays idle with the jittered cadence", () => {
  const loop = virtualLoop({ random: mulberry32(5) });
  const log = new LagLog();
  startLagSampler(log, new AbortController().signal, loop.env, 200);
  loop.runUntil(30000);
  assert.deepEqual(log.window(loop.now(), 5000), { busyPct: 0, maxLagMs: 0 });
});

test("a hidden tab has no sampler timer, and returning shows unknown load until enough visible coverage", () => {
  const loop = virtualLoop({ random: mulberry32(9) });
  const log = new LagLog();
  startLagSampler(log, new AbortController().signal, loop.env, 200);
  loop.runUntil(10000);
  assert.equal(loop.pending(), 1);
  assert.notEqual(log.window(loop.now(), 5000), null);
  loop.setVisible(false);
  assert.equal(loop.pending(), 0);
  loop.runUntil(70000);
  assert.equal(loop.pending(), 0);
  loop.setVisible(true);
  assert.equal(loop.pending(), 1);
  loop.runUntil(71000);
  assert.equal(log.window(loop.now(), 5000), null);
  loop.runUntil(74000);
  assert.deepEqual(log.window(loop.now(), 5000), { busyPct: 0, maxLagMs: 0 });
});

test("the hidden gap is not counted as lag when the tab returns", () => {
  const loop = virtualLoop({ random: mulberry32(11) });
  const log = new LagLog();
  startLagSampler(log, new AbortController().signal, loop.env, 200);
  loop.runUntil(5000);
  loop.setVisible(false);
  loop.runUntil(125000);
  loop.setVisible(true);
  loop.runUntil(131000);
  const window = log.window(loop.now(), 5000);
  assert.deepEqual(window, { busyPct: 0, maxLagMs: 0 });
});

test("aborting clears the timer and stops listening for visibility", () => {
  const loop = virtualLoop({ random: mulberry32(13) });
  const controller = new AbortController();
  startLagSampler(new LagLog(), controller.signal, loop.env, 200);
  loop.runUntil(1000);
  controller.abort();
  assert.equal(loop.pending(), 0);
  loop.setVisible(false);
  loop.setVisible(true);
  assert.equal(loop.pending(), 0);
});

test("a blocked main thread shows a busy share in the sampler window and an idle one does not", async () => {
  const log = new LagLog();
  const controller = new AbortController();
  startLagSampler(log, controller.signal, realEnv, 20);
  await sleep(700);
  const idle = log.window(performance.now(), 600);
  await sleep(50);
  spin(500);
  await sleep(120);
  const busy = log.window(performance.now(), 1000);
  controller.abort();
  assert.ok(idle !== null && busy !== null);
  assert.ok(idle.busyPct < BUSY_PCT, "idle " + idle.busyPct);
  assert.ok(busy.busyPct >= 30, "busy " + busy.busyPct);
  assert.ok(busy.maxLagMs >= 400, "lag " + busy.maxLagMs);
  assert.ok(JITTER_FLOOR_MS > 0);
});

test("bucket: busy share and compute pressure decide, missing data is unknown", () => {
  assert.equal(loadBucket(null), "unknown");
  assert.equal(loadBucket(load({ busyPct: null })), "unknown");
  assert.equal(loadBucket(load({ busyPct: BUSY_PCT - 0.1 })), "idle");
  assert.equal(loadBucket(load({ busyPct: BUSY_PCT })), "busy");
  assert.equal(loadBucket(load({ busyPct: 0, pressure: "serious" })), "busy");
  assert.equal(loadBucket(load({ busyPct: null, pressure: "critical" })), "busy");
  assert.equal(loadBucket(load({ busyPct: 0, pressure: "fair" })), "idle");
});

const saved = new Map<string, PropertyDescriptor | undefined>();
const setGlobal = (name: string, value: unknown) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

test("a browser with neither PressureObserver nor Battery API (Firefox) still reports the busy share with null extras", async () => {
  setGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  const controller = new AbortController();
  const probe = startLoadProbe(controller.signal);
  assert.equal(probe.read(performance.now()), null);
  controller.abort();
  const log = new LagLog();
  for (let at = 200; at <= 5000; at += 200) log.record(at, 0, 200);
  assert.deepEqual(log.window(5000, 5000), { busyPct: 0, maxLagMs: 0 });
});

test("compute pressure and battery are read where the browser has them, and a failing observer is ignored", async () => {
  setGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  const observer: { deliver: (records: { state: string }[]) => void } = { deliver: () => {} };
  setGlobal(
    "PressureObserver",
    class {
      constructor(callback: (records: { state: string }[]) => void) {
        observer.deliver = callback;
      }
      observe() {
        return Promise.resolve();
      }
      disconnect() {}
    },
  );
  setGlobal("navigator", { getBattery: () => Promise.resolve({ charging: false, level: 0.42 }) });
  const controller = new AbortController();
  const probe = startLoadProbe(controller.signal);
  await sleep(10);
  observer.deliver([{ state: "nominal" }, { state: "serious" }]);
  const read = probe.read(performance.now());
  assert.deepEqual([read?.pressure, read?.charging, read?.batteryPct, read?.busyPct], ["serious", false, 42, null]);
  controller.abort();

  setGlobal(
    "PressureObserver",
    class {
      constructor() {
        throw new Error("blocked by permissions policy");
      }
    },
  );
  const second = new AbortController();
  assert.doesNotThrow(() => startLoadProbe(second.signal));
  second.abort();
});
