import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type HistorianBranch,
	HistorianLifecycle,
	type SummarizeRequest,
	type SummarizeResult,
} from "../src/historian/run.ts";
import { evidenceBudget, selectEvidence } from "../src/core/historian.ts";
import { small } from "./support/core.ts";
import { deferred } from "./support/lifecycle.ts";
import { sessionLog } from "./support/session-log.ts";
import { attemptRecords, sessionAttempts } from "./support/historian.ts";

/*
 * The historian's lifecycle with a fake branch and a fake transport. Events are ordered by the test releasing the
 * transport by hand; nothing here waits for time to pass.
 */

/** A branch whose first stretch is read from a real session, and which has nothing more once a summary is written. */
function fakeBranch(label = "e1", { ignoreAbort = false } = {}) {
	const trace: string[] = [];
	const requests: SummarizeRequest[] = [];
	const answer = deferred<SummarizeResult>();
	const sent = deferred();
	const stored = deferred();
	const writes: unknown[] = [];
	let covered: string | undefined;
	const log = sessionLog();
	for (const turn of [label, label + "-2", label + "-3"]) log.turn(turn, 12_000);
	const history = log.tape().history();
	const evidence = selectEvidence(history, evidenceBudget(small, false));
	if (!evidence) throw new Error("the session holds too little to summarize");
	const first = evidence.spans[0]?.entryId as string;
	const through = evidence.spans.at(-1)?.entryId as string;
	/** An answer that cites what the historian was shown. */
	const text = "## Current state\n- Something happened (#" + first + ")";
	const branch: HistorianBranch = {
		attempts: sessionAttempts(log),
		routes: () => [{ model: "test/historian", route: "primary", call: (request) => {
			requests.push(request);
			trace.push("sent");
			sent.resolve();
			return new Promise<SummarizeResult>((resolve, reject) => {
				const onAbort = () => {
					trace.push("signal-aborted");
					reject(new Error("aborted"));
				};
				if (!ignoreAbort) request.signal.addEventListener("abort", onAbort);
				void answer.promise.then((result) => {
					if (request.signal.aborted && !ignoreAbort) return;
					request.signal.removeEventListener("abort", onAbort);
					trace.push("answered");
					resolve(result);
				});
			});
		} }],
		next: async () => (covered === undefined ? evidence : undefined),
		write: (_work, summary) => {
			trace.push("write");
			writes.push(summary);
			covered = summary.coveredThroughId;
			stored.resolve();
			return { status: "stored" };
		},
	};
	/** What the attempt records of the branch say, as outcomes: §start§, or §end:<outcome>§. */
	const records = () => attemptRecords(log).map((record) => (record.type === "end" ? "end:" + record.outcome : record.type));
	return { branch, trace, requests, answer, sent, stored, writes, text, through, records, log };
}

function lifecycleWith() {
	return { lifecycle: new HistorianLifecycle(small) };
}

