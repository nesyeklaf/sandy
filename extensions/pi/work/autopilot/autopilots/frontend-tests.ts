/**
 * Frontend test autopilot: the file's tests drive a real Chromium through Playwright, so the autopilot first checks that the
 * browser is installed, then measures. Result: the measurement plus what the browser setup looked like.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { measure, parseArgs } from "./lib/measure.ts";

export default async function frontendTests(args: unknown) {
	const { repo, file } = parseArgs(args);
	const cache = join(homedir(), ".cache", "ms-playwright");
	const browsers = existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith("chromium")) : [];
	if (browsers.length === 0) return { kind: "frontend", error: "no Playwright Chromium; run bun x playwright install chromium-headless-shell" };
	return { kind: "frontend", runner: "vitest + playwright chromium", browsers, ...(await measure(repo, file)) };
}
