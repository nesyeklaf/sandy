#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppApi } from "./lib/api.mjs";
import { attachToServer, startAppServer } from "./lib/app-server.mjs";
import { PerfBrowser } from "./lib/browser.mjs";
import { spread, ValidityLedger } from "./lib/metrics.mjs";
import { SCENARIOS } from "./scenarios/index.mjs";

const USAGE = `Usage: node scripts/perf/run.mjs <scenario|all|list> [options]

Options:
  --url <url>           Attach to a running sandy (must serve an isolated, seeded data dir)
  --data-dir <path>     Start a production sandy on this seeded data dir (pnpm seed:perf)
  --server-port <n>     Port for the started server (default: free port)
  --server-match <s>    Substring of the attached server's command line (its --data-dir), used for server CPU sampling
  --perf-diagnostics    Start the server with --perf-diagnostics
  --out <dir>           Artifact directory (default: <tmp>/sandy-perf/<timestamp>)
  --runs <n>            Repeat each scenario n times with a fresh browser (default 1)
  --chrome <path>       Chrome/Chromium executable (or SANDY_PERF_CHROME)
  --headed              Run a visible browser
  --viewport <w,h>      Browser window size (default 1600,1000)
  --cpu-throttle <n>    Slow the page's CPU n times, 4 for an old laptop (default 1)
  --thread <id>         Thread for scenarios that scroll one thread (scroll-smoothness; default: the heaviest)
  --attribute           Sample the JS CPU profile in every capture and store the top functions and modules,
                        mapped through the bundle's source maps, as capture.attribution in run-<n>.json
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    "data-dir": { type: "string" },
    "server-port": { type: "string" },
    "server-match": { type: "string" },
    "perf-diagnostics": { type: "boolean", default: false },
    out: { type: "string" },
    runs: { type: "string", default: "1" },
    chrome: { type: "string" },
    headed: { type: "boolean", default: false },
    viewport: { type: "string", default: "1600,1000" },
    "cpu-throttle": { type: "string", default: "1" },
    attribute: { type: "boolean", default: false },
    thread: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const names = Object.keys(SCENARIOS);
const requested = positionals[0];
if (values.help || !requested) {
  console.log(USAGE + "\nScenarios: " + names.join(", "));
  process.exit(requested || values.help ? 0 : 2);
}
if (requested === "list") {
  for (const scenario of Object.values(SCENARIOS))
    console.log(scenario.name.padEnd(16) + scenario.description);
  process.exit(0);
}
const selected = requested === "all" ? names : positionals;
for (const name of selected) {
  if (!SCENARIOS[name]) {
    console.error(
      "Unknown scenario '" + name + "'. Scenarios: " + names.join(", "),
    );
    process.exit(2);
  }
}

const runs = Number(values.runs);
const outDir = resolve(
  values.out ??
    join(tmpdir(), "sandy-perf", new Date().toISOString().replaceAll(":", "-")),
);
mkdirSync(outDir, { recursive: true });

if (!values.url && !values["data-dir"]) {
  console.error(
    "Pass --url <running isolated sandy> or --data-dir <seeded data dir>.\n\n" +
      USAGE,
  );
  process.exit(2);
}

const server = values.url
  ? await attachToServer(values.url)
  : await startAppServer({
      dataDir: resolve(values["data-dir"]),
      serverPort: values["server-port"]
        ? Number(values["server-port"])
        : undefined,
      logPath: join(outDir, "server.log"),
      perfDiagnostics: values["perf-diagnostics"],
    });

const api = new AppApi(server.url);
const dataDirPattern =
  values["server-match"] ??
  (values["data-dir"] ? resolve(values["data-dir"]) : null);
const summary = {
  startedAt: new Date().toISOString(),
  server: server.url,
  outDir,
  scenarios: {},
};
let failed = false;

const flattenHeadline = (headlines) => {
  const keys = [
    ...new Set(headlines.flatMap((headline) => Object.keys(headline))),
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      spread(
        headlines
          .map((headline) => headline[key])
          .filter((value) => typeof value === "number"),
      ),
    ]),
  );
};

try {
  for (const name of selected) {
    const scenario = SCENARIOS[name];
    const scenarioDir = join(outDir, name);
    mkdirSync(scenarioDir, { recursive: true });
    const runSummaries = [];
    for (let index = 1; index <= runs; index += 1) {
      const ledger = new ValidityLedger();
      const browsers = [];
      const context = {
        baseUrl: server.url,
        api,
        ledger,
        dataDirPattern,
        outDir: scenarioDir,
        runIndex: index,
        options: values,
        log: (message) =>
          console.log("  [" + name + " #" + index + "] " + message),
        launchBrowser: async (options = {}) => {
          const browser = await PerfBrowser.launch({
            chrome: values.chrome,
            headless: !values.headed,
            windowSize: values.viewport,
            cpuThrottle: Number(values["cpu-throttle"]),
            attribute: values.attribute,
            ...options,
          });
          browsers.push(browser);
          return browser;
        },
      };
      console.log("> " + name + " (run " + index + "/" + runs + ")");
      const startedAt = Date.now();
      let result = null;
      let error = null;
      try {
        result = await scenario.run(context);
      } catch (caught) {
        error = caught;
      } finally {
        for (const browser of browsers) await browser.close().catch(() => {});
      }
      const valid = !error && ledger.valid;
      const record = {
        scenario: name,
        run: index,
        valid,
        durationMs: Date.now() - startedAt,
        error: error ? String(error.stack ?? error) : null,
        ledger: ledger.checks,
        headline: result?.headline ?? {},
        data: result?.data ?? null,
      };
      writeFileSync(
        join(scenarioDir, "run-" + index + ".json"),
        JSON.stringify(record, null, 2),
      );
      runSummaries.push(record);
      if (!valid) {
        failed = true;
        console.error(
          "  INVALID: " +
            (error
              ? error.message
              : ledger.failures.map((check) => check.name).join("; ")),
        );
      } else {
        console.log("  valid, " + ledger.checks.length + " checks passed");
      }
    }
    summary.scenarios[name] = {
      valid: runSummaries.every((record) => record.valid),
      runs: runSummaries.length,
      headline: flattenHeadline(
        runSummaries
          .filter((record) => record.valid)
          .map((record) => record.headline),
      ),
      failures: runSummaries.flatMap((record) =>
        record.error
          ? [record.error.split("\n")[0]]
          : record.ledger
              .filter((check) => !check.passed)
              .map((check) => check.name),
      ),
    };
  }
} finally {
  await server.stop();
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("\nArtifacts: " + outDir);
for (const [name, entry] of Object.entries(summary.scenarios)) {
  console.log((entry.valid ? "PASS " : "FAIL ") + name);
  for (const [key, value] of Object.entries(entry.headline))
    console.log(
      "      " +
        key +
        ": mean " +
        value.mean +
        " (min " +
        value.min +
        ", max " +
        value.max +
        ")",
    );
}
process.exit(failed ? 1 : 0);
