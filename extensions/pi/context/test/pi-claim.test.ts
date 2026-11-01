import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { CLAIM_STALE_MS, claimFile, FileClaim } from "../src/pi/claim.ts";

/* The claim file on its own, with records other hosts or dead processes left behind. */

describe("the historian's claim file", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const session = () => {
		const dir = mkdtempSync(join(tmpdir(), "claim-"));
		dirs.push(dir);
		return join(dir, "session.jsonl");
	};
	const foreign = (file: string, record: Record<string, unknown>) => writeFileSync(claimFile(file), JSON.stringify(record));

	it("one holder at a time; released, it is gone and the next takes it", () => {
		const file = session();
		const one = new FileClaim(file);
		const two = new FileClaim(file);
		assert.equal(one.acquire(), true);
		one.working("k1");
		assert.equal(JSON.parse(readFileSync(claimFile(file), "utf8")).key, "k1");
		assert.equal(two.acquire(), false);
		one.release();
		assert.equal(existsSync(claimFile(file)), false);
		assert.equal(two.acquire(), true);
		assert.equal(one.held(), false);
		two.release();
	});

	it("takes over from a process on this host that is gone", () => {
		const file = session();
		// pid 2^22 + 1 is above Linux's pid_max, so no process has it.
		foreign(file, { pid: 4_194_305, host: hostname(), heartbeat: Date.now(), nonce: "x" });
		const claim = new FileClaim(file);
		assert.equal(claim.acquire(), true);
		claim.release();
	});

	it("leaves another host's claim alone while its heartbeat is fresh, and takes it once it stopped", () => {
		const file = session();
		const time = { now: 1_000_000 };
		foreign(file, { pid: 1, host: "elsewhere", heartbeat: time.now, nonce: "x" });
		const claim = new FileClaim(file, () => time.now);
		assert.equal(claim.acquire(), false);
		time.now += CLAIM_STALE_MS;
		assert.equal(claim.acquire(), true);
		assert.equal(claim.held(), true);
		claim.release();
	});

	it("a holder whose file was taken over notices before its next request", () => {
		const file = session();
		const time = { now: 1_000_000 };
		const slow = new FileClaim(file, () => time.now);
		assert.equal(slow.acquire(), true);
		const other = new FileClaim(file, () => time.now + CLAIM_STALE_MS);
		// The holder's heartbeat looks stopped to the other, as after the machine slept with the holder mid-request.
		assert.equal(other.acquire(), true);
		assert.equal(slow.held(), false);
		slow.release();
		assert.equal(other.held(), true, "the old holder's release leaves the new holder's file alone");
		other.release();
	});
});
