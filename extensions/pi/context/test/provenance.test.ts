import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/core/config.ts";
import { foldCut } from "../src/core/cut.ts";
import {
	commitSummary,
	completeSummary,
	evidenceBudget,
	type HistorianWork,
	selectEvidence,
	validateCompletion,
} from "../src/core/historian.ts";
import { SUMMARY_KIND } from "../src/core/kinds.ts";
import type { CommitResult } from "../src/core/historian.ts";
import { digestOf, entryDigest } from "../src/core/serialize.ts";
import { applyCondensed, emptySections, type SummaryState } from "../src/core/summary.ts";
import type { EffectiveHistory } from "../src/core/types.ts";
import { summarizeWith } from "../src/historian/model.ts";
import { HistorianLifecycle } from "../src/historian/run.ts";
import { CutController } from "../src/pi/cuts.ts";
import { SessionTape } from "../src/pi/session.ts";
import { attemptRecords, echo, harness, promptEntries, storedSummaries } from "./support/historian.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * Where a summary's items come from, and what happens to them when that source changes. Every session here is written
 * through pi's SessionManager and read back through the tape; the historian is the real lifecycle with a model that
 * copies every FACT or RULE line it is shown into a cited bullet.
 */

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
});
const budget = evidenceBudget(config, false);

const planFrom = (history: EffectiveHistory, competing = false) =>
	foldCut({
		competing,
		config,
		reason: "watermark",
		entries: history.entries,
		minKeptIndex: history.minKeptIndex,
		visibleFromIndex: history.visibleFromIndex,
		summary: history.summary,
		checkpoint: history.checkpoint,
		checkpointSuperseded: history.checkpointSuperseded,
		notebook: history.notebook,
	});
const summaryText = (history: EffectiveHistory) => JSON.stringify(history.summary ?? null);
const prompts = (run: { requests: readonly { prompt: string }[] }) => run.requests.map((request) => request.prompt).join("\n");

/** Eight turns, summarized by the historian as far as the next cut would archive them. */
async function summarizedSession() {
	const log = sessionLog();
	const turns = ["a", "b", "c", "d", "e", "f", "g", "h"].map((label) => log.turn(label, 2_000));
	await harness(log, config).run();
	const history = log.tape().history();
	assert.ok(history.summary?.sections.facts.some((fact) => fact.includes("#" + turns[0]?.result)), "turn a is summarized");
	return { log, turns };
}

/** Commit the next cut as the extension does: a compaction of ours, kept from where the plan says. */
function cutNow(log: ReturnType<typeof sessionLog>) {
	const plan = planFrom(log.tape().history());
	assert.ok(plan, "a cut is due");
	log.ownCut(plan.firstKeptEntryId, plan.text);
	return plan;
}

describe("an edit that omits a source", () => {
	it("drops the items citing the omitted entry from the summary and the next cut", async () => {
		const { log, turns } = await summarizedSession();
		const omitted = turns[0]?.result as string;
		log.omit(omitted);

		const history = log.tape().history();
		assert.ok(!history.entries.some((entry) => entry.id === omitted), "the history no longer holds the entry");
		const citing = history.summary?.sections.facts.filter((fact) => fact.includes("#" + omitted)) ?? [];
		assert.deepEqual(citing, [], "no item that came from the omitted entry is trusted");
		assert.ok(!(planFrom(history)?.text ?? "").includes("FACT a holds."), "the next cut does not carry it");
	});

	it("drops the part of an entry summarized so far when an edit omits that entry", () => {
		const small = resolveConfig({ ...config, historian: { ...config.historian, chunkMinTokens: 50, chunkMaxTokens: 300 } });
		const log = sessionLog();
		log.user("Please read the big file.");
		const big = log.user("FACT big-entry-77 holds.\n" + "y".repeat(8_000));
		for (const label of ["a", "b", "c", "d"]) log.turn(label, 2_000);
		const work = selectEvidence(log.tape().history(), evidenceBudget(small, false), log.manager.getLeafId() ?? undefined) as HistorianWork;
		assert.equal(work.coverage.partial?.entryId, big, "the work ends inside the big entry");
		const valid = validateCompletion({ text: "## Facts and findings\n- FACT big-entry-77 holds (#" + big + ")" }, work);
		assert.ok(valid.ok);
		log.manager.appendCustomEntry(SUMMARY_KIND, { ...completeSummary(work, valid), projectedThroughId: work.readAt });
		assert.equal(log.tape().history().summary?.partial?.entryId, big);

		log.omit(big);
		const after = log.tape().history().summary;
		assert.equal(after?.partial, undefined, "the omitted entry is no longer summarized in part");
		assert.ok(!JSON.stringify(after).includes("big-entry-77"), "nor does an item from it stay");
	});
});

