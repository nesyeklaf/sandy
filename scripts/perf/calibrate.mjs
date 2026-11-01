#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { median } from "./lib/ab-stats.mjs";
import { PerfBrowser } from "./lib/browser.mjs";
import {
  TOLERANCE,
  deviation,
  fieldDeviceScore,
  mainThreadBenchmarkExpression,
  recommendThrottle,
  refineRate,
  withinTolerance,
  workerBenchmarkExpression,
} from "./lib/calibration.mjs";

const USAGE = `Usage: node scripts/perf/calibrate.mjs (--device-score <n> | --field) [options]

Finds the --cpu-throttle factor that makes headless Chrome on this machine as fast as a user's device.
Runs sandyBenchmarkIndex (the function the field-latency plugin runs in the user's browser) in a dedicated
Web Worker, takes the median of the runs as the lab score, recommends lab score / device score, and checks
it by running the benchmark on the throttled main thread.

Options:
  --device-score <n>    The device's sandyBenchmarkIndex
  --field               Read the device score as the median benchmarkIndex of the devices in sandy field-latency report --json
  --since <duration>    With --field, how far back to read (default 7d)
  --runs <n>            Benchmark runs per measurement (default 5)
  --refine <n>          Correction steps when the throttled score misses the target by more than 10% (default 2)
  --chrome <path>       Chrome/Chromium executable (or SANDY_PERF_CHROME)
  --json                Print the result as JSON
`;

const { values } = parseArgs({
  options: {
    "device-score": { type: "string" },
    field: { type: "boolean", default: false },
    since: { type: "string", default: "7d" },
    runs: { type: "string", default: "5" },
    refine: { type: "string", default: "2" },
    chrome: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || (!values["device-score"] && !values.field)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const readFieldScore = () => {
  const output = execFileSync(
    "sandy",
    ["field-latency", "report", "--json", "--since", values.since],
    { encoding: "utf8" },
  );
  const { score, sessions } = fieldDeviceScore(JSON.parse(output));
  if (score === null) {
    console.error(
      "sandy field-latency report --json lists no device with a benchmarkIndex in that window. Pass --device-score <n>.",
    );
    process.exit(2);
  }
  return { score, sessions };
};

const device = values.field
  ? { ...readFieldScore(), source: "field" }
  : { score: Number(values["device-score"]), sessions: null, source: "flag" };
if (!(device.score > 0)) {
  console.error("The device score must be a positive number.");
  process.exit(2);
}
const runs = Number(values.runs);
const log = (message) => {
  if (!values.json) console.log(message);
};

const browser = await PerfBrowser.launch({ chrome: values.chrome });
const measure = async (expression, rate) => {
  await browser.client.send("Emulation.setCPUThrottlingRate", { rate });
  const scores = await browser.evaluate(expression);
  return { rate, scores, median: median(scores) };
};

let result;
try {
  const worker = await measure(workerBenchmarkExpression(runs), 1);
  log(
    "lab score (worker, unthrottled): " +
      worker.median +
      "  runs " +
      worker.scores.join(" "),
  );
  const main = await measure(mainThreadBenchmarkExpression(runs), 1);
  log(
    "lab score (main thread, unthrottled): " +
      main.median +
      "  runs " +
      main.scores.join(" "),
  );
  const recommendation = recommendThrottle(worker.median, device.score);
  log(
    "device score: " +
      device.score +
      (device.sessions === null
        ? ""
        : " (median of " + device.sessions + " field devices)") +
      "  ->  factor " +
      recommendation.raw,
  );
  const throttledWorker = await measure(
    workerBenchmarkExpression(runs),
    Math.max(2, recommendation.factor),
  );
  const workersThrottled = withinTolerance(
    throttledWorker.median,
    worker.median / throttledWorker.rate,
    0.25,
  );
  log(
    "worker at " +
      throttledWorker.rate +
      "x: " +
      throttledWorker.median +
      " (" +
      (workersThrottled
        ? "CDP throttling slows dedicated workers too"
        : "CDP throttling does not slow dedicated workers") +
      ")",
  );
  const checks = [];
  let rate = recommendation.factor;
  for (let step = 0; step <= Number(values.refine); step += 1) {
    const check = await measure(mainThreadBenchmarkExpression(runs), rate);
    const off = deviation(check.median, device.score);
    checks.push({ ...check, deviation: Math.round(off * 1000) / 1000 });
    log(
      "main thread at " +
        rate +
        "x: " +
        check.median +
        " vs target " +
        device.score +
        " (" +
        (off >= 0 ? "+" : "") +
        Math.round(off * 100) +
        "%)",
    );
    if (withinTolerance(check.median, device.score) || rate === 1) break;
    rate = refineRate(rate, check.median, device.score);
  }
  const final = checks.at(-1);
  const verified = withinTolerance(final.median, device.score);
  result = {
    device,
    runs,
    lab: {
      worker: worker.median,
      mainThread: main.median,
      workerRuns: worker.scores,
      mainThreadRuns: main.scores,
    },
    recommendation: { ...recommendation, verifiedFactor: final.rate },
    workersThrottled,
    throttledWorker,
    checks,
    tolerance: TOLERANCE,
    verified,
  };
  if (recommendation.deviceFasterThanLab)
    log(
      "NO THROTTLE: the device is faster than this machine (main thread " +
        final.median +
        " vs device " +
        device.score +
        "), so run without --cpu-throttle",
    );
  else
    log(
      (verified ? "PASS" : "FAIL") +
        ": use --cpu-throttle " +
        final.rate +
        " (main thread " +
        final.median +
        " vs device " +
        device.score +
        ", tolerance " +
        TOLERANCE * 100 +
        "%)",
    );
} finally {
  await browser.close();
}
if (values.json) console.log(JSON.stringify(result, null, 2));
process.exit(
  result.verified || result.recommendation.deviceFasterThanLab ? 0 : 1,
);
