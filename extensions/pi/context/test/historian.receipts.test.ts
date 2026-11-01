import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ATTEMPT_LIMIT, RETRY_DELAYS_MS } from "../src/core/attempts.ts";
import { resolveConfig } from "../src/core/config.ts";
import type { SummarizeRequest } from "../src/historian/run.ts";
import { attemptRecords, harness, promptEntries, storedSummaries } from "./support/historian.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * What the historian's attempt records count and what they count it for. Every model request is a receipt, the
 * condenser's too, and the limit counts receipts. A piece of work is the whole stretch it read and the whole summary
 * it extends: an edit anywhere in either is new work, more history after it is not.
 */

const FIRST_DELAY = RETRY_DELAYS_MS[0] as number;
const SECOND_DELAY = RETRY_DELAYS_MS[1] as number;

/** Is this the condenser's request? */
const condensing = (request: SummarizeRequest) => request.prompt.includes("<records>");

/** A valid answer far over the summary budget, so the condenser is asked. */
function oversized(request: SummarizeRequest): string {
	const id = promptEntries(request.prompt)[0]?.id ?? "none";
	return "## Facts and findings\n" + Array.from({ length: 12 }, (_, i) => `- fact ${i}: ${"detail ".repeat(35)} (#${id})`).join("\n");
}

const settle = async (until: () => boolean) => {
	for (let i = 0; i < 2_000 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("the condenser's call is a request of its own", () => {
	const config = resolveConfig({
		summaryTokens: 400,
		keepRecentTokens: 1_000,
		maskedTokens: 500,
		pinnedUserTokens: 1_000,
		historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
	});

	it("an answer that needs condensing is two receipts, one per request, each naming its step", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config, { answer: (request) => (condensing(request) ? "malformed" : oversized(request)) });
		await run.run();
		assert.equal(run.requests.length, 2, "the summary and the condenser");
		assert.equal(storedSummaries(log).length, 1);
		const starts = attemptRecords(log).filter((record) => record.type === "start");
		assert.deepEqual(
			starts.map((record) => (record as { step?: string }).step),
			["summarize", "condense"],
			"a receipt is stored before each request",
		);
		const ends = attemptRecords(log).filter((record) => record.type === "end");
		assert.deepEqual(
			ends.map((record) => record.type === "end" && record.outcome),
			["stored", "stored"],
		);
	});

	it("a process cut short in the condenser paid two requests; the next makes the third and asks no condenser past it", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		let calls = 0;
		const hang = (request: SummarizeRequest) =>
			new Promise<{ text: string }>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
		// A process whose condenser call is cut short by the end of the process.
		const first = harness(log, config, {
			answer: (request) => {
				calls++;
				return condensing(request) ? hang(request) : oversized(request);
			},
		});
		first.start();
		await settle(() => first.requests.some(condensing));
		assert.equal(await first.lifecycle.shutdown("quit"), "aborted");
		assert.equal(calls, 2, "the first process paid for two requests");

		const second = harness(log, config, {
			answer: (request) => {
				calls++;
				return condensing(request) ? hang(request) : oversized(request);
			},
		});
		await second.run();
		assert.equal(calls, ATTEMPT_LIMIT, "the second process makes the third request and asks no condenser past the limit");
		assert.equal(storedSummaries(log).length, 1, "the summary is stored, trimmed to its budget without the condenser");
		assert.equal(attemptRecords(log).filter((record) => record.type === "start").length, ATTEMPT_LIMIT);
	});
});

describe("a piece of work is its whole stretch and the whole summary it extends", () => {
	const config = resolveConfig({
		keepRecentTokens: 1_000,
		maskedTokens: 500,
		pinnedUserTokens: 1_000,
		historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
	});

	/** A session whose summary covers the first turn, and a historian that never gets a valid answer, paused. */
	async function paused() {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d", "e", "f"].map((label) => log.turn(label, 2_000));
		const through = turns[0]?.answer as string;
		log.summary(through, "old intent");
		const time = { now: 1_000_000 };
		const run = harness(log, config, { now: () => time.now, answer: () => "malformed" });
		for (const wait of [0, FIRST_DELAY, SECOND_DELAY]) {
			time.now += wait;
			await run.run();
		}
		time.now += SECOND_DELAY;
		await run.run();
		assert.equal(run.requests.length, ATTEMPT_LIMIT);
		assert.ok(run.lifecycle.stats.paused, "the work paused");
		return { log, turns, through, time, run };
	}

	it("a corrected summary at the same coverage is new work and is asked at once", async () => {
		const s = await paused();
		s.log.summary(s.through, "CORRECTED intent");
		await s.run.run();
		assert.equal(s.run.requests.length, ATTEMPT_LIMIT + 1, "the corrected summary is extended by a new request");
	});

	it("an edit inside the stretch read, past its first entry, is new work", async () => {
		const s = await paused();
		const second = promptEntries(s.run.requests[0]?.prompt ?? "")[4]?.id;
		assert.ok(second, "the stretch read has more than four entries");
		s.log.replace(second, "FACT edited.");
		await s.run.run();
		assert.equal(s.run.requests.length, ATTEMPT_LIMIT + 1, "the edited stretch is asked again");
	});

	it("more history after the stretch read keeps the pause", async () => {
		const s = await paused();
		for (const label of ["g", "h"]) s.log.turn(label, 2_000);
		s.time.now += SECOND_DELAY;
		await s.run.run();
		assert.equal(s.run.requests.length, ATTEMPT_LIMIT, "growth is not new work");
		assert.ok(s.run.lifecycle.stats.paused);
	});
});