describe("a citation that ends a sentence", () => {
	it("is a source like any other: an edit of the cited entry drops the item", () => {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d", "e", "f"].map((label) => log.turn(label, 2_000));
		const work = selectEvidence(log.tape().history(), budget, log.manager.getLeafId() ?? undefined) as HistorianWork;
		const first = turns[0]?.result as string;
		// Stored as is, so this pins the invalidation on its own, apart from validating the answer.
		const valid = { ok: true as const, delta: { facts: ["FACT dotted-77 holds (#" + first + ")."] } };
		log.manager.appendCustomEntry(SUMMARY_KIND, { ...completeSummary(work, valid), projectedThroughId: work.readAt });
		assert.match(summaryText(log.tape().history()), /dotted-77/);

		log.replace(first, "FACT REPLACEMENT-FACT = release-code-88");
		const after = summaryText(log.tape().history());
		assert.doesNotMatch(after, /dotted-77/, "the item citing the edited entry is gone");
		assert.equal(log.tape().history().summary?.unsummarized?.length, 1, "and the stretch is summarized again");
	});
});

describe("a stretch summarized again after an omission", () => {
	/** Runs the historian until it is idle, failing the test past `cap` requests instead of paying forever. */
	async function repair(log: ReturnType<typeof sessionLog>, cap = 4) {
		let calls = 0;
		const run = harness(log, config, {
			answer: (request) => {
				if (++calls > cap) throw new Error("the historian asked again after " + cap + " requests");
				return echo(request.prompt);
			},
		});
		await run.run();
		assert.deepEqual(run.failures.map(String), [], "no request failed or was capped");
		return run;
	}

	/** Nothing is left to summarize and the summary no longer changes. */
	async function settled(log: ReturnType<typeof sessionLog>) {
		const history = log.tape().history();
		assert.equal(history.summary?.unsummarized, undefined, "no stretch waits to be summarized again");
		assert.equal(selectEvidence(history, budget, log.manager.getLeafId() ?? undefined), undefined, "no work remains");
		const stored = storedSummaries(log).length;
		const again = await repair(log);
		assert.equal(again.requests.length, 0, "a second run asks nothing");
		assert.equal(storedSummaries(log).length, stored, "and stores nothing");
		assert.equal(summaryText(log.tape().history()), summaryText(history), "the summary stays as it is");
		return history;
	}

	it("settles after one repair request when an edit omitted an entry inside it", async () => {
		const { log, turns } = await summarizedSession();
		log.omit(turns[0]?.result as string);

		const run = await repair(log);
		assert.equal(run.requests.length, 1, "one repair request, then idle");
		const history = await settled(log);
		assert.ok(!summaryText(history).includes("FACT a holds."), "the omitted entry stays out");
		assert.match(summaryText(history), /FACT b holds./, "what the omission did not touch is summarized again");
	});

	it("settles when an edit omitted an entry before the first summary", async () => {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d", "e", "f", "g", "h"].map((label) => log.turn(label, 2_000));
		log.omit(turns[2]?.result as string);

		const run = await repair(log);
		assert.ok(run.requests.length >= 1 && run.requests.length <= 2, "a bounded number of requests, got " + run.requests.length);
		const history = await settled(log);
		assert.ok(!summaryText(history).includes("FACT c holds."), "the omitted entry is never summarized");
		assert.match(summaryText(history), /FACT b holds./);
	});

	it("never repeats a stored summary of the same work without new input", async () => {
		const { log, turns } = await summarizedSession();
		log.omit(turns[0]?.result as string);
		let calls = 0;
		const run = harness(log, config, {
			answer: (request) => {
				// The answers resolve without a macrotask between them, so an unbounded loop would starve the test's timer.
				if (++calls > 3) throw new Error("asked again");
				return echo(request.prompt);
			},
		});
		const failures: unknown[] = [];
		const lifecycle = new HistorianLifecycle(config, { onError: (error) => failures.push(error) });
		// A writer that reports every summary stored but changes nothing: the next look finds the same work.
		const stored: CommitResult = { status: "stored" };
		lifecycle.start({ ...run.branch, write: () => stored }, 1);
		for (let turn = 0; turn < 2_000 && lifecycle.running > 0; turn++) await new Promise((resolve) => setImmediate(resolve));
		await lifecycle.shutdown("quit");
		assert.equal(run.requests.length, 1, "the same work is asked for once");
		assert.match(String(failures[0]), /unchanged after its summary was stored/);
		// The guard sends nothing, so the receipts hold the one paid request, ended stored, and no failure to count.
		const key = attemptRecords(log).findLast((record) => record.type === "start")?.key ?? "";
		const records = attemptRecords(log).filter((record) => record.type !== "retry" && record.key === key);
		assert.deepEqual(
			records.map((record) => (record.type === "end" ? record.outcome : record.type)),
			["start", "stored"],
		);
		assert.deepEqual(log.tape().state.attempts.get(key) ?? [], [], "nothing of this work is unfinished or failed");
	});
});

