import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrackClient, LeaseLost, type LeaseStation, type RunSandy } from "./track.ts";

const station = (over: Partial<LeaseStation> = {}): LeaseStation => ({
	runId: "r1",
	ticket: "r1.4",
	track: "t",
	stage: "build",
	title: "Build",
	driver: { kind: "autopilot", name: "p" },
	cause: "advance",
	causeText: "the gate passed",
	inputs: {},
	submissions: { outputs: {}, evidence: [] },
	missingOutputs: ["result"],
	next: ["review"],
	work: null,
	outcome: null,
	previous: null,
	...over,
});

/** A fake sandy that answers each call with the next scripted reply and records the argv. */
function fakeSandy(...replies: unknown[]) {
	const calls: string[][] = [];
	const sandy: RunSandy = async (args) => {
		calls.push(args);
		const next = replies.shift();
		if (next === undefined) throw new Error("no scripted reply");
		if (next instanceof Error) throw next;
		return JSON.stringify(next);
	};
	return { sandy, calls };
}

const env = { SANDY_THREAD_ID: "thr_1" };
const fast = { sleep: async () => {}, heartbeatMs: 3_600_000, newInvocation: () => "inv1" };
const claimed = { kind: "claimed", grant: "r1.4.inv1", station: station(), heartbeatSec: 90 };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, messages: 1 };

test("no sandy thread, no track client", () => {
	assert.equal(createTrackClient({}), null);
});

test("start sends the skill or the machine JSON, drive-all names the autopilot, and returns the agent's ticket", async () => {
	const { sandy, calls } = fakeSandy({ kind: "started", ticket: "r1.1", station: station() }, { kind: "proposed" }, { kind: "refused", reasons: ["running"] });
	const client = createTrackClient(env, sandy, fast)!;
	assert.deepEqual(await client.start({ skill: "dev" }, { driveAll: { name: "delivery", args: "x" }, note: "why" }), { kind: "started", ticket: "r1.1" });
	assert.deepEqual(await client.start({ machine: { id: "m" } }), { kind: "proposed" });
	assert.deepEqual(await client.start({ skill: "dev" }), { kind: "refused", reasons: ["running"] });
	assert.deepEqual(calls, [
		["work", "track", "drive", "start", "--skill", "dev", "--note", "why", "--autopilot", "delivery", "--args", "x", "--json"],
		["work", "track", "drive", "start", "--machine", '{"id":"m"}', "--json"],
		["work", "track", "drive", "start", "--skill", "dev", "--json"],
	]);
});

test("openLease claims with a fresh invocation, retries while the policy is publishing, and a stale or closed ticket is LeaseLost", async () => {
	const { sandy, calls } = fakeSandy({ kind: "publishing", rev: 3 }, claimed, { kind: "stale", reason: "not current", current: null }, { kind: "closed", end: { kind: "expired", what: "launch" }, current: null });
	const client = createTrackClient(env, sandy, fast)!;
	const lease = await client.openLease("r1.4");
	assert.equal(lease.station.stage, "build");
	assert.deepEqual(calls[0], ["work", "track", "drive", "claim", "--ticket", "r1.4", "--invocation", "inv1", "--json"]);
	assert.equal(calls.length, 2);
	lease.close();
	await assert.rejects(client.openLease("r1.3"), (error: unknown) => error instanceof LeaseLost && error.end === null);
	await assert.rejects(client.openLease("r1.2"), (error: unknown) => error instanceof LeaseLost && error.end?.kind === "expired");
});

test("a command the plugin committed but could not publish is an error naming that, and is not sent again", async () => {
	const unpublished = { kind: "unpublished", rev: 7, error: "host unreachable" };
	const { sandy, calls } = fakeSandy(unpublished, claimed, unpublished);
	const client = createTrackClient(env, sandy, fast)!;
	await assert.rejects(client.start({ skill: "dev" }), /committed as rev 7, but the guard policy is not written \(host unreachable\)/);
	assert.equal(calls.length, 1, "a committed start is not repeated");
	const lease = await client.openLease("r1.4");
	await assert.rejects(lease.submit({ outputs: { result: "ok" } }), /sandy work track drive submit: committed as rev 7/);
	assert.equal(calls.length, 3, "a committed submit is not repeated");
	lease.close();
});

