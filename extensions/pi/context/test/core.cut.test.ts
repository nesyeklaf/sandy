import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { CutFold, type CutInput, type CutPlan, FilesFold, filesTouched, planCut } from "../src/core/cut.ts";
import { ChunkFold, historianDelta, historianPrompt, selectChunk } from "../src/core/historian.ts";
import { mergeSummary } from "../src/core/summary.ts";
import { estimateBudget } from "../src/core/tokens.ts";
import { newestFirstPages } from "../src/core/tools.ts";
import type { LogEntry } from "../src/core/types.ts";
import { entry, session } from "./helpers.ts";
import { small } from "./support/core.ts";

describe("historian chunk selection", () => {
	it("waits until enough archivable history has accumulated", () => {
		assert.equal(selectChunk(session(4), undefined, small), undefined);
	});

	it("leaves the tail that the next cut keeps and never splits a call from its result", () => {
		const entries = session(12);
		const chunk = selectChunk(entries, undefined, small);
		assert.ok(chunk);
		assert.equal(chunk.entries[0]?.id, "u0");
		assert.ok(chunk.tokens >= small.historian.chunkMinTokens);
		const stop = entries.findIndex((e) => e.id === chunk.throughId) + 1;
		assert.notEqual(entries[stop]?.kind, "tool");
		const tail = entries.slice(stop).reduce((sum, e) => sum + e.tokens, 0);
		assert.ok(tail >= small.keepRecentTokens + small.maskedTokens);
		assert.match(historianPrompt(chunk, undefined), /<existing-summary>\n\(none yet\)[\s\S]*\[#t0 read\]/);
	});

	it("turns the topic into a chapter with the stretch's entry range", () => {
		const chunk = selectChunk(session(12), undefined, small);
		assert.ok(chunk);
		const range = `(#u0 … #${chunk.throughId})`;
		assert.deepEqual(historianDelta("## Topic\n- Reading the modules (#u0)\n## Facts\n- x (#t0)", chunk).chapters, [
			`Reading the modules ${range}`,
		]);
		assert.deepEqual(historianDelta("## Facts\n- x (#t0)", chunk).chapters, [`Untitled stretch ${range}`]);
	});

	it("continues after the summary and respects the floor", () => {
		const entries = session(20);
		const summary = mergeSummary(undefined, { goal: ["g"] }, "r2");
		assert.equal(selectChunk(entries, summary, small)?.entries[0]?.id, "u3");
		assert.equal(selectChunk(entries, undefined, small, 8)?.entries[0]?.id, "u2");
	});

	it("chooses the same stretch from pages read newest first and stops at the summary's anchor", () => {
		const entries = session(40, 400);
		const summary = mergeSummary(undefined, { goal: ["g"] }, "r9");
		const whole = selectChunk(entries, summary, small);
		assert.ok(whole);
		for (const size of [1, 3, 7, 64]) {
			const fold = new ChunkFold({ config: small, afterId: "r9" });
			let read = 0;
			for (const page of newestFirstPages(entries, size)) {
				read += page.length;
				if (fold.add(page)) break;
			}
			assert.deepEqual(fold.finish(), whole, `pages of ${size}`);
			// It reads up to the anchor and no older entry, a page at most past it.
			assert.ok(read <= entries.length - entries.findIndex((e) => e.id === "r9") + size - 1, `pages of ${size}`);
		}
		const floor = new ChunkFold({ config: small, fromId: "u20" });
		assert.equal(floor.add([...entries].reverse()), true);
		assert.equal(floor.finish()?.entries[0]?.id, "u20");
	});
});

describe("cut planning", () => {
	const entries = session(12);
	const input = { entries, minKeptIndex: 0, visibleFromIndex: 0, config: small, reason: "watermark" };

	it("keeps recent history from the user message that opened the turn and is deterministic", () => {
		const plan = planCut(input);
		assert.ok(plan);
		const kept = entries.findIndex((e) => e.id === plan.firstKeptEntryId);
		assert.equal(entries[kept]?.kind, "user");
		const tail = entries.slice(kept).reduce((sum, e) => sum + e.tokens, 0);
		// keepRecentTokens is in provider tokens; the kept history is counted in estimated ones.
		assert.ok(tail >= estimateBudget(small.keepRecentTokens));
		assert.deepEqual(planCut(input), plan);
	});

	it("renders notebook, pins, summary, files, gap and masked tier", () => {
		const tight = resolveConfig(small, { maskedTokens: 200, pinnedUserTokens: 40 });
		const summary = mergeSummary(undefined, { goal: ["Learn all facts (#u0)"] }, "r1");
		const plan = planCut({ ...input, config: tight, summary, notebook: "Plan: read every module." });
		assert.ok(plan);
		const { text, details } = plan;
		assert.match(text, /## Your notebook\nPlan: read every module\./);
		assert.match(text, /## Earlier user messages, verbatim\n\(\d+ older user messages not shown/);
		assert.match(
			text,
			/## Summary of older work \(through #r1\)\n### Goal and how it changed\n- Learn all facts \(#u0\)/,
		);
		assert.match(text, /## Files\nRead: src\/module-11\.ts, src\/module-10\.ts/);
		assert.match(text, /## Archived without summary\n#u2 … #\w+ \(\d+ entries\)/);
		assert.match(
			text,
			/## Recent work, tool output archived\n[\s\S]*\[#t\d+ ← read\] \d+ tokens archived: export const fact/,
		);
		assert.equal(details.summaryThroughId, "r1");
		assert.equal(details.unsummarized?.fromId, "u2");
		assert.ok(text.length / 4 < small.watermarkTokens / 2);
	});

	it("archives nothing twice and never keeps across the latest compaction", () => {
		const plan = planCut(input);
		assert.ok(plan);
		const kept = entries.findIndex((e) => e.id === plan.firstKeptEntryId);
		assert.equal(planCut({ ...input, minKeptIndex: kept, visibleFromIndex: kept }), undefined);
		const later = planCut({ ...input, minKeptIndex: entries.length - 2, visibleFromIndex: 4 });
		assert.equal(later?.firstKeptEntryId, entries[entries.length - 1]?.id);
		const toolFirst = planCut({ ...input, minKeptIndex: entries.length - 2, visibleFromIndex: 4 });
		assert.notEqual(entries.find((e) => e.id === toolFirst?.firstKeptEntryId)?.kind, "tool");
		assert.equal(planCut({ ...input, entries: session(1) }), undefined);
	});

	it("lists modified files before reads and newest first", () => {
		const touched = filesTouched(
			[
				entry("a", "assistant", "", { toolCalls: [{ id: "1", name: "read", args: { path: "a.ts" } }] }),
				entry("b", "assistant", "", { toolCalls: [{ id: "2", name: "edit", args: { path: "a.ts" } }] }),
				entry("c", "assistant", "", { toolCalls: [{ id: "3", name: "read", args: { path: "b.ts" } }] }),
			],
			10,
		);
		assert.deepEqual(touched, { modified: ["a.ts"], read: ["b.ts"] });
	});

	it("writes the reason in the opening tag and names no ID format", () => {
		const plan = planCut({ ...input, reason: "cold" });
		assert.ok(plan);
		assert.ok(plan.text.startsWith('<sandy-context reason="cold">\n'), plan.text.slice(0, 40));
		assert.equal(plan.details.reason, "cold");
		assert.doesNotMatch(plan.text, /ids look like/i);
		assert.throws(() => planCut({ ...input, reason: 'cold"><x' }), /cut reason/);
	});

	it("keeps from the entry the caller chose and archives nothing it archived before", () => {
		const chosen = entries[20];
		assert.ok(chosen);
		const plan = planCut({ ...input, keptFromId: chosen.id });
		assert.equal(plan?.firstKeptEntryId, chosen.id);
		assert.equal(plan?.details.archivedEntries, 20);
		assert.match(plan?.text ?? "", /\[#r4 assistant\] fact-4 is value-4\.\n\n<\/sandy-context>/);
		assert.equal(planCut({ ...input, keptFromId: "missing" }), undefined);
		assert.equal(planCut({ ...input, keptFromId: entries[0]?.id }), undefined, "nothing older to archive");
		assert.equal(planCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 20 }), undefined, "visible already");
		assert.equal(planCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 24 }), undefined, "older than visible");
		assert.equal(planCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 16 })?.firstKeptEntryId, chosen.id);
	});

	/** The fold fed the log newest first in pages of `size`, with the latest compaction between the pages it falls in. */
	function inPages(cut: CutInput, size: number): CutPlan | undefined {
		const fold = new CutFold({ ...cut, visibleFromId: cut.entries[cut.visibleFromIndex]?.id });
		const stream: (LogEntry | "compaction")[] = [...cut.entries].reverse();
		if (cut.minKeptIndex > 0) stream.splice(cut.entries.length - cut.minKeptIndex, 0, "compaction");
		for (let at = 0; at < stream.length; at += size) {
			let run: LogEntry[] = [];
			for (const item of stream.slice(at, at + size)) {
				if (item !== "compaction") {
					run.push(item);
					continue;
				}
				fold.add(run);
				run = [];
				fold.compaction();
			}
			fold.add(run);
		}
		return fold.finish();
	}

	/** A long session that edits and reads files, runs tools that fail and leaves notes. */
	function longLog(count: number): LogEntry[] {
		const log: LogEntry[] = [];
		for (let turn = 0; log.length < count; turn++) {
			const path = `src/f${(turn * 7) % 37}.ts`;
			const name = turn % 3 === 0 ? "edit" : turn % 5 === 0 ? "write" : "read";
			log.push(entry(`u${turn}`, "user", `Turn ${turn}: change ${path} and keep fact-${turn}.`));
			log.push(
				entry(`a${turn}`, "assistant", `Working on ${path}.`, {
					toolCalls: [{ id: `c${turn}`, name, args: { path } }],
				}),
			);
			log.push(
				entry(`t${turn}`, "tool", `${name} ${path}\n${"y".repeat(40 + (turn % 50) * 30)}`, {
					toolName: name,
					isError: turn % 11 === 0,
				}),
			);
			if (turn % 4 === 0) log.push(entry(`n${turn}`, "custom", `note ${turn}`));
			log.push(entry(`r${turn}`, "assistant", `Done with turn ${turn}.`));
		}
		return log.slice(0, count);
	}

	it("plans the same cut from pages newest first as from the whole log", () => {
		const summary = mergeSummary(undefined, { goal: ["Learn all facts (#u0)"] }, "r1");
		const tight = resolveConfig(small, { maskedTokens: 200, pinnedUserTokens: 40 });
		const ported: CutInput[] = [
			input,
			{ ...input, config: tight, summary, notebook: "Plan: read every module." },
			{ ...input, minKeptIndex: 36, visibleFromIndex: 36 },
			{ ...input, minKeptIndex: entries.length - 2, visibleFromIndex: 4 },
			{ ...input, entries: session(1) },
			{ ...input, keptFromId: "u5" },
		];
		const long = longLog(10_000);
		const generated: CutInput[] = [
			{ ...input, entries: long },
			{
				...input,
				entries: long,
				summary: mergeSummary(undefined, { goal: ["Change every file (#u0)"] }, "r2100"),
				notebook: "Plan: change every file.",
				minKeptIndex: 9_990,
				visibleFromIndex: 9_960,
			},
			{
				...input,
				entries: long,
				summary: mergeSummary(undefined, { goal: ["g"] }, long[9_995]?.id ?? ""),
				reason: "cold",
			},
			{ ...input, entries: long, minKeptIndex: 9_999, visibleFromIndex: 9_999 },
			{ ...input, entries: long, keptFromId: "u2000", visibleFromIndex: 7_000 },
		];
		for (const cut of [...ported, ...generated]) {
			const whole = planCut(cut);
			for (const size of [1, 7, 256]) assert.deepEqual(inPages(cut, size), whole, `page size ${size}`);
		}
		assert.ok(generated.slice(0, 2).every((cut) => planCut(cut)?.details.unsummarized !== undefined));
		const anchoredInKept = planCut(generated[2] as CutInput)?.details;
		assert.equal(anchoredInKept?.summaryThroughId, long[9_995]?.id, "a summary anchored in the kept range");
		assert.equal(anchoredInKept?.maskedFromId, undefined, "masks nothing the summary covers");
		assert.equal(planCut(generated[3] as CutInput), undefined);
	});

	it("lists files from a bounded fold", () => {
		const call = (id: string, name: string, path: string) =>
			entry(id, "assistant", "", { toolCalls: [{ id, name, args: { path } }] });
		const critic = [call("1", "edit", "a"), call("2", "edit", "c"), call("3", "read", "b"), call("4", "read", "a")];
		assert.deepEqual(filesTouched(critic, 1), { modified: ["c"], read: ["a"] });

		const listed = 3;
		const history = Array.from({ length: 120 }, (_, i) =>
			call(`h${i}`, ["read", "edit", "read", "write", "read"][(i * 7) % 5] ?? "read", `p${(i * 13) % (10 * listed)}`),
		);
		const newest = (names: string[]) => [
			...new Set(
				[...history]
					.reverse()
					.flatMap((e) => e.toolCalls)
					.filter((c) => names.includes(c.name))
					.map((c) => (c.args as { path: string }).path),
			),
		];
		const modified = newest(["edit", "write"]).slice(0, listed);
		const read = newest(["read"])
			.slice(0, 2 * listed)
			.filter((path) => !modified.includes(path))
			.slice(0, listed);
		assert.equal(read.length, listed);
		assert.deepEqual(filesTouched(history, listed), { modified, read });
		for (const size of [1, 7]) {
			const fold = new FilesFold(listed);
			const newestFirst = [...history].reverse();
			for (let at = 0; at < newestFirst.length; at += size) {
				fold.add(newestFirst.slice(at, at + size));
				assert.ok(fold.held <= 3 * listed, `holds ${fold.held} paths`);
			}
			assert.deepEqual(fold.result(), { modified, read });
		}
	});
});
