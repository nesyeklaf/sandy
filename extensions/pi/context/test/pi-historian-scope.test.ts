import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ATTEMPT_LIMIT } from "../src/core/attempts.ts";
import { ATTEMPT_KIND } from "../src/core/kinds.ts";
import type { Summarizer } from "../src/pi/extension.ts";
import { citingAnswer } from "./support/historian.ts";
import { attemptEntries, lifecycleOptions, type Manager, openRuntime, seededManager, summaryEntries, tempDir } from "./support/lifecycle.ts";
import { piSdk } from "./support/pi.ts";

/*
 * The historian's count reads one ordered stream of receipts: every attempt record of the session, whichever process
 * or branch wrote it. Here several pi runtimes in one process stand in for pi processes on one session file: each has
 * its own SessionManager, which reads the file once when it opens, so a manager opened early is a stale snapshot.
 * They run one after another and share nothing but the file.
 */

const VERSION = piSdk.VERSION;
const HOUR = 3_600_000;

const ticks = async (count = 100) => {
	for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

const malformed: Summarizer = async () => ({ text: "no sections at all" });
const citing: Summarizer = async (request) => ({ text: citingAnswer(request.prompt) });

describe(`the historian counts every receipt of the session (pi ${VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	/** A seeded session file and a clock every runtime on it shares. */
	function sessionOnDisk() {
		const dir = tempDir();
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const seed = seededManager(dir, 6);
		const file = seed.getSessionFile();
		assert.ok(file);
		return { seed, file, clock: { now: Date.UTC(2026, 9, 9, 13, 0, 0) } };
	}

	/** One pi runtime on `manager`, as one pi process; it looks for work when it starts. */
	async function runtime(manager: Manager, clock: { now: number }, answer: Summarizer = malformed) {
		const dir = tempDir();
		let requests = 0;
		const notices: string[] = [];
		const summarize: Summarizer = (request, ctx) => {
			requests++;
			return answer(request, ctx);
		};
		const options = lifecycleOptions(join(dir, "ledger.jsonl"), summarize, 100);
		const opened = await openRuntime({ dir, manager, trace: [], options: { ...options, now: () => clock.now } });
		const quiet = () => undefined;
		const ui = {
			notify: (text: string) => notices.push(text),
			setStatus: quiet,
			setWidget: quiet,
			setFooter: quiet,
			setHeader: quiet,
			setTitle: quiet,
			setWorkingMessage: quiet,
			setEditorText: quiet,
		} as never;
		await opened.runtime.session.bindExtensions({ uiContext: ui });
		await ticks();
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			await opened.runtime.dispose();
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		};
		cleanup.push(() => void close());
		return {
			notices,
			get requests() {
				return requests;
			},
			async turn(text: string, advance = HOUR) {
				clock.now += advance;
				await opened.runtime.session.prompt(text);
				await ticks();
			},
			close,
		};
	}

	const starts = (file: string) => attemptEntries(piSdk.SessionManager.open(file)).filter((record) => record.type === "start");
	const paused = (notices: readonly string[]) => notices.some((text) => text.includes("paused after 3 failed attempts"));

	it("a session reopened after a stale process appended a sibling receipt counts both branches' receipts", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const stale = piSdk.SessionManager.open(file);
		const first = await runtime(seed, clock);
		assert.equal(first.requests, 1);
		await first.close();

		// Its receipts hang under the leaf it read, beside the first runtime's.
		const second = await runtime(stale, clock);
		for (const text of ["two", "three", "four"]) await second.turn(text);
		assert.equal(second.requests, 2);
		await second.close();
		assert.equal(starts(file).length, ATTEMPT_LIMIT);

		const reopened = await runtime(piSdk.SessionManager.open(file), clock);
		await reopened.turn("five", 10 * HOUR);
		assert.equal(reopened.requests, 0, "three receipts of this work are in the session");
		assert.ok(paused(reopened.notices), reopened.notices.join("\n"));
		assert.equal(starts(file).length, ATTEMPT_LIMIT);
	});

	it("a branch that reads the same work counts the receipts another branch holds", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const before = seed.getLeafId();
		assert.ok(before);
		const first = await runtime(seed, clock);
		for (const text of ["two", "three", "four"]) await first.turn(text);
		assert.equal(first.requests, ATTEMPT_LIMIT);
		await first.close();

		const fresh = piSdk.SessionManager.open(file);
		fresh.branch(before);
		const branched = await runtime(fresh, clock);
		assert.equal(branched.requests, 0, "the work's input is the same on this branch");
		assert.ok(paused(branched.notices), branched.notices.join("\n"));
	});

	it("/context retry-historian in a process that learned the attempts from disk sends the next request", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const stale = piSdk.SessionManager.open(file);
		const first = await runtime(seed, clock);
		for (const text of ["two", "three", "four"]) await first.turn(text);
		assert.equal(first.requests, ATTEMPT_LIMIT);
		await first.close();

		const late = await runtime(stale, clock);
		assert.equal(late.requests, 0);
		assert.ok(paused(late.notices));
		const before = late.notices.length;
		await late.turn("/context retry-historian");
		const after = late.notices.slice(before);
		assert.ok(after.includes("Historian: trying the summary again."), after.join("\n"));
		assert.equal(late.requests, 1, "the retry frees the work it said it would try");
		assert.equal(paused(after), false, after.join("\n"));
		assert.equal(starts(file).length, ATTEMPT_LIMIT + 1);
	});

	it("a retry another process stored frees this process's own failed attempts", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const stale = piSdk.SessionManager.open(file);
		const first = await runtime(seed, clock);
		for (const text of ["two", "three", "four"]) await first.turn(text);
		assert.equal(first.requests, ATTEMPT_LIMIT);
		await first.close();

		const other = await runtime(stale, clock);
		await other.turn("/context retry-historian");
		await other.close();
		const retries = attemptEntries(piSdk.SessionManager.open(file)).filter((record) => record.type === "retry");
		assert.equal(retries.length, 1);

		// The first runtime's manager read the file before the retry; its own three failures are on its branch.
		const again = await runtime(seed, clock);
		await again.turn("five");
		assert.equal(again.requests, 1, "the stored retry is in the stream after the three failures");
		assert.equal(paused(again.notices), false, again.notices.join("\n"));
	});

	it("a process whose snapshot predates another's stored summary does not ask for the same work again", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const stale = piSdk.SessionManager.open(file);
		const first = await runtime(seed, clock, citing);
		assert.equal(first.requests, 1);
		await first.close();
		assert.equal(summaryEntries(piSdk.SessionManager.open(file)).length, 1);

		const late = await runtime(stale, clock, citing);
		assert.equal(late.requests, 0, "the summary of this exact work is stored already");
		assert.equal(summaryEntries(piSdk.SessionManager.open(file)).length, 1);
	});

	it("a session file rewritten under a running process is read again from the start", async () => {
		const { seed, file, clock } = sessionOnDisk();
		const running = await runtime(seed, clock);
		assert.equal(running.requests, 1);
		const [own] = starts(file);
		assert.ok(own && own.type === "start");

		// Truncated and written again on the same inode, longer, with two more receipts of the same work near the top.
		const inode = statSync(file).ino;
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		const receipt = (index: number) =>
			JSON.stringify({
				type: "custom",
				id: `rewritten-${index}`,
				parentId: null,
				timestamp: new Date(clock.now).toISOString(),
				customType: ATTEMPT_KIND,
				data: { ...own, id: `rewritten-request-${index}` },
			});
		writeFileSync(file, [lines[0], receipt(0), receipt(1), ...lines.slice(1)].join("\n") + "\n");
		assert.equal(statSync(file).ino, inode);

		await running.turn("two");
		assert.equal(running.requests, 1, "three receipts of this work are in the file");
		assert.ok(paused(running.notices), running.notices.join("\n"));
	});
});