test("submit sends the grant and the measured usage; a refusal throws and keeps the lease", async () => {
	const accepted = station({ submissions: { outputs: { result: "ok" }, evidence: [] }, missingOutputs: [] });
	const { sandy, calls } = fakeSandy(claimed, { kind: "accepted", station: accepted }, { kind: "refused", reasons: ["Unknown outputs"] });
	const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4", { usage: () => usage });
	assert.deepEqual(await lease.submit({ outputs: { result: "ok" } }), accepted);
	assert.deepEqual(calls[1], ["work", "track", "drive", "submit", "--grant", "r1.4.inv1", "--outputs", '{"result":"ok"}', "--usage", JSON.stringify(usage), "--json"]);
	await assert.rejects(lease.submit({ outputs: { x: "1" } }), /refused: Unknown outputs/);
	assert.equal(lease.signal.aborted, false);
	lease.close();
});

test("run waits for the host-run command through status --lease and returns its exit code and tail", async () => {
	const ran = { kind: "ran", name: "tests", command: "npm test", exitCode: 1, durationMs: 5, tail: "1 failed", seq: 4, at: 1 };
	const { sandy, calls } = fakeSandy(
		claimed,
		{ kind: "pending", workId: 7 },
		{ kind: "current", station: station({ work: { kind: "run", id: 7 } }) },
		{ kind: "current", station: station({ outcome: { kind: "ran", workId: 7, label: "tests", exitCode: 1, delivered: true }, submissions: { outputs: {}, evidence: [ran] } }) },
	);
	const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
	assert.deepEqual(await lease.run({ label: "tests", command: "npm test", timeoutSec: 60 }), { exitCode: 1, tail: "1 failed" });
	assert.deepEqual(calls[1], ["work", "track", "drive", "run", "--grant", "r1.4.inv1", "--label", "tests", "--command", "npm test", "--timeout", "60", "--json"]);
	assert.deepEqual(calls[2], ["work", "track", "drive", "status", "--lease", "r1.4.inv1", "--json"]);
	lease.close();
});

test("advance resolves when the gate settles: entered once the lease closed as advanced, refused from the outcome, lost on another end", async () => {
	const review = station({ ticket: "r1.5", stage: "review", driver: { kind: "agent" } });
	{
		const { sandy } = fakeSandy(claimed, { kind: "pending", workId: 8 }, { kind: "current", station: station({ work: { kind: "gate", id: 8 } }) }, { kind: "closed", end: { kind: "advanced", to: "review" }, current: review });
		const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
		assert.deepEqual(await lease.advance({ to: "review" }), { kind: "entered", station: review });
		assert.equal(lease.signal.aborted, true);
		await assert.rejects(lease.submit({ outputs: {} }), LeaseLost);
		assert.deepEqual(await lease.release("done"), { released: false });
	}
	{
		const { sandy } = fakeSandy(claimed, { kind: "pending", workId: 8 }, { kind: "current", station: station({ outcome: { kind: "refused", workId: 8, reasons: ["check tests failed"], delivered: true } }) });
		const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
		assert.deepEqual(await lease.advance(), { kind: "refused", reasons: ["check tests failed"] });
		assert.equal(lease.signal.aborted, false);
		lease.close();
	}
	{
		const unsaved = { kind: "unsaved", workId: 8, what: "gate", reason: "too large", delivered: true };
		const { sandy } = fakeSandy(claimed, { kind: "pending", workId: 8 }, { kind: "current", station: station({ outcome: unsaved }) });
		const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
		assert.deepEqual(await lease.advance(), { kind: "refused", reasons: ["the gate result was not kept: too large"] }, "an unsaved gate result is a refusal the autopilot can act on");
		lease.close();
	}
	{
		const end = { kind: "forced", to: "plan", by: "owner" };
		const { sandy } = fakeSandy(claimed, { kind: "closed", end, current: null });
		const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
		assert.deepEqual(await lease.advance(), { kind: "lost", end });
	}
	{
		const { sandy } = fakeSandy(claimed, { kind: "finished" });
		const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
		assert.deepEqual(await lease.advance(), { kind: "finished" });
	}
});

