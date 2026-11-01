import assert from "node:assert/strict";
import { test } from "node:test";
import { autopilotApi, deliver, handleLeaseCommand, settledSession } from "./autopilot.ts";
import { LeaseLost, type LeaseStation, type LeaseTrack, type TrackClient } from "./track.ts";
import { LEASE_MARKER, type SessionEntryLike } from "./usage.ts";

const noWait = async () => {};

test("a report that fails once is retried until it lands", async () => {
	const sent: unknown[] = [];
	let failures = 1;
	await deliver(async (value) => {
		if (failures-- > 0) throw new Error("sandy busy");
		sent.push(value);
	}, { ok: 1 }, noWait);
	assert.deepEqual(sent, [{ ok: 1 }]);
});

test("a value that never lands is replaced by an error value, so the call still ends", async () => {
	const sent: unknown[] = [];
	await deliver(async (value) => {
		if (!(value && typeof value === "object" && "error" in value)) throw new Error("value rejected by the schema");
		sent.push(value);
	}, { big: true }, noWait);
	assert.deepEqual(sent, [{ error: "could not report the autopilot result: value rejected by the schema" }]);
});

test("when even the error value cannot be reported, deliver throws", async () => {
	await assert.rejects(
		deliver(async () => {
			throw new Error("sandy missing");
		}, 1, noWait),
		/sandy missing/,
	);
});

// ---- /autopilot --lease (Track drivers v2, sandy/work/track/docs/design-v2.md §7) -----------------------------------------

const station = { runId: "r1", ticket: "r1.4", track: "t", stage: "build", title: "Build", driver: { kind: "autopilot", name: "p" }, missingOutputs: [] } as unknown as LeaseStation;

function harness(options: { claim?: () => Promise<void>; run?: (lease: LeaseTrack) => Promise<unknown>; turnStarted?: (ms: number) => Promise<boolean> } = {}) {
	const log: unknown[][] = [];
	const controller = new AbortController();
	let usageOption: (() => unknown) | undefined;
	const lease: LeaseTrack = {
		station,
		signal: controller.signal,
		submit: async () => station,
		run: async () => ({ exitCode: 0, tail: "" }),
		advance: async () => {
			controller.abort();
			return { kind: "entered", station };
		},
		proposeForce: async () => ({ approved: false }),
		release: async (reason) => {
			log.push(["release", reason]);
			return { released: true };
		},
		close: () => log.push(["close"]),
	};
	const client: TrackClient = {
		start: async () => ({ kind: "proposed" }),
		status: async () => station,
		openLease: async (ticket, opts) => {
			log.push(["claim", ticket]);
			usageOption = opts?.usage;
			await options.claim?.();
			return lease;
		},
	};
	const branch: SessionEntryLike[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			log.push(["marker", customType, data]);
			branch.push({ type: "custom", id: String(branch.length), customType, data });
		},
		sendMessage: (message: { content: string }, opts?: { triggerTurn?: boolean }) => log.push(["message", message.content, opts?.triggerTurn]),
	};
	const deps = {
		pi,
		client,
		branch: () => branch,
		turnStarted: options.turnStarted ?? (async (ms: number) => (log.push(["watch", ms]), true)),
		run: options.run ?? (async () => {
			log.push(["run"]);
			return { done: true };
		}),
	};
	return { log, deps, lease, usage: () => usageOption?.(), branch };
}

test("a launched lease is claimed, marked, run right away without an opening turn, and released when the autopilot returns still holding it", async () => {
	const { log, deps, usage, branch } = harness();
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "x" }, deps);
	assert.deepEqual(log[0], ["claim", "r1.4"]);
	assert.deepEqual(log[1], ["marker", LEASE_MARKER, { ticket: "r1.4" }]);
	assert.deepEqual(log[2], ["watch", 90_000], "it watches for the autopilot's first turn, well inside sandy's 120 s turn-start timeout");
	assert.deepEqual(log[3], ["run"]);
	assert.deepEqual(log[4], ["release", "autopilot p returned without advancing"]);
	assert.deepEqual(log[5], ["close"]);
	assert.deepEqual(log[6], ["message", '[autopilot] p -> {"done":true}', false]);
	assert.equal(log.length, 7, "no opening message");
	branch.push({ type: "message", id: "m", message: { role: "assistant", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } } });
	assert.deepEqual(usage(), { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, messages: 1 });
});

test("the autopilot gets the lease; once its advance ended the lease nothing is released", async () => {
	let given: LeaseTrack | undefined;
	const { log, deps, lease } = harness({
		run: async (l) => {
			given = l;
			return await l.advance();
		},
	});
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, deps);
	assert.equal(given, lease);
	assert.equal(log.some((entry) => entry[0] === "release"), false);
	assert.deepEqual(log.at(-2), ["close"]);
});

