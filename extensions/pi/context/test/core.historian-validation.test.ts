import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import {
	commitSummary,
	completeSummary,
	evidenceBudget,
	type HistorianWork,
	selectEvidence,
	validateCompletion,
} from "../src/core/historian.ts";
import { harness, storedSummaries } from "./support/historian.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * What counts as a summary. An answer is checked against the work it answers; a summary is stored only when the branch
 * still reads as the work did. Everything is read from a real session through the tape.
 */

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
});
const budget = evidenceBudget(config, false);

function fixture() {
	const log = sessionLog();
	const turns = ["a", "b", "c", "d", "e", "f"].map((label) => log.turn(label, 2_000));
	const work = selectEvidence(log.tape().history(), budget) as HistorianWork;
	assert.ok(work);
	const cited = work.spans[0]?.entryId as string;
	return { log, turns, work, cited };
}

describe("validating an answer", () => {
	it("rejects an answer with none of the sections, and never stores one", async () => {
		const { work } = fixture();
		const verdict = validateCompletion({ text: "hello" }, work);
		assert.equal(verdict.ok, false);
		assert.equal(!verdict.ok && verdict.reason, "no-sections");

		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config, { answer: () => "hello" });
		await run.run();
		assert.deepEqual(storedSummaries(log), [], "the coverage did not advance");
		assert.match(String(run.failures[0]), /rejected \(no-sections\)/);
		assert.equal(run.requests.length, 1, "it is not asked again at once");
	});

	it("rejects a reference to an entry the model was not shown", () => {
		const { work, cited } = fixture();
		const verdict = validateCompletion({ text: "## Facts and findings\n- made up (#deadbeef)\n- real (#" + cited + ")" }, work);
		assert.equal(!verdict.ok && verdict.reason, "unknown-reference");
	});

	it("rejects an answer that cites nothing", () => {
		const { work } = fixture();
		const verdict = validateCompletion({ text: "## Current state\n- something happened" }, work);
		assert.equal(!verdict.ok && verdict.reason, "unsourced");
	});

	it("rejects an answer with a tool call, a cut-off answer and an empty one", () => {
		const { work, cited } = fixture();
		const text = "## Current state\n- fine (#" + cited + ")";
		assert.equal(validateCompletion({ text, toolCalls: 1 }, work).ok, false);
		const call = validateCompletion({ text, toolCalls: 1 }, work);
		assert.equal(!call.ok && call.reason, "tool-call");
		const cut = validateCompletion({ text, stopReason: "length" }, work);
		assert.equal(!cut.ok && cut.reason, "incomplete");
		const empty = validateCompletion({ text: "  " }, work);
		assert.equal(!empty.ok && empty.reason, "incomplete");
		assert.equal(validateCompletion({ text, stopReason: "stop" }, work).ok, true);
	});

	it("accepts a citation followed by the sentence's closing punctuation, and nothing looser", () => {
		const { work, cited } = fixture();
		for (const mark of [".", ",", ";", ":"]) {
			const verdict = validateCompletion({ text: "## Facts and findings\n- fact (#" + cited + ")" + mark }, work);
			assert.equal(verdict.ok, true, "accepts " + mark);
			assert.ok(verdict.ok && verdict.delta.facts?.[0]?.endsWith(mark), "and keeps the item as written");
		}
		for (const tail of [" and more.", "..", ".)", "!"]) {
			const verdict = validateCompletion({ text: "## Facts and findings\n- fact (#" + cited + ")" + tail }, work);
			assert.equal(!verdict.ok && verdict.reason, "unsourced", "rejects " + JSON.stringify(tail));
		}
	});

	it("accepts the references of a range and of the existing summary", async () => {
		const { work, cited } = fixture();
		const last = work.spans.at(-1)?.entryId as string;
		const verdict = validateCompletion({ text: "## Facts and findings\n- all of it (#" + cited + " … #" + last + ")" }, work);
		assert.equal(verdict.ok, true);

		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		await harness(log, config).run();
		for (const label of ["g", "h", "i", "j"]) log.turn(label, 2_000);
		const next = selectEvidence(log.tape().history(), budget) as HistorianWork;
		assert.ok(next?.previous, "the work extends an existing summary");
		const earlier = /\(#(\w+)\)$/.exec(next.previous.sections.facts[0] ?? "")?.[1] as string;
		assert.ok(earlier && !next.spans.some((span) => span.entryId === earlier), "an entry only the existing summary cites");
		const shown = next.spans[0]?.entryId as string;
		const both = validateCompletion({ text: "## Facts and findings\n- still holds (#" + earlier + ", #" + shown + ")" }, next);
		assert.equal(both.ok, true);
	});

	it("names a chapter after the topic and the entries the stretch completed, and adds none without a topic", () => {
		const { work, cited } = fixture();
		const withTopic = validateCompletion({ text: "## Topic\n- Reading the modules\n## Facts\n- x (#" + cited + ")" }, work);
		assert.ok(withTopic.ok);
		const chapter = completeSummary(work, withTopic).sections.chapters[0];
		assert.match(chapter ?? "", /^Reading the modules \(#\w+ … #\w+\)$/);

		const without = validateCompletion({ text: "## Facts\n- x (#" + cited + ")" }, work);
		assert.ok(without.ok);
		assert.deepEqual(completeSummary(work, without).sections.chapters, []);
	});
});

describe("committing a summary", () => {
	const summaryOf = (work: HistorianWork, cited: string) => {
		const verdict = validateCompletion({ text: "## Facts and findings\n- a fact (#" + cited + ")" }, work);
		assert.ok(verdict.ok);
		return completeSummary(work, verdict);
	};

	it("stores a summary of an unchanged branch, and an unrelated append does not reject it", () => {
		const { log, work, cited } = fixture();
		const summary = summaryOf(work, cited);
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stored" });
		log.turn("later", 500);
		log.manager.appendCustomEntry("context.notebook", { text: "unrelated" });
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stored" });
	});

	it("is stale when an entry it was made from was edited meanwhile", () => {
		const { log, turns, work, cited } = fixture();
		const summary = summaryOf(work, cited);
		log.replace(turns[0]?.result as string, "edited while the historian was thinking");
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stale", why: "source-edited" });
	});

	it("is stale when the branch lost the entries it was made from", () => {
		const { log, turns, work, cited } = fixture();
		const summary = summaryOf(work, cited);
		// The session goes back to after the first turn and carries on: the other turns are no longer on the branch.
		log.manager.branch(turns[0]?.answer as string);
		log.turn("other branch", 2_000);
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stale", why: "branch-lost" });
	});

	it("is stale when another summary was stored meanwhile", () => {
		const { log, turns, work, cited } = fixture();
		const summary = summaryOf(work, cited);
		log.summary(turns[0]?.answer as string, "a competing goal");
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stale", why: "summary-changed" });
	});

	it("is stale when it does not carry the coverage the work promised", () => {
		const { log, turns, work, cited } = fixture();
		const summary = { ...summaryOf(work, cited), coveredThroughId: turns[1]?.user as string };
		assert.deepEqual(commitSummary({ work, history: log.tape().history() }, summary), { status: "stale", why: "mismatch" });
	});
});
