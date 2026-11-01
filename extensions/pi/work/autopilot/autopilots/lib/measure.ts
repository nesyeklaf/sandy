/**
 * Shared measuring step of the test autopilots: run one Vitest file in a repo with the JSON reporter and return pass/fail
 * counts, wall time and the slowest tests. Code decides everything here; no model is involved.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Measurement = {
	repo: string;
	file: string;
	exitCode: number;
	passed: number;
	failed: number;
	wallMs: number;
	testsMs: number;
	slowest: Array<{ name: string; ms: number }>;
};

export function parseArgs(args: unknown): { repo: string; file: string } {
	const [repo, file] = typeof args === "string" ? args.trim().split(/\s+/) : [(args as any).repo, (args as any).file];
	if (!repo || !file) throw new Error("args: '<repo> <test file>'");
	if (!repo.startsWith("/tmp/")) throw new Error(`refusing to run outside /tmp: ${repo}`);
	return { repo, file };
}

export function measure(repo: string, file: string): Promise<Measurement> {
	const out = join(mkdtempSync(join(tmpdir(), "autopilot-")), "vitest.json");
	const started = Date.now();
	return new Promise((resolve) => {
		execFile(
			"bun",
			["vp", "test", "run", file, "--reporter=json", `--outputFile=${out}`],
			{ cwd: repo, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
			(error) => {
				const wallMs = Date.now() - started;
				let report: any = { testResults: [] };
				try {
					report = JSON.parse(readFileSync(out, "utf8"));
				} catch {}
				const tests = report.testResults.flatMap((suite: any) => suite.assertionResults ?? []);
				resolve({
					repo,
					file,
					exitCode: error ? ((error as any).code ?? 1) : 0,
					passed: tests.filter((t: any) => t.status === "passed").length,
					failed: tests.filter((t: any) => t.status === "failed").length,
					wallMs,
					testsMs: Math.round(tests.reduce((sum: number, t: any) => sum + (t.duration ?? 0), 0)),
					slowest: tests
						.map((t: any) => ({ name: t.fullName, ms: Math.round(t.duration ?? 0) }))
						.sort((a: any, b: any) => b.ms - a.ms)
						.slice(0, 5),
				});
			},
		);
	});
}
