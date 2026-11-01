import { median } from "./ab-stats.mjs";

export const BENCHMARK_SOURCE = `function sandyBenchmarkIndex() { const start = performance.now(); let iterations = 0; while (performance.now() - start < 300) { const values = []; for (let i = 0; i < 50000; i++) values.push((i * 7919) % 10007); values.sort((a, b) => a - b); iterations++; } return Math.round((iterations * 1000) / (performance.now() - start)); }`;

export const TOLERANCE = 0.1;

export const workerBenchmarkExpression = (runs) =>
  "new Promise((resolve, reject) => { const source = " +
  JSON.stringify(
    BENCHMARK_SOURCE +
      "; onmessage = (event) => { const scores = []; for (let run = 0; run < event.data; run++) scores.push(sandyBenchmarkIndex()); postMessage(scores) };",
  ) +
  "; const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))); worker.onmessage = (event) => { worker.terminate(); resolve(event.data) }; worker.onerror = (event) => reject(new Error(event.message)); worker.postMessage(" +
  runs +
  ") })";

export const mainThreadBenchmarkExpression = (runs) =>
  "(() => { " +
  BENCHMARK_SOURCE +
  "; const scores = []; for (let run = 0; run < " +
  runs +
  "; run++) scores.push(sandyBenchmarkIndex()); return scores })()";

export const recommendThrottle = (labScore, deviceScore) => {
  const raw = labScore / deviceScore;
  return {
    factor: Math.max(1, Math.round(raw * 100) / 100),
    raw: Math.round(raw * 1000) / 1000,
    deviceFasterThanLab: raw < 1,
  };
};

export const deviation = (measured, target) => (measured - target) / target;

export const withinTolerance = (measured, target, tolerance = TOLERANCE) =>
  Math.abs(deviation(measured, target)) <= tolerance;

export const refineRate = (rate, measured, target) =>
  Math.max(1, Math.round(((rate * measured) / target) * 100) / 100);

const reportDevices = (report) => {
  if (Array.isArray(report?.devices)) return report.devices;
  return report?.device ? [report.device] : [];
};

export const fieldBenchmarkScores = (report) =>
  reportDevices(report)
    .map((device) => device?.benchmarkIndex)
    .filter((score) => typeof score === "number" && score > 0);

export const fieldDeviceScore = (report) => {
  const scores = fieldBenchmarkScores(report);
  return { score: median(scores), sessions: scores.length };
};
