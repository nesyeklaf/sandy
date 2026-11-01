/**
 * Backend test autopilot: plain Vitest on Bun, no browser. Result: the measurement.
 */
import { measure, parseArgs } from "./lib/measure.ts";

export default async function backendTests(args: unknown) {
	const { repo, file } = parseArgs(args);
	return { kind: "backend", runner: "vitest on bun", ...(await measure(repo, file)) };
}
