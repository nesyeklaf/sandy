/**
 * Writes the frozen 24-snapshot suite of the kept-history cap probe to test/fixtures/kept-cap/:
 * `node --experimental-strip-types tools/make-kept-cap-fixtures.ts [dir]`. Deterministic: the same code writes the same
 * bytes. A snapshot is the log of a session at a cut: its entries (text shortened, tokens as estimated for the real
 * text), where the baseline cut keeps history from, and the ids of removed entries the later work asked for.
 * After the suite is frozen, the digest this prints goes into KEPT_CAP_SUITE_DIGEST and the files never change; a
 * different suite is a new probe.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestText, KEPT_CAP_SNAPSHOT_IDS, suiteDigest } from "../src/core/kept-cap-probe.ts";
import type { LogEntry } from "../src/core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "..", "test", "fixtures", "kept-cap");

/** mulberry32: a small seeded generator, so the suite is the same on every machine. */
function random(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Shape = "within-cap" | "overshoot" | "atomic-tail";
/** 8 snapshots whose kept range fits the cap, 12 that overshoot it, 4 whose newest round alone is larger than it. */
const shapeOf = (index: number): Shape => (index < 8 ? "within-cap" : index < 20 ? "overshoot" : "atomic-tail");

function snapshot(index: number) {
	const next = random(1000 + index);
	const between = (low: number, high: number) => Math.round(low + next() * (high - low));
	const shape = shapeOf(index);
	const entries: LogEntry[] = [];
	let clock = Date.UTC(2026, 9, 1, 9, 0, 0) + index * 86_400_000;
	let counter = 0;
	const add = (kind: LogEntry["kind"], text: string, tokens: number, extra: { path?: string; tool?: string } = {}): string => {
		const id = "e" + String(++counter).padStart(3, "0");
		clock += 45_000;
		const toolCalls = extra.path ? [{ id: "c" + counter, name: "read", args: { path: extra.path } }] : [];
		entries.push({ id, kind, timestamp: clock, text, toolCalls, ...(extra.tool ? { toolName: extra.tool } : {}), tokens });
		return id;
	};
	const round = (n: number, resultTokens: number): string[] => {
		const path = "src/module-" + n + ".ts";
		return [
			add("user", "Look at " + path + " and report what it does (task " + n + ").", between(20, 60)),
			add("assistant", "Reading " + path + ".", between(15, 40), { path }),
			add("tool", "contents of " + path, resultTokens, { tool: "read" }),
			add("assistant", path + " does the thing for task " + n + ".", between(40, 200)),
		];
	};
	// Earlier history the baseline cut already masks away.
	for (let n = 0; n < between(2, 5); n++) round(100 + n, between(500, 3000));
	const keptIndex = entries.length;
	const kept: string[][] = [];
	if (shape === "within-cap") {
		for (let n = 0; n < between(3, 6); n++) kept.push(round(n, between(600, 1800)));
	} else if (shape === "overshoot") {
		// The lookup for the start of the turn reached back over large rounds: far more than the cap.
		const first = round(0, between(6000, 9000));
		kept.push(first);
		for (let n = 1; n < between(5, 9); n++) kept.push(round(n, between(1200, 2800)));
	} else {
		kept.push(round(0, between(2500, 4000)));
		kept.push(round(1, between(18000, 24000)));
	}
	// What the later work asked for: a few tool results of the removed rounds, in half of the overshoot snapshots.
	const removedResults = kept.flatMap((one) => (one[2] ? [one[2]] : []));
	const laterReads = shape === "overshoot" && index % 2 === 0 ? removedResults.slice(0, 1 + (index % 3)) : [];
	return { id: KEPT_CAP_SNAPSHOT_IDS[index] as string, shape, keptIndex, laterReads, entries };
}

mkdirSync(out, { recursive: true });
const manifest: { id: string; file: string; digest: string }[] = [];
for (let index = 0; index < KEPT_CAP_SNAPSHOT_IDS.length; index++) {
	const one = snapshot(index);
	const text = JSON.stringify(one, null, "\t") + "\n";
	const file = one.id + ".json";
	writeFileSync(join(out, file), text);
	manifest.push({ id: one.id, file, digest: digestText(text) });
}
const suite = suiteDigest(manifest);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ suite, snapshots: manifest }, null, "\t") + "\n");
console.log("wrote " + manifest.length + " snapshots to " + out + "\nKEPT_CAP_SUITE_DIGEST = " + suite);
