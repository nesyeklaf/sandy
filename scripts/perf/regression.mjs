#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { printAbReport, runAb } from "./lib/ab-run.mjs";
import { AppApi } from "./lib/api.mjs";
import { REPO_ROOT, startAppServer } from "./lib/app-server.mjs";
import { evaluateBudgets, renderMarkdown } from "./lib/regression-verdict.mjs";

const USAGE = `Usage: node scripts/perf/regression.mjs [options]

Builds two git refs in temporary worktrees, starts both on copies of one seeded fixture
and runs the interleaved A/B (first load, thread switches, menu opens) with a CPU throttle.
The verdict compares the head against scripts/perf/budgets.json: exit 0 on PASS, 1 on FAIL,
2 on INCONCLUSIVE (a budgeted metric without enough valid rounds) or a broken run.

Options:
  --base <ref>            Baseline (default: merge-base of origin/main and the head)
  --head <ref>            Candidate (default: HEAD)
  --rounds <n>            Interleaved rounds (default 8)
  --threads <n>           Sidebar threads to switch between (default 4)
  --menus <n>             Thread actions menu opens per round (default 3)
  --cpu-throttle <n>      Slow the page's CPU n times (default 4)
  --viewport <w,h>        Window size (default 1600,1000)
  --fixture-threads <n>   Seeded thread count (default 1200)
  --fixture-events <n>    Seeded event rows (default 400000)
  --budgets <path>        Budget file (default scripts/perf/budgets.json)
  --out <dir>             Output directory (default: <tmp>/sandy-perf-regression/<timestamp>)
  --keep-worktrees        Keep the worktrees, fixture and server logs after the run
  --chrome <path>         Chrome/Chromium executable (or SANDY_PERF_CHROME)
`;

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string", default: "HEAD" },
    rounds: { type: "string", default: "8" },
    threads: { type: "string", default: "4" },
    menus: { type: "string", default: "3" },
    "cpu-throttle": { type: "string", default: "4" },
    viewport: { type: "string", default: "1600,1000" },
    "fixture-threads": { type: "string", default: "1200" },
    "fixture-events": { type: "string", default: "400000" },
    budgets: {
      type: "string",
      default: join(REPO_ROOT, "scripts/perf/budgets.json"),
    },
    out: { type: "string" },
    "keep-worktrees": { type: "boolean", default: false },
    chrome: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const BUILD_FILTERS = [
  "--filter=@sandy/bundled-plugins",
  "--filter=@sandy-sdk/plugin-sdk",
  "--filter=@sandy/app",
  "--filter=@sandy/server",
  "--filter=@sandy/host-daemon",
];
const outDir = resolve(
  values.out ??
    join(
      tmpdir(),
      "sandy-perf-regression",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
const workDir = join(outDir, "work");
const logDir = join(outDir, "logs");
mkdirSync(workDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
const budgets = JSON.parse(readFileSync(resolve(values.budgets), "utf8"));
const buildEnv = {
  TURBO_CACHE_DIR:
    process.env.TURBO_CACHE_DIR ?? join(REPO_ROOT, ".turbo", "cache"),
  SANDY_BUILD_TOOLCHAIN:
    process.version + "-" + process.platform + "-" + process.arch,
};

const log = (message) => console.log("[regression] " + message);

const run = (command, args, { cwd = REPO_ROOT, logName, env = {} } = {}) => {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (logName) writeFileSync(join(logDir, logName + ".log"), output);
  if (result.status !== 0)
    throw new Error(
      command +
        " " +
        args.join(" ") +
        " failed with " +
        (result.status ?? result.signal) +
        (logName ? " (log: " + join(logDir, logName + ".log") + ")" : "") +
        "\n" +
        output.split("\n").slice(-30).join("\n"),
    );
  if (logName)
    log(
      logName +
        " done in " +
        Math.round((Date.now() - startedAt) / 1000) +
        " s",
    );
  return result.stdout.trim();
};

const git = (...args) => run("git", args);

const resolveRef = (ref) => ({
  ref,
  sha: git("rev-parse", "--verify", ref + "^{commit}"),
  subject: git("log", "-1", "--format=%s", ref + "^{commit}"),
});

const defaultBase = (headSha) => {
  try {
    return git("merge-base", "origin/main", headSha);
  } catch {
    return "origin/main";
  }
};

const prepareWorktree = (name, sha) => {
  const dir = join(workDir, name);
  if (existsSync(dir)) {
    spawnSync("git", ["worktree", "remove", "--force", dir], {
      cwd: REPO_ROOT,
    });
    rmSync(dir, { recursive: true, force: true });
  }
  git("worktree", "add", "--detach", dir, sha);
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
    cwd: dir,
    logName: name + "-install",
  });
  run(process.execPath, ["scripts/ensure-native-modules.mjs"], {
    cwd: dir,
    logName: name + "-native-modules",
  });
  run(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      ...BUILD_FILTERS,
      "--output-logs=errors-only",
      "--summarize=false",
    ],
    { cwd: dir, logName: name + "-build", env: buildEnv },
  );
  return dir;
};

