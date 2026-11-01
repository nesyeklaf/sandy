import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { printFirefoxLabReport, runFirefoxLab } from "./lib/firefox-run.mjs";

const USAGE = `Usage: node scripts/perf/firefox-lab.mjs --url <url> [options]

Thread switches in headless Firefox against a running sandy server, timed from pointerdown until the
thread is usable, with the app's own sandy:switch phases and the thread request's network and server time.
Each round opens the start thread in a fresh browser, then switches through the sidebar threads twice
(first visit, then revisit). With --profile, extra rounds run under the Gecko profiler and the render
and paint phases are broken down by category, JS function (mapped through source maps) and Stylo time.

Options:
  --url <url>             sandy server
  --start <thread id>     Thread to open first (default: the first idle sidebar thread)
  --threads <n>           Sidebar threads to switch between (default 4)
  --rounds <n>            Unprofiled rounds (default 5)
  --viewport <w,h>        Window size (default 2396,1318, the field viewport)
  --hover-ms <n>          Pointer rests on the link before pointerdown, which lets the hover prefetch start
                          (default 150)
  --press-ms <n>          Time between pointerdown and pointerup (default 80)
  --revisit-gap-ms <n>    Idle time between the first visits and the revisits (default 0)
  --compare-chrome        Also run every round in headless Chrome with the same input, alternating the order
  --profile               Add profiled Firefox rounds and write their Gecko profiles as .json.gz
  --profile-rounds <n>    Profiled rounds with --profile (default 1)
  --firefox <path>        Firefox executable (default $SANDY_PERF_FIREFOX or ~/sandy-perf/firefox/firefox/firefox)
  --chrome <path>         Chrome executable for --compare-chrome
  --sourcemaps <dir>      Read <chunk>.map from this directory before fetching <chunk url>.map from the server
  --out <dir>             Output directory (default: <tmp>/sandy-perf-firefox/<timestamp>)
`;

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    start: { type: "string" },
    threads: { type: "string", default: "4" },
    rounds: { type: "string", default: "5" },
    viewport: { type: "string", default: "2396,1318" },
    "hover-ms": { type: "string", default: "150" },
    "press-ms": { type: "string", default: "80" },
    "revisit-gap-ms": { type: "string", default: "0" },
    "compare-chrome": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    "profile-rounds": { type: "string", default: "1" },
    firefox: { type: "string" },
    chrome: { type: "string" },
    sourcemaps: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.url) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const outDir = resolve(
  values.out ??
    join(
      tmpdir(),
      "sandy-perf-firefox",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);

const report = await runFirefoxLab({
  url: values.url.replace(/\/$/, ""),
  start: values.start ?? null,
  threadCount: Number(values.threads),
  rounds: Number(values.rounds),
  viewport: values.viewport,
  hoverMs: Number(values["hover-ms"]),
  pressMs: Number(values["press-ms"]),
  revisitGapMs: Number(values["revisit-gap-ms"]),
  compareChrome: values["compare-chrome"],
  profileRounds: values.profile ? Number(values["profile-rounds"]) : 0,
  firefox: values.firefox,
  chrome: values.chrome,
  sourcemaps: values.sourcemaps ?? null,
  outDir,
  onRound: (round) => {
    const waits = round.samples
      .map((sample) => sample.waitMs)
      .filter((value) => value !== null)
      .map((value) => Math.round(value));
    console.error(
      "round " +
        round.round +
        " " +
        round.browser +
        (round.profiled ? " (profiled)" : "") +
        (round.valid ? "" : " INVALID") +
        ": " +
        waits.join(" "),
    );
  },
});
const lines = [];
printFirefoxLabReport(report, (line) => {
  console.log(line);
  lines.push(line);
});
writeFileSync(
  join(outDir, "summary.md"),
  "# Firefox lab\n\n" +
    report.url +
    "\n\n```text\n" +
    lines.join("\n").trim() +
    "\n```\n",
);
console.log("\n" + join(outDir, "firefox-lab.json"));
console.log(join(outDir, "summary.md"));