test("a settled advance or force proposal still resolves when the heartbeat reads the closing reply first", async () => {
	const review = station({ ticket: "r1.5", stage: "review", driver: { kind: "agent" } });
	const cases: [string, unknown, (lease: Awaited<ReturnType<NonNullable<ReturnType<typeof createTrackClient>>["openLease"]>>) => Promise<unknown>, unknown][] = [
		["advance", { kind: "closed", end: { kind: "advanced", to: "review" }, current: review }, (lease) => lease.advance({ to: "review" }), { kind: "entered", station: review }],
		["proposeForce", { kind: "closed", end: { kind: "forced", to: "plan", by: "proposal" }, current: null }, (lease) => lease.proposeForce({ to: "plan", reason: "r" }), { approved: true }],
	];
	for (const [name, closing, act, expected] of cases) {
		let releaseSettle!: () => void;
		const settleWaits = new Promise<void>((resolve) => (releaseSettle = resolve));
		// Only the closing reply is scripted after pending: whoever polls first gets it, the other must not ask sandy again.
		const { sandy, calls } = fakeSandy(claimed, { kind: "pending", workId: 8 }, closing);
		const lease = await createTrackClient(env, sandy, { sleep: () => settleWaits, heartbeatMs: 1, newInvocation: () => "inv1" })!.openLease("r1.4");
		const result = act(lease);
		await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
		assert.equal(calls.at(-1)?.[3], "status", `${name}: the heartbeat read the closing reply`);
		releaseSettle();
		assert.deepEqual(await result, expected, `${name}: the pending call gets the cached closing reply`);
		assert.equal(calls.length, 3);
	}
});

test("a rejected force proposal keeps the lease; an approved one ends it", async () => {
	const { sandy, calls } = fakeSandy(claimed, { kind: "pending", workId: 9 }, { kind: "current", station: station({ outcome: { kind: "force-rejected", workId: 9, to: "plan", delivered: true } }) }, { kind: "pending", workId: 10 }, { kind: "closed", end: { kind: "forced", to: "plan", by: "proposal" }, current: null });
	const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4");
	assert.deepEqual(await lease.proposeForce({ to: "plan", reason: "input missing" }), { approved: false });
	assert.deepEqual(calls[1], ["work", "track", "drive", "propose-force", "--grant", "r1.4.inv1", "--to", "plan", "--reason", "input missing", "--json"]);
	assert.deepEqual(await lease.proposeForce({ to: "plan", reason: "input missing" }), { approved: true });
	assert.equal(lease.signal.aborted, true);
});

test("release hands the stage back once with the usage; a second release is a no-op", async () => {
	const { sandy, calls } = fakeSandy(claimed, { kind: "released" });
	const lease = await createTrackClient(env, sandy, fast)!.openLease("r1.4", { usage: () => null });
	assert.deepEqual(await lease.release("returned without advancing"), { released: true });
	assert.deepEqual(await lease.release("again"), { released: false });
	assert.deepEqual(calls[1], ["work", "track", "drive", "release", "--grant", "r1.4.inv1", "--reason", "returned without advancing", "--json"]);
	assert.equal(calls.length, 2);
});

test("the heartbeat renews the claim; a closed reply aborts the lease and later calls reject without asking sandy", async () => {
	const { sandy, calls } = fakeSandy(claimed, { kind: "current", station: station() }, { kind: "closed", end: { kind: "switched", to: { kind: "agent" } }, current: null });
	const lease = await createTrackClient(env, sandy, { ...fast, heartbeatMs: 5 })!.openLease("r1.4");
	await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve()));
	assert.deepEqual(calls.slice(1), [
		["work", "track", "drive", "status", "--lease", "r1.4.inv1", "--json"],
		["work", "track", "drive", "status", "--lease", "r1.4.inv1", "--json"],
	]);
	await assert.rejects(lease.submit({ outputs: {} }), (error: unknown) => error instanceof LeaseLost && error.end?.kind === "switched");
	assert.equal(calls.length, 3);
});