describe("an edit of a summarized stretch", () => {
	it("summarizes the stretch again from the history as it reads now, keeping what the edit did not touch", async () => {
		const { log, turns } = await summarizedSession();
		cutNow(log);
		log.replace(turns[0]?.result as string, "FACT REPLACEMENT-FACT = release-code-88");

		const rerun = harness(log, config);
		await rerun.run();
		assert.ok(rerun.requests.length > 0, "the historian is asked again");
		assert.match(prompts(rerun), /REPLACEMENT-FACT/, "it reads the replacement");
		const history = log.tape().history();
		assert.match(summaryText(history), /REPLACEMENT-FACT = release-code-88/, "the summary holds the replacement");
		assert.match(summaryText(history), /FACT b holds\./, "and what the edit did not touch");
		assert.ok(!summaryText(history).includes("FACT a holds."), "but not the old text");
	});

	it("marks the edited stretch unsummarized in the next cut until it is summarized again", async () => {
		const { log, turns } = await summarizedSession();
		cutNow(log);
		log.replace(turns[0]?.result as string, "FACT REPLACEMENT-FACT = release-code-88");
		for (const label of ["i", "j", "k", "l"]) log.turn(label, 2_000);

		const before = planFrom(log.tape().history());
		assert.ok(before, "a cut is due");
		assert.match(before.text, new RegExp("## Archived without summary\\n(.*\\n)*#" + turns[0]?.user + " … #\\w+ \\(\\d+ entries\\), edited after they were summarized"), "the cut names the hole");

		await harness(log, config).run();
		const after = planFrom(log.tape().history());
		assert.match(after?.text ?? "", /REPLACEMENT-FACT = release-code-88/, "the next cut carries the replacement");
		assert.doesNotMatch(after?.text ?? "", /edited after they were summarized/, "and no hole");
		assert.equal(log.tape().history().summary?.unsummarized, undefined);
	});

	it("shows the replacement next to the original in the archive", async () => {
		const { log, turns } = await summarizedSession();
		cutNow(log);
		const target = turns[0]?.result as string;
		log.replace(target, "FACT REPLACEMENT-ONLY = new-code-88");

		const archive = log.tape().archive();
		const page = await archive.read({ id: target });
		assert.equal(page.status, "replaced");
		assert.match(page.text, /FACT a holds\./, "the original");
		assert.match(page.text, /REPLACEMENT-ONLY = new-code-88/, "and what it reads as now");
		const found = await archive.search({ query: "REPLACEMENT-ONLY" });
		assert.deepEqual(found.hits, [target]);
	});
});

