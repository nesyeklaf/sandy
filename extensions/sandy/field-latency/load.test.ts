import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_PCT, JITTER_FLOOR_MS, LagLog, loadBucket, startLagSampler, startLoadProbe, type LagEnv } from "./load.ts";
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

test("ticks are not recorded while the tab is hidden or on the first tick after it returns", () => {
  let now = 0;
  let visible = true;
  const timers: { at: number; run: () => void }[] = [];
  const env: LagEnv = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
    visible: () => visible,
  };
  const log = new LagLog();
  startLagSampler(log, new AbortController().signal, env, 200);
  const step = (ms: number) => {
    const timer = timers.shift();
    assert.ok(timer);
    now = timer.at + ms;
    timer.run();
  };
  for (let i = 0; i < 24; i++) step(0);
  visible = false;
  step(40000);
  visible = true;
  step(40000);
  assert.equal(log.window(now, 5000), null);
  for (let i = 0; i < 25; i++) step(0);
  assert.equal(log.window(now, 5000)?.busyPct, 0);
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
  setGlobal("document", { visibilityState: "visible" });
  const controller = new AbortController();
  const probe = startLoadProbe(controller.signal);
  assert.equal(probe.read(performance.now()), null);
  controller.abort();
  const log = new LagLog();
  for (let at = 200; at <= 5000; at += 200) log.record(at, 0, 200);
  assert.deepEqual(log.window(5000, 5000), { busyPct: 0, maxLagMs: 0 });
});

test("compute pressure and battery are read where the browser has them, and a failing observer is ignored", async () => {
  setGlobal("document", { visibilityState: "visible" });
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
