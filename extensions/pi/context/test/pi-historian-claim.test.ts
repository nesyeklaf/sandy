import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { ATTEMPT_LIMIT, RETRY_DELAYS_MS } from "../src/core/attempts.ts";
import { claimFile } from "../src/pi/claim.ts";
import { attemptEntries, seededManager, tempDir } from "./support/lifecycle.ts";
import { piSdk } from "./support/pi.ts";

/*
 * Two pi processes on one session file, as two terminals resuming the same session. Each is a real Node process with
 * pi's runtime and the context extension (test/support/claim-worker.ts); they share nothing but the file system.
 */

const WORKER = fileURLToPath(new URL("./support/claim-worker.ts", import.meta.url));
const SECOND_DELAY = RETRY_DELAYS_MS[1] as number;

interface Worker {
	readonly child: ChildProcess;
	/** Resolves with the first event of this name the process reports. */
	next(event: string): Promise<Record<string, unknown>>;
}

function worker(sessionFile: string, mode: "hang" | "malformed", offset = 0, wait = false): Worker {
	const child = spawn(process.execPath, [WORKER, sessionFile, mode, String(offset), ...(wait ? ["wait"] : [])], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	const events: Record<string, unknown>[] = [];
	const waiting: { event: string; resolve: (value: Record<string, unknown>) => void }[] = [];
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!line.startsWith("{")) continue;
			const event = JSON.parse(line) as Record<string, unknown>;
			events.push(event);
			for (const one of waiting.filter((candidate) => candidate.event === event.event)) {
				waiting.splice(waiting.indexOf(one), 1);
				one.resolve(event);
			}
		}
	});
	return {
		child,
		next: (event) =>
			new Promise((resolve, reject) => {
				const found = events.find((one) => one.event === event);
				if (found) return resolve(found);
				waiting.push({ event, resolve });
				child.once("exit", (code) => reject(new Error(`worker exited (${code}) before "${event}"`)));
			}),
	};
}

const killed = (one: Worker) =>
	new Promise<void>((resolve) => {
		one.child.once("exit", () => resolve());
		one.child.kill("SIGKILL");
	});

describe(`two pi processes on one session file (pi ${piSdk.VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	function sessionFile(): string {
		const dir = tempDir();
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const file = seededManager(dir, 6).getSessionFile();
		assert.ok(file, "the seeded session is stored in a file");
		return file;
	}

	it("a second process sends nothing while the first holds the work, and takes it over once the first is killed", { timeout: 60_000 }, async () => {
		const file = sessionFile();
		const first = worker(file, "hang");
		cleanup.push(() => first.child.kill("SIGKILL"));
		await first.next("sent");

		const second = await worker(file, "malformed").next("done");
		assert.equal(second.requests, 0, "the first process holds the work; its call may still answer");

		await killed(first);
		const third = await worker(file, "malformed").next("done");
		assert.equal(third.requests, 1, "the owner is gone, so its open attempt counts as paid and the work goes on");
		const starts = attemptEntries(piSdk.SessionManager.open(file)).filter((record) => record.type === "start");
		assert.equal(starts.length, 2);
	});

	it("a process that opened the session before the others' attempts reads them from the file and pauses", { timeout: 60_000 }, async () => {
		const file = sessionFile();
		const early = worker(file, "malformed", 10 * 3_600_000, true);
		cleanup.push(() => early.child.kill("SIGKILL"));
		await early.next("open");

		let offset = 0;
		for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt++) {
			const done = await worker(file, "malformed", offset).next("done");
			assert.equal(done.requests, 1, `attempt ${attempt + 1}`);
			offset += SECOND_DELAY + 1_000;
		}

		early.child.stdin?.write("go\n");
		const late = await early.next("done");
		assert.equal(late.requests, 0, "three attempts on disk: no fourth request");
		assert.equal(late.paused, true, "the owner is told");
		assert.equal(existsSync(claimFile(file)), false, "a process that leaves the work leaves no claim behind");
	});

	it("four processes, one of them on a snapshot older than the others' receipts, send three requests and no fourth", { timeout: 90_000 }, async () => {
		const file = sessionFile();
		// It appends its receipt under the leaf it read, beside the first process's: a sibling branch.
		const early = worker(file, "malformed", 3_600_000, true);
		cleanup.push(() => early.child.kill("SIGKILL"));
		await early.next("open");

		const first = await worker(file, "malformed", 0).next("done");
		early.child.stdin?.write("go\n");
		const second = await early.next("done");
		const third = await worker(file, "malformed", 2 * 3_600_000).next("done");
		// It opens the file with every receipt, on the branch of the latest one.
		const fourth = await worker(file, "malformed", 3 * 3_600_000).next("done");

		assert.deepEqual([first.requests, second.requests, third.requests, fourth.requests], [1, 1, 1, 0]);
		assert.equal(fourth.paused, true, "the owner is told");
		const starts = attemptEntries(piSdk.SessionManager.open(file)).filter((record) => record.type === "start");
		assert.equal(starts.length, ATTEMPT_LIMIT);
		assert.equal(new Set(starts.map((record) => (record as { key: string }).key)).size, 1, "one piece of work");
	});
});