describe("a condensed summary", () => {
	it("keeps the originals when a shorter condensed item drops an entry inside a range they cite", () => {
		const log = sessionLog();
		const a = log.user("old a");
		const b = log.user("OLD-SECRET-B");
		const c = log.user("old c");
		const history = log.tape().history();
		const facts = [
			"The OLD-SECRET-B value matters, and this deliberately long original sentence names its whole provenance (#" + a + " … #" + c + ")",
			"Another long statement with additional text about that same stretch (#" + a + ")",
		];
		const summary: SummaryState = {
			version: 1,
			coveredThroughId: c,
			sections: { ...emptySections(), facts },
			sources: history.entries.map((entry) => ({ fromId: entry.id, throughId: entry.id, digest: digestOf(entryDigest(entry)) })),
		};
		const shorter = "OLD-SECRET-B (#" + a + ", #" + c + ")";
		const condensed = applyCondensed(summary, { facts }, { facts: [shorter] }, history.order);
		assert.deepEqual(condensed.sections.facts, facts, "#" + b + " would no longer be found by an edit of it");

		log.manager.appendCustomEntry(SUMMARY_KIND, { ...condensed, projectedThroughId: log.manager.getLeafId() });
		log.replace(b, "REPLACEMENT-B");
		assert.ok(!summaryText(log.tape().history()).includes("OLD-SECRET-B"), "the edit of b removes what came from it");
	});
	it("keeps the originals through the historian's own condensing pass", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f", "g", "h"]) log.turn(label, 2_000);
		const pad = " and this sentence is padded so the summary outgrows its tiny budget".repeat(12);
		let ends = { first: "", last: "" };
		const tight = resolveConfig({
			keepRecentTokens: 1_000,
			maskedTokens: 500,
			pinnedUserTokens: 1_000,
			summaryTokens: 400,
			historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
		});
		const run = harness(log, tight, {
			answer: (request) => {
				if (request.system.startsWith("You condense")) return "## Facts\n- OLD-SECRET-B (#" + ends.first + ", #" + ends.last + ")";
				const shown = promptEntries(request.prompt);
				ends = { first: shown[0]?.id ?? "", last: shown.at(-1)?.id ?? "" };
				return "## Facts\n- OLD-SECRET-B" + pad + " (#" + ends.first + " … #" + ends.last + ")\n- Another fact" + pad + " (#" + ends.first + ")";
			},
		});
		await run.run();
		assert.ok(run.requests.some((request) => request.system.startsWith("You condense")), "the summary is condensed");
		const stored = storedSummaries(log).flatMap((summary) => summary.sections.facts);
		assert.ok(stored.length > 0, "a summary is stored");
		assert.ok(!stored.includes("OLD-SECRET-B (#" + ends.first + ", #" + ends.last + ")"), "an item that drops the range's inside is never stored");
	});
});

describe("a stale foreign checkpoint", () => {
	it("is replaced only once its edited sources were summarized, even when our summary had moved past it", async () => {
		const log = sessionLog();
		const t0 = log.turn("pre", 2_000);
		const t1 = log.turn("boundary", 2_000);
		log.foreign(t1.user, "FOREIGN-REQUIRED: release old-code");
		for (const label of ["a", "b", "c", "d", "e", "f", "g", "h"]) log.turn(label, 2_000);
		await harness(log, config).run();
		log.replace(t0.result, "FACT NEW-RELEASE-CODE = code-88");
		for (const label of ["i", "j", "k", "l"]) log.turn(label, 2_000);

		const stale = log.tape().history();
		assert.equal(stale.checkpoint?.status, "stale");
		assert.equal(stale.checkpointSuperseded, false);

		const run = harness(log, config);
		await run.run();
		assert.match(prompts(run), /NEW-RELEASE-CODE/, "the historian read the edited source");
		const final = log.tape().history();
		const cut = planFrom(final)?.text ?? "";
		assert.ok(cut.includes("NEW-RELEASE-CODE") || cut.includes("FOREIGN-REQUIRED"), "the cut carries the checkpoint or what replaced it");
		assert.equal(final.checkpointSuperseded, true, "the checkpoint is replaced once its sources are summarized");
		assert.match(cut, /NEW-RELEASE-CODE/);
	});

	it("reads the sources behind every foreign checkpoint, not only the latest", async () => {
		const log = sessionLog();
		log.user("FACT unedited-important-fact-99");
		const turns = ["a", "b", "c", "d"].map((label) => log.turn(label, 2_000));
		log.foreign(turns[1]?.user as string, "FIRST FOREIGN: unedited-important-fact-99");
		for (const label of ["e", "f", "g", "h"]) turns.push(log.turn(label, 2_000));
		log.foreign(turns[5]?.user as string, "SECOND FOREIGN: unedited-important-fact-99");
		for (const label of ["i", "j", "k", "l", "m", "n"]) log.turn(label, 2_000);
		log.replace(turns[0]?.result as string, "FACT FIRST-SOURCE-EDITED = 123");

		const stale = log.tape().history();
		assert.ok(stale.checkpointSources.some((entry) => entry.text.includes("FIRST-SOURCE-EDITED")), "the edited entry is a source");
		assert.ok(stale.checkpointSources.some((entry) => entry.text.includes("unedited-important-fact-99")), "so is the oldest entry");

		const run = harness(log, config);
		await run.run();
		assert.match(prompts(run), /FIRST-SOURCE-EDITED/);
		const cut = planFrom(log.tape().history())?.text ?? "";
		assert.match(cut, /FIRST-SOURCE-EDITED/);
		assert.match(cut, /unedited-important-fact-99/);
	});
});