test("an autopilot that throws releases the stage with the error", async () => {
	const { log, deps } = harness({
		run: async () => {
			throw new Error("boom");
		},
	});
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, deps);
	assert.deepEqual(log.find((entry) => entry[0] === "release"), ["release", "autopilot p failed: boom"]);
	assert.deepEqual(log.at(-1), ["message", "[autopilot] p failed: boom", false]);
});

test("a stale launch still opens a turn, so sandy's command turn ends, and runs nothing", async () => {
	let ran = false;
	const { log, deps } = harness({
		claim: async () => {
			throw new LeaseLost({ kind: "forced", to: "plan" });
		},
		run: async () => (ran = true),
	});
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, deps);
	assert.equal(ran, false);
	assert.equal(log.length, 2);
	assert.match(log[1][1] as string, /stale launch.*forced.*Reply only with: ok/s);
	assert.equal(log[1][2], true);
});

test("outside a sandy thread a lease launch only opens the turn", async () => {
	const { log, deps } = harness();
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, { ...deps, client: null });
	assert.equal(log.length, 1);
	assert.equal(log[0][2], true);
});

test("an autopilot's api.session is bound to its lease's signal; a plain /autopilot session is unbound", () => {
	const bound: (AbortSignal | undefined)[] = [];
	const sessionFor = (_ctx: unknown, options?: { signal?: AbortSignal }) => (bound.push(options?.signal), {}) as never;
	const lease = { signal: new AbortController().signal } as LeaseTrack;
	assert.equal(autopilotApi({ pi: {}, sessionFor, track: null }, {}, lease).lease, lease);
	autopilotApi({ pi: {}, sessionFor, track: null }, {}, null);
	assert.deepEqual(bound, [lease.signal, undefined]);
});

/** A promise the test settles itself. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

test("an autopilot that starts no turn within 90 s gets one fallback opening turn, so sandy's command turn ends; its run goes on", async () => {
	const started = deferred<boolean>();
	const running = deferred<unknown>();
	const { log, deps } = harness({ turnStarted: () => started.promise, run: () => running.promise });
	const done = handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, deps);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(log.some((entry) => entry[0] === "message"), false, "nothing is sent while the window is open");
	started.resolve(false);
	await new Promise((resolve) => setImmediate(resolve));
	const opening = log.filter((entry) => entry[0] === "message");
	assert.equal(opening.length, 1);
	assert.match(opening[0]![1] as string, /p drives stage "Build".*Reply only with: ok/s);
	assert.equal(opening[0]![2], true);
	running.resolve({ done: true });
	await done;
	assert.deepEqual(log.filter((entry) => entry[0] === "message").at(-1), ["message", '[autopilot] p -> {"done":true}', false], "the result does not open a second turn");
});

test("an autopilot that returns before any turn started ends sandy's command turn with its result, and the window sends nothing more", async () => {
	const started = deferred<boolean>();
	const { log, deps } = harness({ turnStarted: () => started.promise });
	await handleLeaseCommand({ ticket: "r1.4", name: "p", args: "" }, deps);
	const messages = () => log.filter((entry) => entry[0] === "message");
	assert.equal(messages().length, 1);
	assert.match(messages()[0]![1] as string, /^\[autopilot\] p -> \{"done":true\}\nReply only with: ok$/);
	assert.equal(messages()[0]![2], true);
	started.resolve(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(messages().length, 1);
});

test("a lease's api.session waits for a settled session before every step; a plain /autopilot session does not", () => {
	const bindings: ({ signal?: AbortSignal; settled?: () => Promise<void> } | undefined)[] = [];
	const sessionFor = (_ctx: unknown, binding?: (typeof bindings)[number]) => (bindings.push(binding), {}) as never;
	const lease = { signal: new AbortController().signal } as LeaseTrack;
	autopilotApi({ pi: {}, sessionFor, track: null }, {}, lease);
	autopilotApi({ pi: {}, sessionFor, track: null }, {}, null);
	assert.equal(typeof bindings[0]?.settled, "function");
	assert.equal(bindings[1], undefined);
});

test("settledSession waits for a turn that starts only after the first idle check", async () => {
	let idle = true;
	let polls = 0;
	const ctx = {
		waitForIdle: async () => {},
		isIdle: () => {
			polls++;
			if (polls === 1) {
				idle = false;
				setTimeout(() => (idle = true), 5);
				return false;
			}
			return idle;
		},
		hasPendingMessages: () => false,
	};
	await settledSession(ctx, 10);
	assert.ok(polls >= 2);
});

test("review v2-4 F1: a lease's api.session reports turn requests to the fallback watch; a plain /autopilot session has no binding", () => {
	const bindings: ({ turnRequested?: () => void } | undefined)[] = [];
	const sessionFor = (_ctx: unknown, binding?: (typeof bindings)[number]) => (bindings.push(binding), {}) as never;
	const lease = { signal: new AbortController().signal } as LeaseTrack;
	const turnRequested = () => {};
	autopilotApi({ pi: {}, sessionFor, track: null, turnRequested }, {}, lease);
	assert.equal(bindings[0]?.turnRequested, turnRequested);
});
