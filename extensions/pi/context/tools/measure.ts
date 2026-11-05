/**
 * Before/after numbers for per-task cuts: `npm run measure -- [days=7] [dir=~/.sandy/pi-bridge-sessions]`.
 * Reads pi session logs changed in the last days and prints JSON totals, then the report `/context` prints.
 * The cost is the cost report's: every source, each request once, unknown when a request left no usage. `main` is the
 * older series of the main model's answers only, without cost.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSessionsReport, reportSessions } from "../src/core/measure.ts";

const days = Number(process.argv[2] ?? 7);
const dir = process.argv[3] ?? join(homedir(), ".sandy", "pi-bridge-sessions");
const since = Date.now() - days * 24 * 3600 * 1000;
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => join(dir, f))
	.filter((f) => statSync(f).mtimeMs >= since);
const median = (xs: number[]) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
/** A fixture marks the entries its agent needed in a hidden sidecar, `<session>.labels.json` = `{ "needed": ["id", …] }`. */
const needed = (file: string): string[] | undefined => {
	const sidecar = file.replace(/\.jsonl$/, ".labels.json");
	return existsSync(sidecar) ? (JSON.parse(readFileSync(sidecar, "utf8")) as { needed: string[] }).needed : undefined;
};
const report = reportSessions(
	files.map((file) => {
		const labels = needed(file);
		return { path: file, lines: readFileSync(file, "utf8").split("\n"), ...(labels ? { needed: labels } : {}) };
	}),
);
const cents = (value: number | undefined) => (value === undefined ? null : Math.round(value * 100) / 100);
const { main, cost } = report;
console.log(
	JSON.stringify(
		{
			days,
			dir,
			files: files.length,
			sessions: main.sessions,
			cost: { total: cents(cost.total), knownSubtotal: cents(cost.knownSubtotal), complete: cost.complete, requests: cost.requests, unknown: cost.unknown, priceBasis: cost.priceBasis },
			main: { scope: "main model answers only, no cost", requests: main.requests, promptTokens: main.promptTokens, cacheRead: main.cacheRead, cacheHit: Math.round(main.cacheHit * 1000) / 1000, promptPerRequest: Math.round(main.promptPerRequest) },
			cuts: main.cuts,
			tasks: main.taskSpans.length,
			promptPerTaskMedian: median(main.taskSpans),
		},
		null,
		2,
	),
);
console.log("\n" + formatSessionsReport(report).join("\n"));