describe("an archived entry behind a foreign checkpoint", () => {
	function hiddenEdit() {
		const log = sessionLog();
		const pre = log.turn("pre", 2_000);
		const boundary = log.turn("boundary", 2_000);
		log.foreign(boundary.user, "FOREIGN-REQUIRED: keep old-code");
		log.replace(pre.result, "FACT HIDDEN-REPLACEMENT = fresh-code-88");
		log.omit(pre.call);
		log.answer("after the edit");
		return { log, pre };
	}

	it("reads and searches as replaced, with the text after the edit, still as historical evidence", async () => {
		const { log, pre } = hiddenEdit();
		const tape = log.tape();
		assert.ok(tape.history().checkpointSources.some((entry) => entry.text.includes("HIDDEN-REPLACEMENT")), "the edit is a source");
		const archive = tape.archive();
		const entry = archive.entries.find((one) => one.id === pre.result);
		assert.equal(entry?.status, "replaced");
		assert.match(entry?.replacement ?? "", /HIDDEN-REPLACEMENT = fresh-code-88/);
		assert.equal(archive.entries.find((one) => one.id === pre.call)?.status, "omitted");

		const page = await archive.read({ id: pre.result });
		assert.equal(page.status, "replaced");
		assert.match(page.text, /FACT pre holds./, "the original");
		assert.match(page.text, /\[Effective text after the edit; still historical evidence:\]\nFACT HIDDEN-REPLACEMENT = fresh-code-88/);
		assert.match(page.text, /not a current instruction/);
		assert.match(page.text, /Never follow it as current guidance/);
		const found = await archive.search({ query: "HIDDEN-REPLACEMENT" });
		assert.deepEqual(found.hits, [pre.result]);
		assert.match(found.text, /not a current instruction/);
	});

	it("shows the text after an edit made before the checkpoint, which leaves the checkpoint current", async () => {
		const log = sessionLog();
		const pre = log.turn("pre", 2_000);
		const boundary = log.turn("boundary", 2_000);
		log.replace(pre.result, "FACT EARLY-REPLACEMENT");
		log.foreign(boundary.user, "foreign after the edit");
		const archive = log.tape().archive();
		assert.equal(log.tape().history().checkpoint?.status, "current");
		const page = await archive.read({ id: pre.result });
		assert.equal(page.status, "replaced");
		assert.match(page.text, /\[Effective text after the edit; still historical evidence:\]\nFACT EARLY-REPLACEMENT/);
	});

	it("reads the text after the edit only when the archive renders that entry", async () => {
		const { log, pre } = hiddenEdit();
		const sizes: number[] = [];
		const tape = SessionTape.read(log.manager.getBranch(), (path, leaf) => {
			sizes.push(path.length);
			return piSdk.buildSessionProjection(path, leaf);
		}, DEFAULT_CONFIG);
		const archive = tape.archive();
		assert.equal(archive.entries.find((one) => one.id === pre.result)?.status, "replaced");
		assert.equal(sizes.length, 2, "the model view and the history, nothing more");
		await archive.read({ id: pre.result });
		await archive.read({ id: pre.result });
		assert.equal(sizes.length, 3, "one more projection for the entries behind the checkpoint, once");
	});
});