const seedFixture = (worktree) => {
  const seedDir = join(workDir, "fixture");
  const seeder = join(
    worktree,
    "packages/scripts/src/commands/seed-perf-db.ts",
  );
  if (!existsSync(seeder))
    throw new Error("The base ref has no fixture seeder at " + seeder);
  run(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      seeder,
      "--reset",
      "--data-dir",
      seedDir,
      "--threads",
      values["fixture-threads"],
      "--events",
      values["fixture-events"],
      "--seed",
      "1",
    ],
    { cwd: worktree, logName: "seed", env: { NODE_ENV: "development" } },
  );
  return seedDir;
};

const worktrees = [];
const servers = [];
const cleanUp = async () => {
  for (const server of servers.splice(0)) await server.stop();
  if (values["keep-worktrees"]) return;
  for (const dir of worktrees.splice(0))
    spawnSync("git", ["worktree", "remove", "--force", dir], {
      cwd: REPO_ROOT,
    });
  rmSync(workDir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cleanUp().finally(() => process.exit(130));
  });

const startedAt = Date.now();
let exitCode = 0;
try {
  const head = resolveRef(values.head);
  const base = resolveRef(values.base ?? defaultBase(head.sha));
  log("base " + base.sha.slice(0, 9) + " " + base.subject);
  log("head " + head.sha.slice(0, 9) + " " + head.subject);
  if (base.sha === head.sha) log("base and head are the same commit (A/A)");

  const baseDir = prepareWorktree("base", base.sha);
  worktrees.push(baseDir);
  const headDir =
    base.sha === head.sha ? baseDir : prepareWorktree("head", head.sha);
  if (headDir !== baseDir) worktrees.push(headDir);

  const seedDir = seedFixture(baseDir);
  const variants = [
    ["base", baseDir],
    ["head", headDir],
  ];
  const urls = {};
  for (const [name, dir] of variants) {
    const dataDir = join(workDir, "data-" + name);
    cpSync(seedDir, dataDir, { recursive: true });
    const server = await startAppServer({
      dataDir,
      repoRoot: dir,
      env: buildEnv,
      logPath: join(logDir, name + "-server.log"),
      timeoutMs: 600_000,
    });
    servers.push(server);
    urls[name] = server.url;
    log(name + " server on " + server.url);
  }

  const [startThread] = await new AppApi(urls.base).rankSidebarThreads(40);
  if (!startThread) throw new Error("The fixture has no idle sidebar thread");
  log(
    "start thread " +
      startThread.id +
      " with " +
      startThread.eventCount +
      " events",
  );
  const report = await runAb({
    urls: { a: urls.base, b: urls.head },
    start: startThread.id,
    threadCount: Number(values.threads),
    menuCount: Number(values.menus),
    rounds: Number(values.rounds),
    cpuThrottle: Number(values["cpu-throttle"]),
    viewport: values.viewport,
    measureLoad: true,
    chrome: values.chrome,
    outDir,
    log,
  });
  printAbReport(report);

  const evaluation = evaluateBudgets(report, budgets);
  const markdown = renderMarkdown({ evaluation, base, head, report });
  writeFileSync(join(outDir, "summary.md"), markdown);
  writeFileSync(
    join(outDir, "regression.json"),
    JSON.stringify(
      {
        verdict: evaluation.verdict,
        base,
        head,
        rounds: report.rounds,
        cpuThrottle: report.cpuThrottle,
        startThread: { id: startThread.id, events: startThread.eventCount },
        durationMs: Date.now() - startedAt,
        budgets,
        rows: evaluation.rows,
        warnings: evaluation.warnings,
        inconclusive: evaluation.inconclusive,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log("\n" + markdown);
  console.log(
    "Artifacts: " +
      join(outDir, "summary.md") +
      ", " +
      join(outDir, "regression.json") +
      ", " +
      join(outDir, "ab.json"),
  );
  log(
    evaluation.verdict +
      " after " +
      Math.round((Date.now() - startedAt) / 1000) +
      " s",
  );
  exitCode = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 }[evaluation.verdict];
} catch (error) {
  console.error(error.stack ?? String(error));
  exitCode = 2;
} finally {
  await cleanUp();
}
process.exit(exitCode);
