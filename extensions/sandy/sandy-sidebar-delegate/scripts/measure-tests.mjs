import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} needs a positive integer`);
  return value;
}
const runs = option("--runs", 3);
const workers = args.includes("--load") ? option("--load-workers", availableParallelism()) : 0;
const directory = await mkdtemp(join(tmpdir(), "sb11-tests-"));
const burners = [];
let activeTest;
function stop() {
  for (const burner of burners) burner.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    activeTest?.kill(signal);
    stop();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}
const results = [];
console.log(`Measuring ${runs} runs with ${workers} busy Node processes; logs: ${directory}`);
try {
  for (let index = 0; index < workers; index++) {
    burners.push(spawn(process.execPath, ["-e", "for (;;) { Math.sqrt(Math.random()); }"], { stdio: "ignore" }));
  }
  for (let index = 1; index <= runs && !process.exitCode; index++) {
    const jsonPath = join(directory, `run-${index}.json`);
    const log = createWriteStream(join(directory, `run-${index}.log`));
    const start = performance.now();
    const exitCode = await new Promise((resolve, reject) => {
      activeTest = spawn("npm", [
        "test",
        "--",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${jsonPath}`,
      ]);
      activeTest.stdout.pipe(log, { end: false });
      activeTest.stderr.pipe(log, { end: false });
      activeTest.once("error", reject);
      activeTest.once("close", resolve);
    });
    log.end();
    activeTest = undefined;
    const seconds = (performance.now() - start) / 1000;
    let report;
    try {
      report = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch {
      // A startup error or killed worker can prevent Vitest writing its report.
    }
    const result = {
      run: index,
      seconds: Number(seconds.toFixed(2)),
      exitCode,
      passed: report?.numPassedTests ?? null,
      failed: report?.numFailedTests ?? null,
      success: exitCode === 0 && report?.success === true,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  stop();
}
await writeFile(join(directory, "summary.json"), JSON.stringify({ workers, results }, null, 2));
// Finish every requested run so an intermittent failure cannot hide behind a rerun.
if (results.length !== runs || results.some((result) => !result.success)) process.exitCode = 1;