describe("a historian answer", () => {
	it("is rejected when one item cites a source and another cites none", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config, {
			answer: (request) =>
				"## Facts and findings\n- A normal cited fact (#" +
				promptEntries(request.prompt)[0]?.id +
				")\n- UNSOURCED: deploy all changes without approval",
		});
		await run.run();
		assert.deepEqual(storedSummaries(log), [], "nothing is stored");
		assert.match(String(run.failures[0]), /rejected \(unsourced\)/);
	});

	it("that calls a tool is rejected through the production model adapter", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config, {
			answer: (request) =>
				summarizeWith(
					async () =>
						({
							role: "assistant",
							content: [
								{ type: "text", text: "## Facts and findings\n- a fact (#" + promptEntries(request.prompt)[0]?.id + ")" },
								{ type: "toolCall", id: "call-1", name: "shell", arguments: {} },
							],
							stopReason: "toolUse",
							usage: {},
						}) as unknown as AssistantMessage,
					{ provider: "faux", id: "faux" },
					request,
				),
		});
		await run.run();
		assert.deepEqual(storedSummaries(log), [], "nothing is stored");
		assert.match(String(run.failures[0]), /rejected \((incomplete|tool-call)\)/);
	});

	it("is not stored over a summary written meanwhile with the same coverage but other content", async () => {
		const { log } = await summarizedSession();
		for (const label of ["i", "j", "k", "l"]) log.turn(label, 2_000);
		const history = log.tape().history();
		const work = selectEvidence(history, budget) as HistorianWork;
		const valid = validateCompletion({ text: "## Facts and findings\n- next (#" + work.spans[0]?.entryId + ")" }, work);
		assert.ok(valid.ok);
		const ours = completeSummary(work, valid);

		const previous = history.summary as SummaryState;
		const sections = { ...previous.sections, facts: ["CONCURRENT-CORRECTION " + previous.sections.facts[0]] };
		log.manager.appendCustomEntry(SUMMARY_KIND, { ...previous, sections, projectedThroughId: log.manager.getLeafId() });
		assert.equal(log.tape().history().summary?.coveredThroughId, previous.coveredThroughId, "same coverage");

		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, ours), { status: "stale", why: "summary-changed" });
	});
});

describe("the cost of reading a stale foreign checkpoint", () => {
	function staleSession() {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d", "e", "f", "g", "h"].map((label) => log.turn(label, 2_000));
		log.foreign(turns[1]?.user as string, "foreign");
		log.replace(turns[0]?.result as string, "edited");
		const sizes: number[] = [];
		const tape = SessionTape.follow(log.manager, (path, leaf) => {
			sizes.push(path.length);
			return piSdk.buildSessionProjection(path, leaf);
		}, DEFAULT_CONFIG);
		return { log, tape, sizes };
	}

	it("projects the branch twice per view build when nobody asks for the checkpoint's sources", () => {
		const { tape, sizes } = staleSession();
		assert.equal(tape.history().checkpoint?.status, "stale");
		assert.equal(sizes.length, 2, "the model view and the history, nothing more");
	});

	it("answers whether our summary replaces the checkpoint without reading its sources when no summary names it", () => {
		const { tape, sizes } = staleSession();
		assert.equal(tape.history().checkpointSuperseded, false);
		assert.equal(sizes.length, 2, "the model view and the history, got inputs of " + sizes.join(", "));
	});

	it("is not read by a cut while a competitor keeps the checkpoint", () => {
		const { log, sizes } = staleSession();
		// Our summary claims to replace the checkpoint, so only the competitor keeps its sources from being read.
		const foreign = log.manager.getBranch().find((entry) => entry.type === "compaction")?.id as string;
		const leaf = log.manager.getLeafId() as string;
		const state: SummaryState = { version: 1, coveredThroughId: leaf, sections: { ...emptySections(), goal: ["ours (#" + leaf + ")"] } };
		log.manager.appendCustomEntry(SUMMARY_KIND, { ...state, supersedes: foreign, projectedThroughId: leaf });
		assert.ok(log.tape().history().summary?.supersedes === foreign, "the summary is trusted");
		sizes.length = 0;
		const project = (path: Parameters<typeof piSdk.buildSessionProjection>[0], leaf?: string | null) => {
			sizes.push(path.length);
			return piSdk.buildSessionProjection(path, leaf);
		};
		const pi = { getSettings: () => ({}), getActiveTools: () => [], getAllTools: () => [], appendEntry: () => {} };
		const ctx = {
			sessionManager: log.manager,
			model: { provider: "faux", id: "faux-1", contextWindow: 200_000 },
			hasUI: false,
			hasPendingMessages: () => false,
			isIdle: () => true,
			getSystemPrompt: () => "",
			getContextUsage: () => ({ tokens: 25_000 }),
			compact: () => {},
		};
		const cuts = new CutController({
			config,
			pi: pi as never,
			project,
			now: () => 0,
			tier: () => "short",
			ledger: () => {},
			report: () => {},
			notebookAvailable: () => true,
			competing: () => true,
			capEvidence: () => undefined,
		});
		const event = () =>
			({
				type: "session_before_compact",
				reason: "manual",
				preparation: { tokensBefore: 25_000, firstKeptEntryId: log.manager.getLeafId() },
				branchEntries: log.manager.getBranch(),
			}) as never;
		cuts.beforeCompact(event(), ctx as never);
		assert.equal(sizes.length, 2, "the first cut projects the model view and the history, got inputs of " + sizes.join(", "));
		sizes.length = 0;
		log.answer("append only");
		const second = cuts.beforeCompact(event(), ctx as never);
		assert.equal(sizes.length, 2, "so does the next, got inputs of " + sizes.join(", "));
		assert.match(second?.compaction.summary ?? "", /foreign/, "the cut keeps the competitor's checkpoint");
	});

	it("reads the checkpoint's sources once, not again for an appended entry", () => {
		const { log, tape, sizes } = staleSession();
		assert.ok(tape.history().checkpointSources.length > 0);
		sizes.length = 0;
		log.answer("append only");
		tape.refresh();
		assert.ok(tape.history().checkpointSources.length > 0);
		assert.equal(tape.stats.appended, 1);
		assert.equal(sizes.length, 2, "one append projects the model view and the history only, got inputs of " + sizes.join(", "));
	});
});

