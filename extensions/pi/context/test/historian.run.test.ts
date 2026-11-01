import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ATTEMPT_LIMIT, nextAction, RETRY_DELAYS_MS } from "../src/core/attempts.ts";
import { resolveConfig } from "../src/core/config.ts";
import type { HistorianPause } from "../src/historian/run.ts";
import { attemptRecords, citingAnswer, harness, storedSummaries } from "./support/historian.ts";
import { deferred } from "./support/lifecycle.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * Bounded retries of the historian. The clock is a number the test moves; nothing sleeps. Attempts are read from a
 * real session, so a restart is a new lifecycle over the same log.
 */

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
});
const FIRST_DELAY = RETRY_DELAYS_MS[0] as number;
const SECOND_DELAY = RETRY_DELAYS_MS[1] as number;

/** A session with a stretch to summarize, a clock, and a way to start a historian process over them. */
function scene(answer: (call: number, prompt: string) => string | Promise<{ text: string }> = () => "malformed") {
	const log = sessionLog();
	for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
	const time = { now: 1_000_000 };
	const pauses: HistorianPause[] = [];
	let calls = 0;
	/** A process: a new lifecycle over the same session. */
	const process = () =>
		harness(log, config, {
			now: () => time.now,
			onPause: (pause) => pauses.push(pause),
			answer: (request) => answer(++calls, request.prompt) as never,
		});
	const words = () => attemptRecords(log).map((record) => (record.type === "end" ? "end:" + record.outcome : record.type));
	return { log, time, pauses, process, words, calls: () => calls };
}

