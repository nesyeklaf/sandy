import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_INTERVAL_MS,
  BENCHMARK_KEY,
  BENCHMARK_SOURCE,
  WORKER_SOURCE,
  benchmarkDue,
  medianOf,
  parseBenchmarkState,
  scheduleBenchmark,
} from "./benchmark.ts";

test("the benchmark runs when never run, after a day, or when the stored time is in the future", () => {
  const now = 10 * BENCHMARK_INTERVAL_MS;
  assert.equal(benchmarkDue(null, now), true);
  assert.equal(benchmarkDue({ at: now - BENCHMARK_INTERVAL_MS + 1, index: 100 }, now), false);
  assert.equal(benchmarkDue({ at: now - BENCHMARK_INTERVAL_MS, index: 100 }, now), true);
  assert.equal(benchmarkDue({ at: now + 1000, index: 100 }, now), true);
});

test("stored state that is not a time and an index is ignored", () => {
  assert.deepEqual(parseBenchmarkState('{"at":5,"index":120}'), { at: 5, index: 120 });
  assert.equal(parseBenchmarkState(null), null);
  assert.equal(parseBenchmarkState("nope"), null);
  assert.equal(parseBenchmarkState('{"at":"5","index":1}'), null);
});

test("the median of three runs is the middle one", () => {
  assert.equal(medianOf([300, 100, 200]), 200);
  assert.equal(medianOf([]), null);
});

test("the worker runs the shared benchmark function three times and reports every run", () => {
  assert.ok(WORKER_SOURCE.startsWith(BENCHMARK_SOURCE));
  const runs: number[] = [];
  const post = (value: unknown) => runs.push(...(value as number[]));
  const body = new Function("postMessage", "performance", WORKER_SOURCE.replace("< 300", "< 3"));
  body(post, performance);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((value) => Number.isInteger(value) && value > 0));
});

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const store = new Map<string, string>();
let workers = 0;
let terminated = 0;
let revoked = 0;
let silent = false;
let clock = 0;
const realNow = Date.now;

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    workers++;
    if (!silent) queueMicrotask(() => this.onmessage?.({ data: [400, 100, 250] }));
  }
  terminate() {
    terminated++;
  }
}

beforeEach(() => {
  for (const key of ["localStorage", "document", "Worker", "requestIdleCallback"]) saved[key] = globals[key];
  saved.revokeObjectURL = URL.revokeObjectURL;
  store.clear();
  workers = 0;
  terminated = 0;
  revoked = 0;
  silent = false;
  URL.revokeObjectURL = () => void revoked++;
  clock = 1_000_000_000_000;
  Date.now = () => clock;
  globals.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  globals.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  globals.Worker = FakeWorker;
  globals.requestIdleCallback = (callback: () => void) => callback();
});

afterEach(() => {
  for (const key of Object.keys(saved)) if (key !== "revokeObjectURL") globals[key] = saved[key];
  URL.revokeObjectURL = saved.revokeObjectURL as typeof URL.revokeObjectURL;
  Date.now = realNow;
});

async function runOnce(): Promise<number | null> {
  let result: number | null = null;
  scheduleBenchmark((index) => (result = index), new AbortController().signal, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return result;
}

test("scheduling runs the worker benchmark once a day and stores the median", async () => {
  assert.equal(await runOnce(), 250);
  assert.equal(workers, 1);
  assert.deepEqual(JSON.parse(store.get(BENCHMARK_KEY) ?? "null"), { at: clock, index: 250 });
  clock += BENCHMARK_INTERVAL_MS - 1000;
  assert.equal(await runOnce(), null);
  assert.equal(workers, 1);
  clock += 2000;
  assert.equal(await runOnce(), 250);
  assert.equal(workers, 2);
});

test("an aborted page never starts the worker", async () => {
  const controller = new AbortController();
  scheduleBenchmark(() => {}, controller.signal, 5);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workers, 0);
});

test("aborting the page while the worker runs terminates it and frees its script", async () => {
  silent = true;
  const controller = new AbortController();
  scheduleBenchmark(() => {}, controller.signal, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(workers, 1);
  controller.abort();
  assert.equal(terminated, 1);
  assert.equal(revoked, 1);
});

test("a worker that never answers is stopped at the deadline and stores nothing", async () => {
  silent = true;
  let result: number | null = null;
  scheduleBenchmark((index) => (result = index), new AbortController().signal, 0, 15);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(terminated, 1);
  assert.equal(revoked, 1);
  assert.equal(result, null);
  assert.equal(store.get(BENCHMARK_KEY), undefined);
});
