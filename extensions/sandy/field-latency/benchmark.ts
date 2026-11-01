export const BENCHMARK_KEY = "sandy-field-latency:benchmark";
export const BENCHMARK_INTERVAL_MS = 86400000;
export const BENCHMARK_RUNS = 3;
export const BENCHMARK_DEADLINE_MS = 15000;

export const BENCHMARK_SOURCE =
  "function sandyBenchmarkIndex() { const start = performance.now(); let iterations = 0; while (performance.now() - start < 300) { const values = []; for (let i = 0; i < 50000; i++) values.push((i * 7919) % 10007); values.sort((a, b) => a - b); iterations++; } return Math.round((iterations * 1000) / (performance.now() - start)); }";

export const WORKER_SOURCE = `${BENCHMARK_SOURCE}
const runs = [];
for (let i = 0; i < ${BENCHMARK_RUNS}; i++) runs.push(sandyBenchmarkIndex());
postMessage(runs);`;

export interface BenchmarkState {
  at: number;
  index: number;
}

export function benchmarkDue(state: BenchmarkState | null, now: number): boolean {
  if (state === null) return true;
  const age = now - state.at;
  return age < 0 || age >= BENCHMARK_INTERVAL_MS;
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

export function parseBenchmarkState(raw: string | null): BenchmarkState | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const at: unknown = Reflect.get(value, "at");
    const index: unknown = Reflect.get(value, "index");
    if (typeof at !== "number" || typeof index !== "number" || !Number.isFinite(at) || !Number.isFinite(index)) return null;
    return { at, index };
  } catch {
    return null;
  }
}

export function loadBenchmarkState(): BenchmarkState | null {
  try {
    return parseBenchmarkState(localStorage.getItem(BENCHMARK_KEY));
  } catch {
    return null;
  }
}

function saveBenchmarkState(state: BenchmarkState): void {
  try {
    localStorage.setItem(BENCHMARK_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

function runInWorker(signal: AbortSignal, deadlineMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let url: string | null = null;
    let worker: Worker | null = null;
    let settled = false;
    const cancel = () => done(null);
    const deadline = setTimeout(cancel, deadlineMs);
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      worker?.terminate();
      if (url !== null) URL.revokeObjectURL(url);
      resolve(value);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const runs = Array.isArray(event.data) ? event.data.filter((value): value is number => typeof value === "number") : [];
        done(medianOf(runs));
      };
      worker.onerror = () => done(null);
    } catch {
      done(null);
    }
  });
}

export function scheduleBenchmark(
  onResult: (index: number) => void,
  signal: AbortSignal,
  delayMs = 5000,
  deadlineMs = BENCHMARK_DEADLINE_MS,
): void {
  if (!benchmarkDue(loadBenchmarkState(), Date.now())) return;
  let idle: number | null = null;
  const start = () => {
    if (signal.aborted) return;
    if (document.visibilityState !== "visible") {
      document.addEventListener("visibilitychange", start, { once: true });
      return;
    }
    const run = () => {
      if (signal.aborted) return;
      void runInWorker(signal, deadlineMs).then((index) => {
        if (signal.aborted || index === null) return;
        saveBenchmarkState({ at: Date.now(), index });
        onResult(index);
      });
    };
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run, { timeout: 30000 });
    else run();
  };
  const timer = setTimeout(start, delayMs);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", start);
      if (idle !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    },
    { once: true },
  );
}