/** Lets every promise already settled run its continuations; no timer involved. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe("HistorianLifecycle", () => {
	it("shutdown with a call in flight aborts it, records the attempt and writes nothing", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch();
		lifecycle.start(work.branch, 1);
		await work.sent.promise;

		assert.equal(await lifecycle.shutdown("quit"), "aborted");
		assert.deepEqual(work.trace, ["sent", "signal-aborted"]);
		assert.deepEqual(work.records(), ["start", "end:aborted"]);
		const [start, end] = attemptRecords(work.log);
		assert.equal(start?.type === "start" && start.throughId, work.through);
		assert.deepEqual(end?.type === "end" && { reason: end.reason, step: end.step }, { reason: "quit", step: "summarize" });
		assert.equal(work.writes.length, 0);
		assert.equal(lifecycle.stats.aborted, 1);
		assert.equal(lifecycle.stats.failures, 0, "a cancelled call is no failure");
		assert.equal(lifecycle.running, 0);
	});

	it("an answer that comes after the shutdown is never written, even when the transport ignores the abort", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch("e1", { ignoreAbort: true });
		lifecycle.start(work.branch, 1);
		await work.sent.promise;
		assert.equal(await lifecycle.shutdown("quit"), "aborted", "the shutdown does not wait for the transport");
		work.answer.resolve({ text: work.text });
		await settle();
		assert.deepEqual(work.trace, ["sent", "answered"]);
		assert.equal(work.writes.length, 0);
	});

	it("shutdown after a stored summary reports completed and records no attempt", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch();
		lifecycle.start(work.branch, 1);
		await work.sent.promise;
		work.answer.resolve({ text: work.text });
		await work.stored.promise;

		assert.equal(await lifecycle.shutdown("reload"), "completed");
		assert.deepEqual(work.trace, ["sent", "answered", "write"]);
		assert.deepEqual(work.records(), ["start", "end:stored"], "the attempt finished; no abort is recorded");
	});

	it("commits a summary when write returns, so storage never holds a shutdown", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch();
		const storage = deferred();
		// A writer whose storage finishes later is no historian writer.
		// @ts-expect-error write returns undefined, not a promise
		const later: HistorianBranch["write"] = async () => storage.promise;
		void later;
		// One that slips through stores the summary as it returns; what it leaves pending is not waited for.
		lifecycle.start({ ...work.branch, write: (w, summary) => (work.branch.write(w, summary), storage.promise as never) }, 1);
		await work.sent.promise;
		work.answer.resolve({ text: work.text });
		await work.stored.promise;

		let outcome: string | undefined;
		void lifecycle.shutdown("quit").then((found) => {
			outcome = found;
		});
		await settle();
		assert.equal(outcome, "completed", "the shutdown ended while the storage was still pending");
		assert.deepEqual(work.trace, ["sent", "answered", "write"]);
	});

	it("shutdown before any call went out reports not started", async () => {
		const { lifecycle } = lifecycleWith();
		assert.equal(await lifecycle.shutdown("quit"), "not started", "nothing was ever started");

		const idle = new HistorianLifecycle(small);
		const work = fakeBranch();
		idle.start({ ...work.branch, next: async () => undefined }, 1);
		assert.equal(await idle.shutdown("quit"), "not started", "too little history to summarize");
		assert.equal(work.requests.length, 0);
		assert.deepEqual(work.records(), []);
	});

	it("starts one worker per generation", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch();
		lifecycle.start(work.branch, 1);
		lifecycle.start(work.branch, 1);
		await work.sent.promise;
		lifecycle.start(work.branch, 1);
		assert.equal(lifecycle.running, 1);
		assert.equal(work.requests.length, 1);
		await lifecycle.shutdown("quit");
	});

	it("a newer generation cancels the old worker, and the old answer never lands on the new branch", async () => {
		const { lifecycle } = lifecycleWith();
		const old = fakeBranch("old");
		const replacement = fakeBranch("new");
		lifecycle.start(old.branch, 1);
		await old.sent.promise;
		lifecycle.start(replacement.branch, 2);
		old.answer.resolve({ text: old.text });
		await replacement.sent.promise;

		assert.deepEqual(old.trace, ["sent", "signal-aborted"]);
		assert.deepEqual(old.records(), ["start"], "leaving a branch cannot complete the attempt: it stays open, which counts as paid");
		assert.equal(old.writes.length, 0);

		replacement.answer.resolve({ text: replacement.text });
		await replacement.stored.promise;
		assert.equal(replacement.writes.length, 1);
		assert.equal(await lifecycle.shutdown("quit"), "completed");
	});

	it("ignores an older generation, and any start after the shutdown of its own generation", async () => {
		const { lifecycle } = lifecycleWith();
		const first = fakeBranch();
		lifecycle.start(first.branch, 2);
		await first.sent.promise;
		const stale = fakeBranch();
		lifecycle.start(stale.branch, 1);
		assert.equal(stale.requests.length, 0);
		await lifecycle.shutdown("quit");

		const late = fakeBranch();
		lifecycle.start(late.branch, 2);
		assert.equal(lifecycle.running, 0, "a closed generation starts nothing");
		assert.equal(late.requests.length, 0);
	});

	it("an answer that finds its branch changed under it is dropped, and the stretch stays unsummarized", async () => {
		const { lifecycle } = lifecycleWith();
		const work = fakeBranch();
		const moved: HistorianBranch = { ...work.branch, write: () => ({ status: "stale", why: "branch-lost" }) };
		lifecycle.start(moved, 1);
		await work.sent.promise;
		work.answer.resolve({ text: work.text });
		await settle();
		assert.equal(await lifecycle.shutdown("quit"), "completed", "the call finished; there was nothing to write");
		assert.equal(work.writes.length, 0);
		assert.equal(work.requests.length, 1, "a stale summary is not retried at once");
	});

	it("an answer that is no complete, sourced summary advances nothing and is reported", async () => {
		const failures: unknown[] = [];
		const lifecycle = new HistorianLifecycle(small, { onError: (error) => failures.push(error) });
		const work = fakeBranch();
		lifecycle.start(work.branch, 1);
		await work.sent.promise;
		work.answer.resolve({ text: "hello" });
		await settle();
		assert.equal(await lifecycle.shutdown("quit"), "completed");
		assert.equal(work.writes.length, 0);
		assert.match(String(failures[0]), /rejected \(no-sections\)/);
	});
});
