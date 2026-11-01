import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AB_SCENARIOS, printAbReport, runAb } from "./lib/ab-run.mjs";

const USAGE = `Usage: node scripts/perf/ab.mjs --a <url> --b <url> [options]

Interleaved A/B between two running sandy servers on the same data.
Each round runs both variants in a fresh browser, in the order AB BA BA AB, so drift hits both alike.

Scenarios:
  switch                The first load of the start thread, then thread switches and thread actions menu opens,
                        timed until usable (default)
  scroll                A continuous wheel scroll up and a touch fling up on one heavy thread, compared by
                        frame pacing (presented frames from the trace, rAF and LoAF in the page)

Options:
  --a <url>             Baseline server
  --b <url>             Candidate server
  --scenario <name>     switch or scroll (default switch)
  --start <thread id>   Thread to open first, and the thread scrolled by --scenario scroll
                        (default: the first idle sidebar thread; for scroll the heaviest idle thread)
  --threads <n>         Sidebar threads to switch between (default 4)
  --menus <n>           Thread actions menu opens per round (default 3)
  --rounds <n>          Rounds (default 8)
  --cpu-throttle <n>    Slow the page's CPU n times, 4 for an old laptop (default 1)
  --viewport <w,h>      Window size (default 1600,1000)
  --trace               Record a Chrome trace per run and break each wait down with Perfetto SQL
  --keep-traces         Keep the trace files (about 100 MB per run) instead of deleting them after the query
  --attribute           Also sample the JS CPU profile and list the top functions and modules inside each wait,
                        mapped to source through the bundle's source maps (implies --trace)
  --react-components    With --attribute, also list the React components that rendered inside each wait.
                        Needs a React profiling build (scripts/perf/profiling-proxy.mjs) and slows renders down
  --sourcemaps <dir>    Read <chunk>.map from this directory before fetching <chunk url>.map from the server
  --out <dir>           Output directory (default: <tmp>/sandy-perf-ab/<timestamp>)
`;

const { values } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    scenario: { type: "string", default: "switch" },
    start: { type: "string" },
    threads: { type: "string", default: "4" },
    menus: { type: "string", default: "3" },
    rounds: { type: "string", default: "8" },
    "cpu-throttle": { type: "string", default: "1" },
    viewport: { type: "string", default: "1600,1000" },
    trace: { type: "boolean", default: false },
    "keep-traces": { type: "boolean", default: false },
    attribute: { type: "boolean", default: false },
    "react-components": { type: "boolean", default: false },
    sourcemaps: { type: "string" },
    out: { type: "string" },
    chrome: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.a || !values.b) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
if (!AB_SCENARIOS.includes(values.scenario)) {
  console.error("Unknown scenario '" + values.scenario + "'.\n\n" + USAGE);
  process.exit(2);
}

const outDir = resolve(
  values.out ??
    join(tmpdir(), "sandy-perf-ab", new Date().toISOString().replaceAll(":", "-")),
);

const report = await runAb({
  urls: { a: values.a, b: values.b },
  scenario: values.scenario,
  start: values.start ?? null,
  threadCount: Number(values.threads),
  menuCount: Number(values.menus),
  rounds: Number(values.rounds),
  cpuThrottle: Number(values["cpu-throttle"]),
  viewport: values.viewport,
  trace: values.trace,
  keepTraces: values["keep-traces"],
  measureLoad: true,
  attribute: values.attribute,
  reactComponents: values["react-components"],
  sourcemaps: values.sourcemaps ?? null,
  chrome: values.chrome,
  outDir,
});
printAbReport(report);
console.log("\n" + join(outDir, "ab.json"));
