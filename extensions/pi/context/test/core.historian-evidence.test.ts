import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { evidenceBudget, selectEvidence } from "../src/core/historian.ts";
import { harness, promptEntries, storedSummaries } from "./support/historian.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * What the historian is shown. The stretch comes from a real session read through the tape; the model is a stub that
 * records every request and copies what it sees, so a fact reaches the summary exactly when it reached the request.
 */

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 1_500 },
});
const budget = evidenceBudget(config, false);

/** A tool result of many filler lines with the fact as the line at the given position. */
function bigResult(log: ReturnType<typeof sessionLog>, label: string, lines: number, at: number, fact: string) {
	const user = log.user("Please read " + label + ".");
	log.call("c-" + label, "read", { path: label });
	const body = Array.from({ length: lines }, (_, i) => (i === at ? fact : "filler line " + i + " of " + label + " with ordinary words"));
	const result = log.result("c-" + label, "read", body.join("\n"));
	log.answer("Read " + label + ".");
	return { user, result };
}

describe("selecting the evidence for the historian", () => {
	it("waits until enough archivable history has accumulated and leaves the tail the next cut keeps", () => {
		const log = sessionLog();
		log.turn("a", 400);
		assert.equal(selectEvidence(log.tape().history(), budget), undefined);

		for (const label of ["b", "c", "d", "e", "f", "g"]) log.turn(label, 2_000);
		const history = log.tape().history();
		const work = selectEvidence(history, budget);
		assert.ok(work);
		assert.equal(work.spans[0]?.entryId, history.entries[0]?.id);
		const through = history.entries.findIndex((entry) => entry.id === work.coverage.throughId);
		const tail = history.entries.slice(through + 1).reduce((sum, entry) => sum + entry.tokens, 0);
		assert.ok(tail >= 937, "the newest entries stay raw or masked, and are summarized later: " + tail);
	});

	it("takes the history of the tape, never a list a caller assembled", () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const history = log.tape().history();
		// @ts-expect-error entries are not an effective history: edits and the checkpoint are applied only by the tape
		const raw = () => selectEvidence(history.entries, budget);
		void raw;
		assert.ok(selectEvidence(history, budget));
	});

	it("shows an oversized result in explicit spans and leaves what it has not shown to the next stretch", () => {
		const log = sessionLog();
		const { result } = bigResult(log, "big", 1_500, 700, "FACT middle-code = jade-heron-63");
		for (const label of ["a", "b", "c", "d"]) log.turn(label, 2_000);
		const work = selectEvidence(log.tape().history(), budget);
		assert.ok(work);
		const last = work.spans.at(-1);
		assert.equal(last?.entryId, result);
		assert.ok(last.to < last.total, "a result of about 15k tokens does not fit a 1,500 token stretch");
		assert.equal(work.coverage.partial?.entryId, result);
		assert.equal(work.coverage.partial?.offset, last.to);
		assert.notEqual(work.coverage.throughId, result, "a partly shown entry is not covered");
	});
});

describe("the historian over a long result", () => {
	it("lets a fact from the middle of the result reach the request and the summary", async () => {
		const log = sessionLog();
		const { result } = bigResult(log, "big", 1_500, 700, "FACT middle-code = jade-heron-63");
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config);
		await run.run();

		assert.deepEqual(run.failures, []);
		const prompts = run.requests.map((request) => request.prompt);
		assert.ok(
			prompts.some((prompt) => prompt.includes("FACT middle-code = jade-heron-63")),
			"the middle line is in a request to the historian's model",
		);
		assert.ok(!prompts.some((prompt) => prompt.includes("characters omitted")), "no request clips an entry");
		const facts = storedSummaries(log).at(-1)?.sections.facts ?? [];
		assert.ok(facts.some((fact) => fact.includes("jade-heron-63") && fact.includes("#" + result)), facts.join("\n"));
	});

	it("shows consecutive stretches with no entry skipped and no part of one shown twice", async () => {
		const log = sessionLog();
		bigResult(log, "big", 1_500, 700, "FACT middle-code = jade-heron-63");
		for (const label of ["a", "b", "c", "d", "e", "f", "g"]) log.turn(label, 2_000);
		const run = harness(log, config);
		await run.run();

		const shown = new Map<string, { from: number; to: number; of: number }[]>();
		for (const request of run.requests) {
			for (const one of promptEntries(request.prompt)) shown.set(one.id, [...(shown.get(one.id) ?? []), one]);
		}
		assert.ok(run.requests.length > 2, "the session took several stretches");
		for (const [id, parts] of shown) {
			let at = 0;
			for (const part of parts) {
				assert.equal(part.from, at, "entry " + id + " continues where its last part stopped");
				at = part.to;
			}
			assert.equal(at, parts[0]?.of, "entry " + id + " is shown to its end");
		}
		const covered = storedSummaries(log).at(-1)?.coveredThroughId;
		const history = log.tape().history().entries;
		const upTo = history.findIndex((entry) => entry.id === covered);
		assert.ok(upTo > 0);
		assert.deepEqual([...shown.keys()], history.slice(0, upTo + 1).map((entry) => entry.id));
	});

	it("stores a partly shown entry as partial, and never as covered", async () => {
		const log = sessionLog();
		const { result } = bigResult(log, "big", 1_500, 700, "FACT middle-code = jade-heron-63");
		for (const label of ["a", "b", "c", "d"]) log.turn(label, 2_000);
		const run = harness(log, config);
		await run.run();
		const first = storedSummaries(log)[0];
		assert.ok(first);
		assert.equal(first.partial?.entryId, result);
		assert.notEqual(first.coveredThroughId, result);
	});
});
