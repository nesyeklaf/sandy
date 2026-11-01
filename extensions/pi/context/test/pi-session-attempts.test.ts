import assert from "node:assert/strict";
import { appendFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { AttemptEntry } from "../src/core/attempts.ts";
import { ATTEMPT_KIND } from "../src/core/kinds.ts";
import { customRecords, SessionReceipts } from "../src/pi/session-attempts.ts";
import { tempDir } from "./support/lifecycle.ts";

/*
 * The reader of a session file's receipts. It reads only what was appended since its last read, as long as it can
 * prove the file only grew; a file replaced or rewritten in place is read again from the start.
 */

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-10-09T12:00:00.000Z", cwd: "/" });
const line = (entryId: string, data: AttemptEntry) =>
	JSON.stringify({ type: "custom", id: entryId, parentId: null, timestamp: "2026-10-09T12:00:00.000Z", customType: ATTEMPT_KIND, data }) + "\n";
const start = (entryId: string, key: string, at = 1) => line(entryId, { type: "start", id: "request-" + entryId, key, at, throughId: "t" });
const failed = (entryId: string, startedBy: string, key: string) =>
	line(entryId, { type: "end", id: "request-" + startedBy, key, at: 2, outcome: "failed" });
const message = (entryId: string, text: string) =>
	JSON.stringify({ type: "message", id: entryId, parentId: null, timestamp: "2026-10-09T12:00:00.000Z", message: { role: "user", content: text } }) + "\n";
const local = (entryId: string, data: AttemptEntry) => ({ type: "custom", id: entryId, customType: ATTEMPT_KIND, data });

describe("SessionReceipts", () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	function file(text: string): string {
		const dir = tempDir();
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "session.jsonl");
		writeFileSync(path, header + "\n" + text);
		return path;
	}

	const count = (reader: SessionReceipts, key: string) => reader.read([]).unfinished.get(key)?.length ?? 0;

	it("reads what was appended since its last read, also a line written in two pieces", () => {
		const path = file(start("e1", "k"));
		const reader = new SessionReceipts(path);
		assert.equal(count(reader, "k"), 1);
		const next = start("e2", "k");
		appendFileSync(path, next.slice(0, 40));
		assert.equal(count(reader, "k"), 1);
		appendFileSync(path, next.slice(40));
		assert.equal(count(reader, "k"), 2);
	});

	it("reads a file replaced by one of the same size again", () => {
		const path = file(start("e1", "old-1") + start("e2", "old-2"));
		const reader = new SessionReceipts(path);
		assert.equal(count(reader, "old-1"), 1);
		const replacement = path + ".new";
		writeFileSync(replacement, header + "\n" + start("e1", "new-1") + start("e2", "new-2"));
		assert.equal(statSync(replacement).size, statSync(path).size);
		renameSync(replacement, path);
		assert.equal(count(reader, "old-1"), 0, "records of the replaced file are gone");
		assert.equal(count(reader, "new-1"), 1);
		assert.equal(count(reader, "new-2"), 1);
	});

	it("reads a longer replacement with receipts before the old end again", () => {
		const path = file(message("m1", "hello") + message("m2", "world"));
		const reader = new SessionReceipts(path);
		assert.equal(count(reader, "k"), 0);
		const replacement = path + ".new";
		writeFileSync(replacement, header + "\n" + start("e1", "k") + start("e2", "k") + start("e3", "k") + message("m1", "hello") + message("m2", "world"));
		renameSync(replacement, path);
		assert.equal(count(reader, "k"), 3);
	});

	it("reads a file truncated and written again on the same inode", () => {
		const path = file(message("m1", "hello") + start("e1", "k"));
		const reader = new SessionReceipts(path);
		assert.equal(count(reader, "k"), 1);
		const inode = statSync(path).ino;
		writeFileSync(path, header + "\n" + start("e0", "other") + message("m1", "hello") + start("e1", "k") + start("e2", "k"));
		assert.equal(statSync(path).ino, inode);
		assert.equal(count(reader, "other"), 1, "the record before the old end is read");
		assert.equal(count(reader, "k"), 2, "no record is read twice");
	});

	it("folds the file's records in order, then this process's records the file does not hold, each id once", () => {
		const path = file(start("e1", "k") + failed("e2", "e1", "k"));
		const reader = new SessionReceipts(path);
		const read = reader.read([
			local("e1", { type: "start", id: "request-e1", key: "k", at: 1, throughId: "t" }),
			local("e3", { type: "start", id: "request-e3", key: "k", at: 3, throughId: "t" }),
		]);
		assert.deepEqual(read.unfinished.get("k")?.map((attempt) => [attempt.id, attempt.outcome]), [["request-e1", "failed"], ["request-e3", "open"]]);
		appendFileSync(path, line("e4", { type: "retry", at: 4 }));
		assert.equal(reader.read([]).unfinished.size, 0, "a retry clears what precedes it in the stream");
		assert.equal(reader.read([local("e5", { type: "start", id: "request-e5", key: "k", at: 5, throughId: "t" })]).unfinished.get("k")?.length, 1);
	});

	it("names work whose summary was stored", () => {
		const path = file(start("e1", "k") + line("e2", { type: "end", id: "request-e1", key: "k", at: 2, outcome: "stored" }));
		const read = new SessionReceipts(path).read([]);
		assert.equal(read.unfinished.size, 0);
		assert.deepEqual([...read.stored], ["k"]);
	});

	it("reads only this process's records when the session has no file", () => {
		const read = new SessionReceipts(undefined).read([local("e1", { type: "start", id: "request-e1", key: "k", at: 1, throughId: "t" })]);
		assert.equal(read.unfinished.get("k")?.length, 1);
	});
});

describe("customRecords", () => {
	it("reads one kind's records as the file grows, whoever appended them, and nothing else", () => {
		const dir = tempDir();
		try {
			const path = join(dir, "session.jsonl");
			const custom = (entryId: string, customType: string, data: unknown) =>
				JSON.stringify({ type: "custom", id: entryId, parentId: null, timestamp: "2026-10-09T12:00:00.000Z", customType, data }) + "\n";
			writeFileSync(path, header + "\n" + custom("e1", "kind-a", { n: 1 }) + custom("e2", "kind-b", { n: 2 }) + message("e3", "kind-a in a message"));
			const reader = customRecords(path, "kind-a", (data) => (data as { n?: number }).n);
			assert.deepEqual(reader.read(), [1]);
			appendFileSync(path, custom("e4", "kind-a", { n: 4 }));
			assert.deepEqual(reader.read(), [1, 4]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