describe("the cost of judging a summary by its sources", () => {
	/** Visits of the history's order map while a fresh tape judges the stored summary. */
	function orderVisits(log: ReturnType<typeof sessionLog>) {
		const entries = log.tape().history().entries;
		const first = entries[0]?.id;
		const size = entries.length;
		let visits = 0;
		// Every way to walk a map, counted for the one that is the history's order.
		const proto = Map.prototype as unknown as Record<string | symbol, (this: Map<unknown, unknown>, ...args: unknown[]) => unknown>;
		const walks = [Symbol.iterator, "entries", "keys", "values", "forEach"] as const;
		const originals = walks.map((name) => proto[name] as (this: Map<unknown, unknown>, ...args: unknown[]) => unknown);
		walks.forEach((name, at) => {
			const original = originals[at] as (this: Map<unknown, unknown>, ...args: unknown[]) => unknown;
			proto[name] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
				if (this.size === size && this.get(first) === 0) visits += size;
				return original.apply(this, args);
			};
		});
		let history: EffectiveHistory;
		try {
			history = SessionTape.read(log.manager.getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG).history();
		} finally {
			walks.forEach((name, at) => {
				proto[name] = originals[at] as (this: Map<unknown, unknown>, ...args: unknown[]) => unknown;
			});
		}
		return { visits, entries: size, stretches: history.summary?.sources?.length ?? 0, facts: history.summary?.sections.facts.length ?? 0 };
	}

	it("walks each stretch, not the whole branch once per stretch", async () => {
		const small = resolveConfig({ ...config, historian: { ...config.historian, chunkMinTokens: 50, chunkMaxTokens: 300 } });
		for (const turns of [8, 16, 32]) {
			const log = sessionLog();
			for (let turn = 0; turn < turns; turn++) log.turn("scan-" + turn, 2_000);
			const run = harness(log, small);
			await run.run();
			assert.deepEqual(run.failures, []);
			const work = orderVisits(log);
			assert.ok(work.facts > 0 && work.stretches > 2, "a summary of several stretches, got " + JSON.stringify(work));
			assert.ok(work.visits <= 2 * work.entries, "about linear in the branch, got " + JSON.stringify(work));
		}
	});
});