describe("the historian retries a failing summary a bounded number of times", () => {
	it("asks again after 30 seconds, then after 2 minutes, then pauses", async () => {
		const s = scene();
		const run = s.process();
		await run.run();
		assert.equal(run.requests.length, 1);

		await run.run();
		s.time.now += FIRST_DELAY - 1;
		await run.run();
		assert.equal(run.requests.length, 1, "30 seconds have not passed");

		s.time.now += 1;
		await run.run();
		assert.equal(run.requests.length, 2, "the second attempt after 30 seconds");

		s.time.now += SECOND_DELAY - 1;
		await run.run();
		assert.equal(run.requests.length, 2, "2 minutes have not passed");

		s.time.now += 1;
		await run.run();
		assert.equal(run.requests.length, ATTEMPT_LIMIT, "the third attempt after 2 minutes");
		assert.deepEqual(s.words(), ["start", "end:rejected", "start", "end:rejected", "start", "end:rejected"]);
		assert.equal(s.pauses.length, 0, "nothing is announced until a turn finds the work out of attempts");

		s.time.now += SECOND_DELAY;
		await run.run();
		assert.equal(s.pauses.length, 1, "the pause is announced");
		assert.equal(s.pauses[0]?.attempts, 3);
		assert.match(s.pauses[0]?.lastDetail ?? "", /rejected \(no-sections\)/);
	});

	it("sends no fourth request in five turns after three malformed answers", async () => {
		const s = scene();
		const run = s.process();
		for (const wait of [0, FIRST_DELAY, SECOND_DELAY]) {
			s.time.now += wait;
			await run.run();
		}
		assert.equal(s.calls(), 3);
		for (let turn = 0; turn < 5; turn++) {
			s.time.now += 60 * 60_000;
			await run.run();
		}
		assert.equal(s.calls(), 3, "no fourth request");
		assert.equal(s.pauses.length, 1, "the pause is announced once, not on every turn");
		assert.deepEqual(storedSummaries(s.log), []);
	});

	it("a good answer after a failure stores the summary and clears the count", async () => {
		const s = scene((call, prompt) => (call === 1 ? "malformed" : citingAnswer(prompt)));
		const run = s.process();
		await run.run();
		s.time.now += FIRST_DELAY;
		await run.run();
		assert.equal(storedSummaries(s.log).length, 1);
		assert.deepEqual(s.words(), ["start", "end:rejected", "start", "end:stored"]);
		assert.equal(s.log.tape().state.attempts.size, 0, "the work has no failed attempt left");
	});

	it("keeps the count and the wait across a restart", async () => {
		const s = scene();
		await s.process().run();
		const restarted = s.process();
		await restarted.run();
		assert.equal(restarted.requests.length, 0, "a new process waits out the delay of the old one's attempt");

		s.time.now += FIRST_DELAY;
		await restarted.run();
		assert.equal(restarted.requests.length, 1);

		s.time.now += SECOND_DELAY;
		await restarted.run();
		const third = s.process();
		s.time.now += 24 * 60 * 60_000;
		await third.run();
		assert.equal(third.requests.length, 0, "three attempts were made; a restart does not reset them");
		assert.equal(s.pauses.length, 1);
		assert.equal(s.calls(), 3);
	});

	it("counts an attempt that never ended (a crash) as paid", async () => {
		const s = scene();
		const key = (await s.process().run(), attemptRecords(s.log)[0]?.type === "start" ? (attemptRecords(s.log)[0] as { key: string }).key : "");
		// Two more starts without an end: the process died during them.
		for (const id of ["x1", "x2"]) {
			s.log.manager.appendCustomEntry("context.historian-attempt", { type: "start", id, key, at: s.time.now, throughId: "none" });
		}
		const restarted = s.process();
		await restarted.run();
		assert.equal(restarted.requests.length, 0, "one rejected and two unknown attempts use up the three");
		assert.equal(s.pauses.length, 1);
	});

	it("does not reset the count when more turns lengthen the stretch", async () => {
		const s = scene();
		const run = s.process();
		await run.run();
		s.log.turn("g", 2_000);
		s.time.now += FIRST_DELAY;
		await run.run();
		s.log.turn("h", 2_000);
		s.time.now += SECOND_DELAY;
		await run.run();
		s.log.turn("i", 2_000);
		s.time.now += 24 * 60 * 60_000;
		await run.run();
		assert.equal(s.calls(), 3);
	});

	it("an attempt cancelled by a branch change stays open on the old branch and is no count on the new one", async () => {
		const hang = deferred<{ text: string }>();
		const s = scene((call, prompt) => (call === 1 ? hang.promise : { text: citingAnswer(prompt) }) as never);
		const oldLeaf = s.log.manager.getLeafId() as string;
		const run = s.process();
		run.start();
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(run.requests.length, 1);

		const earlier = s.log.manager.getBranch()[17]?.id as string;
		s.log.manager.branch(earlier);
		run.start();
		for (let i = 0; i < 50 && run.lifecycle.running > 0; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(run.requests.length, 2, "the new branch is summarized at once: the open attempt belongs to the old tail");
		assert.deepEqual(
			attemptRecords(s.log).map((record) => (record.type === "end" ? "end:" + record.outcome : record.type)),
			["start", "start", "end:stored"],
		);
		assert.equal(s.log.manager.getBranch().some((entry) => entry.id === oldLeaf), false);
		hang.resolve({ text: "late" });
	});

	it("an abort that the transport ignores ends at once and is recorded as aborted", async () => {
		const never = deferred<{ text: string }>();
		const s = scene(() => never.promise as never);
		const run = s.process();
		run.start();
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(await run.lifecycle.shutdown("quit"), "aborted");
		assert.deepEqual(s.words(), ["start", "end:aborted"]);

		// The next process starts without waiting, since a cut-short call says nothing against the work, but it counts.
		const next = scene;
		void next;
		const again = s.process();
		again.start();
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(again.requests.length, 1);
		await again.lifecycle.shutdown("quit");
		const third = s.process();
		third.start();
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		await third.lifecycle.shutdown("quit");
		const fourth = s.process();
		await fourth.run();
		assert.equal(fourth.requests.length, 0, "three cut-short calls were paid for");
	});

	it("a stale write is an attempt too", async () => {
		const s = scene();
		const first = s.log.manager.getBranch()[2]?.id as string;
		const run = harness(s.log, config, {
			now: () => s.time.now,
			answer: (request) => {
				// A competing summary lands while the request is out.
				s.log.summary(first, "someone else");
				return citingAnswer(request.prompt);
			},
		});
		await run.run();
		assert.equal(run.requests.length, 1);
		assert.ok(s.words().includes("end:stale"), s.words().join(","));
	});

	it("an explicit retry frees paused work, and only paused or waiting work", async () => {
		const s = scene();
		const run = s.process();
		assert.equal(run.lifecycle.retry(run.branch), false, "nothing failed yet");
		for (const wait of [0, FIRST_DELAY, SECOND_DELAY, 1]) {
			s.time.now += wait;
			await run.run();
		}
		assert.equal(s.calls(), 3);
		assert.equal(s.pauses.length, 1);

		assert.equal(run.lifecycle.retry(run.branch), true);
		await run.run();
		assert.equal(s.calls(), 4, "the owner's retry starts a request at once, without the delay");
		assert.equal(run.lifecycle.stats.paused, undefined);

		// It gets a full set of attempts again, and pauses again.
		for (const wait of [FIRST_DELAY, SECOND_DELAY, 1]) {
			s.time.now += wait;
			await run.run();
		}
		assert.equal(s.calls(), 4 + 2);
		assert.equal(s.pauses.length, 2, "the second pause is announced again");
	});

	it("starting twice in one generation runs one worker and one request", async () => {
		const answer = deferred<{ text: string }>();
		const s = scene(() => answer.promise as never);
		const run = s.process();
		run.lifecycle.start(run.branch, 1);
		run.lifecycle.start(run.branch, 1);
		run.lifecycle.start(run.branch, 1);
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(run.requests.length, 1);
		assert.equal(run.lifecycle.running, 1);
		assert.deepEqual(s.words(), ["start"]);
		await run.lifecycle.shutdown("quit");
	});
});

describe("nextAction", () => {
	const at = (outcome: "rejected" | "aborted" | "open", endedAt: number) => ({ id: "i", at: endedAt - 5, endedAt, outcome });
	it("decides from the records, the clock and the worker alone", () => {
		const worker = { inFlight: undefined, ended: false };
		assert.deepEqual(nextAction("k", new Map(), 0, worker), { action: "start" });
		const one = new Map([["k", [at("rejected", 100)]]]);
		assert.deepEqual(nextAction("k", one, 100 + FIRST_DELAY - 1, worker), { action: "wait", why: "backoff", until: 100 + FIRST_DELAY });
		assert.deepEqual(nextAction("k", one, 100 + FIRST_DELAY, worker), { action: "start" });
		const other = new Map([["j", [at("rejected", 100)]]]);
		assert.deepEqual(nextAction("k", other, 100, worker), { action: "start" }, "other work does not count");
		const two = new Map([["k", [at("rejected", 0), at("rejected", 100)]]]);
		assert.deepEqual(nextAction("k", two, 100 + SECOND_DELAY - 1, worker).action, "wait");
		const three = new Map([["k", [at("rejected", 0), at("rejected", 100), at("rejected", 200)]]]);
		assert.deepEqual(nextAction("k", three, 1e12, worker), { action: "pause", attempts: 3 });
		assert.deepEqual(nextAction("k", three, 1e12, { inFlight: undefined, ended: true }), { action: "wait", why: "ended" });
	});
});
