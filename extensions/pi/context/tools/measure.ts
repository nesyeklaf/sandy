/**
 * Before/after numbers for per-task cuts: `npm run measure -- [days=7] [dir=~/.sandy/pi-bridge-sessions]`.
 * Reads pi session logs changed in the last days and prints JSON totals.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { measureSession, totals } from "../src/core/measure.ts";

const days = Number(process.argv[2] ?? 7);
const dir = process.argv[3] ?? join(homedir(), ".sandy", "pi-bridge-sessions");
const since = Date.now() - days * 24 * 3600 * 1000;
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => join(dir, f))
	.filter((f) => statSync(f).mtimeMs >= since);
const t = totals(files.map((f) => measureSession(readFileSync(f, "utf8").split("\n"))));
const median = (xs: number[]) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
const { taskSpans, ...rest } = t;
console.log(JSON.stringify({ days, dir, ...rest, cost: Math.round(t.cost * 100) / 100, cacheHit: Math.round(t.cacheHit * 1000) / 1000, promptPerRequest: Math.round(t.promptPerRequest), tasks: taskSpans.length, promptPerTaskMedian: median(taskSpans) }, null, 2));
