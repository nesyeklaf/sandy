import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import {
	CutFold,
	type CutFrame,
	type CutInput,
	type CutPlan,
	cutKey,
	FilesFold,
	filesTouched,
	foldCut,
	planCut,
} from "../src/core/cut.ts";
import { type CutEnvelope, nativeLimit } from "../src/core/policy.ts";
import { mergeSummary } from "../src/core/summary.ts";
import { estimateBudget, estimateTokens } from "../src/core/tokens.ts";
import type { LogEntry } from "../src/core/types.ts";
import { entry, session } from "./helpers.ts";
import { small } from "./support/core.ts";

describe("cut planning", () => {
	const entries = session(12);
	const input = { entries, minKeptIndex: 0, visibleFromIndex: 0, config: small, reason: "watermark" };

	it("keeps recent history from the user message that opened the turn and is deterministic", () => {
		const plan = foldCut(input);
		assert.ok(plan);
		const kept = entries.findIndex((e) => e.id === plan.firstKeptEntryId);
		assert.equal(entries[kept]?.kind, "user");
		const tail = entries.slice(kept).reduce((sum, e) => sum + e.tokens, 0);
		// keepRecentTokens is in provider tokens; the kept history is counted in estimated ones.
		assert.ok(tail >= estimateBudget(small.keepRecentTokens));
		assert.deepEqual(foldCut(input), plan);
	});

	it("renders notebook, pins, summary, files, gap and masked tier", () => {
		const tight = resolveConfig(small, { maskedTokens: 200, pinnedUserTokens: 40 });
		const summary = mergeSummary(undefined, { goal: ["Learn all facts (#u0)"] }, "r1");
		const plan = foldCut({ ...input, config: tight, summary, notebook: "Plan: read every module." });
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

	it("carries a foreign checkpoint verbatim before the summary and says when it is stale", () => {
		const tight = resolveConfig(small, { maskedTokens: 200, pinnedUserTokens: 40 });
		const summary = mergeSummary(undefined, { goal: ["Learn all facts (#u0)"] }, "r1");
		const text = "FOREIGN-SUMMARY of another compaction\n## Goal\n- keep this line exactly";
		const checkpoint = { id: "c0", owner: "foreign", text, status: "current" } as const;
		const plan = foldCut({ ...input, config: tight, summary, checkpoint });
		assert.ok(plan);
		const section = `## Earlier summary from another compaction, verbatim (#c0)\n${text}\n\n`;
		assert.ok(plan.text.includes(section), plan.text);
		assert.ok(plan.text.indexOf(section) < plan.text.indexOf("## Summary of older work"));
		assert.ok(!plan.text.includes("Stale:"));
		assert.equal(plan.details.blockTokens, estimateTokens(plan.text), "counted like every other section");

		const stale = foldCut({ ...input, config: tight, summary, checkpoint: { ...checkpoint, status: "stale" } });
		assert.ok(stale);
		assert.match(stale.text, /verbatim \(#c0\)\nStale: [^\n]+\nFOREIGN-SUMMARY of another compaction\n## Goal\n- keep this line exactly\n/);
		assert.equal(stale.text.match(/Stale:/g)?.length, 1, "one warning line");
	});

	it("archives nothing twice and never keeps across the latest compaction", () => {
		const plan = foldCut(input);
		assert.ok(plan);
		const kept = entries.findIndex((e) => e.id === plan.firstKeptEntryId);
		assert.equal(foldCut({ ...input, minKeptIndex: kept, visibleFromIndex: kept }), undefined);
		const later = foldCut({ ...input, minKeptIndex: entries.length - 2, visibleFromIndex: 4 });
		assert.equal(later?.firstKeptEntryId, entries[entries.length - 1]?.id);
		const toolFirst = foldCut({ ...input, minKeptIndex: entries.length - 2, visibleFromIndex: 4 });
		assert.notEqual(entries.find((e) => e.id === toolFirst?.firstKeptEntryId)?.kind, "tool");
		assert.equal(foldCut({ ...input, entries: session(1) }), undefined);
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
		const plan = foldCut({ ...input, reason: "cold" });
		assert.ok(plan);
		assert.ok(plan.text.startsWith('<context reason="cold">\n'), plan.text.slice(0, 40));
		assert.equal(plan.details.reason, "cold");
		assert.doesNotMatch(plan.text, /ids look like/i);
		assert.throws(() => foldCut({ ...input, reason: 'cold"><x' }), /cut reason/);
	});

	it("keeps from the entry the caller chose and archives nothing it archived before", () => {
		const chosen = entries[20];
		assert.ok(chosen);
		const plan = foldCut({ ...input, keptFromId: chosen.id });
		assert.equal(plan?.firstKeptEntryId, chosen.id);
		assert.equal(plan?.details.archivedEntries, 20);
		assert.match(plan?.text ?? "", /\[#r4 assistant\] fact-4 is value-4\.\n\n<\/context>/);
		assert.equal(foldCut({ ...input, keptFromId: "missing" }), undefined);
		assert.equal(foldCut({ ...input, keptFromId: entries[0]?.id }), undefined, "nothing older to archive");
		assert.equal(foldCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 20 }), undefined, "visible already");
		assert.equal(foldCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 24 }), undefined, "older than visible");
		assert.equal(foldCut({ ...input, keptFromId: chosen.id, visibleFromIndex: 16 })?.firstKeptEntryId, chosen.id);
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
			const whole = foldCut(cut);
			for (const size of [1, 7, 256]) assert.deepEqual(inPages(cut, size), whole, `page size ${size}`);
		}
		assert.ok(generated.slice(0, 2).every((cut) => foldCut(cut)?.details.unsummarized !== undefined));
		const anchoredInKept = foldCut(generated[2] as CutInput)?.details;
		assert.equal(anchoredInKept?.summaryThroughId, long[9_995]?.id, "a summary anchored in the kept range");
		assert.equal(anchoredInKept?.maskedFromId, undefined, "masks nothing the summary covers");
		assert.equal(foldCut(generated[3] as CutInput), undefined);
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

describe("cut decisions in the envelope", () => {
	const entries = session(12);
	const visibleTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
	const frame = {
		entries,
		minKeptIndex: 0,
		visibleFromIndex: 0,
		config: small,
		reason: "watermark",
		contextTokens: Math.round(visibleTokens * 1.25),
		visibleTokens,
		limit: small.watermarkTokens,
		hard: 2 * small.watermarkTokens,
	} satisfies CutFrame;
	const roomy = { fixedTokens: 2_000, reserveTokens: 16_384, contextWindow: 200_000 } satisfies CutEnvelope;

	it("is ready when the cut leaves the prompt below its limit with system prompt and tools counted", () => {
		const decision = planCut(frame, roomy);
		assert.equal(decision.kind, "ready");
		assert.ok(decision.kind === "ready");
		assert.deepEqual(decision.plan, foldCut(frame));
		assert.ok(decision.expected >= roomy.fixedTokens + decision.plan.details.blockTokens);
		assert.ok(decision.expected < frame.limit);
		assert.equal(decision.key, cutKey(decision.plan));
	});

	it("defers a cut that would not reach its limit because the system prompt and tools fill it", () => {
		const decision = planCut(frame, { ...roomy, fixedTokens: small.watermarkTokens });
		assert.equal(decision.kind, "defer");
		assert.ok(decision.kind === "defer" && decision.why === "short");
		assert.ok(decision.expected >= small.watermarkTokens);
	});

	it("disables the cut when what it keeps does not fit below pi's own compaction", () => {
		const tight = { fixedTokens: 26_000, reserveTokens: 4_000, contextWindow: 30_000 } satisfies CutEnvelope;
		const decision = planCut({ ...frame, limit: undefined }, tight);
		assert.equal(decision.kind, "disabled");
		assert.ok(decision.kind === "disabled" && decision.why === "no-room");
		assert.ok((decision.expected ?? 0) >= nativeLimit(tight));
	});

	it("does not repeat the cut the next request refuted, and makes the next different one", () => {
		const first = planCut(frame, roomy);
		assert.ok(first.kind === "ready");
		const again = planCut({ ...frame, failedKey: first.key }, roomy);
		assert.equal(again.kind, "defer");
		assert.ok(again.kind === "defer" && again.why === "repeat");
		const grown = session(14);
		const later = planCut({ ...frame, entries: grown, failedKey: first.key }, roomy);
		assert.equal(later.kind, "ready", "more history makes a different cut");
	});

	it("has nothing to decide when nothing can be archived", () => {
		assert.deepEqual(planCut({ ...frame, entries: session(1) }, roomy), { kind: "disabled", why: "empty" });
	});

	it("judges a cut without a provider count by its scaled estimate alone", () => {
		const decision = planCut({ ...frame, contextTokens: undefined }, roomy);
		assert.equal(decision.kind, "ready");
	});
});
