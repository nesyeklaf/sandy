import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { accountingEvents, reduceAccounting } from "../src/core/accounting.ts";
import { stableStringify } from "../src/core/continuity.ts";
import type { FakeRequest } from "./support/anthropic-server.ts";
import { signalFile, withoutPings } from "../src/pi/keep-warm.ts";
import { piSdk } from "./support/pi.ts";
import { ANSWER_MS, START, TTL_MS, waitingSession } from "./support/waiting-session.ts";

/** A waiting session stays warm with a one-token side request; see support/waiting-session.ts for the rig. */

const VERSION = piSdk.VERSION;

describe(`the keep-warm side request on pi ${VERSION}`, () => {
	// The 5 minute cache of the default tier, whatever the environment of the run asks for.
	let retention: string | undefined;
	beforeEach(() => {
		retention = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "short";
	});
	afterEach(() => {
		if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = retention;
	});

	it("replays the last main request with one output token and no session message, and records its usage", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			const main = s.server.requests[0] as FakeRequest;
			assert.equal(main.body.thinking && (main.body.thinking as { type: string }).type, "adaptive", "the fixture's main request thinks adaptively");
			const before = s.messages();
			// 4:10 into a 5 minute cache that started with the request: inside the lead, before the expiry.
			s.clock(START + 250_000);
			s.expectPrompt(START + 3 * TTL_MS);
			await s.waitFor(() => s.pings().length > 0);
			await s.settle();
			assert.equal(s.pings().length, 1, "exactly one side request");
			const ping = s.pings()[0] as FakeRequest;
			const { max_tokens: sent, ...sentRest } = ping.body;
			const { max_tokens: _main, ...mainRest } = main.body;
			assert.equal(sent, 1);
			assert.equal(stableStringify(sentRest), stableStringify(mainRest), "the ping is the captured request, nothing else changed");
			assert.ok(ping.cacheRead > 0, "the ping read the cached prompt");
			assert.equal(s.messages(), before, "no session message, so no agent turn and no tool");
			const records = s.warmRecords();
			assert.deepEqual(records.map((record) => record.type), ["start", "end"], "a receipt before the send, the usage after");
			assert.equal(records[1]?.outcome, "warmed");
			assert.ok(((records[1]?.usage as { cacheRead: number }).cacheRead ?? 0) > 0);
			assert.equal(records[0]?.at, START + 250_000, "the record carries the ping's own request start, when it left");
			const report = reduceAccounting(accountingEvents(s.entries() as never));
			assert.equal(report.bySource["keep-warm"].requests, 1, "a charge of its own source");
			assert.equal(report.unknown, 0);
			assert.ok(report.engineCounted.cacheRead > 0, "counted by the engine, not by pi");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("does not ping into a cache that expired when the answered request started", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			// The answer ended 90 s after the request started; 4:05 after the answer is 5:35 after the start: expired.
			s.clock(START + ANSWER_MS + 245_000);
			s.expectPrompt(START + 3 * TTL_MS);
			await s.settle(300);
			assert.equal(s.pings().length, 0);
			assert.equal(s.warmRecords().length, 0);
		} finally {
			await s.close();
		}
	}, 30_000);

	it("counts the next window from the ping's own request start", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			s.expectPrompt(START + 4 * TTL_MS);
			s.clock(START + 250_000);
			await s.waitFor(() => s.pings().length > 0);
			await s.settle();
			s.clock(START + 400_000);
			await s.settle(200);
			assert.equal(s.pings().length, 1, "the ping kept the cache alive until its own expiry: not yet due");
			s.clock(START + 250_000 + 250_000);
			await s.waitFor(() => s.pings().length > 1);
			assert.equal(s.pings().length, 2);
		} finally {
			await s.close();
		}
	}, 30_000);

	it("leaves no unplanned cache break in the ledger when a prompt follows a ping", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			s.clock(START + 250_000);
			s.expectPrompt(START + 3 * TTL_MS);
			await s.waitFor(() => s.pings().length > 0);
			await s.settle();
			assert.equal(s.pings().length, 1, "the fixture pinged");
			s.removeSignal();
			await s.runtime.session.prompt("And again.");
			const mains = s.server.requests.filter((request) => request.body.max_tokens !== 1);
			assert.equal(mains.length, 2);
			assert.ok((mains[1] as FakeRequest).cacheRead > 0, "the prompt after the ping reads the cache");
			const classes = s.ledger().map((line) => line.class);
			assert.deepEqual(classes.filter((name) => name === "unplanned" || name === "keep-warm"), [], "neither an unplanned break nor a ping line");
			assert.deepEqual(classes.filter((name) => ["first", "continued"].includes(name as string)), ["first", "continued"]);
		} finally {
			await s.close();
		}
	}, 30_000);

	it("stops pi's own warmer while the ping owns the window, and leaves it alone otherwise", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			const decide = () =>
				s.runtime.session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 1, missCost: 2, continuationProbability: 1, action: "warm" });
			assert.equal(await decide(), "warm", "no signal: pi decides");
			s.expectPrompt(START + 3 * TTL_MS);
			assert.equal(await decide(), "stop", "a signal and a replayable capture: the ping owns the window");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("sends no ping for a fixed thinking budget and leaves pi's own warmer alone", async () => {
		const s = await waitingSession({ model: "claude-haiku-4-5" });
		try {
			await s.runtime.session.prompt("Say done.");
			assert.equal((s.server.requests[0]?.body.thinking as { type: string }).type, "enabled", "the fixture asks for a fixed budget");
			s.clock(START + 250_000);
			s.expectPrompt(START + 3 * TTL_MS);
			await s.settle(300);
			assert.equal(s.pings().length, 0);
			const decision = await s.runtime.session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 1, missCost: 2, continuationProbability: 1, action: "warm" });
			assert.equal(decision, "warm");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("stops pinging for the session after a ping the cache did not answer", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			s.server.forget();
			s.clock(START + 250_000);
			s.expectPrompt(START + 6 * TTL_MS);
			await s.waitFor(() => s.pings().length > 0);
			await s.settle();
			assert.equal(s.warmRecords().at(-1)?.outcome, "missed");
			s.clock(START + 250_000 + 250_000);
			await s.settle(300);
			assert.equal(s.pings().length, 1, "no second ping");
			const decision = await s.runtime.session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 1, missCost: 2, continuationProbability: 1, action: "warm" });
			assert.equal(decision, "warm", "pi's warmer is not held back by a ping that stopped");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("sends no ping when a later handler changed the request pi sent", async () => {
		const s = await waitingSession({
			later: (pi) => {
				pi.on("before_provider_request", (event) => {
					(event.payload as Record<string, unknown>).metadata = { user_id: "someone" };
					return undefined;
				});
			},
		});
		try {
			await s.runtime.session.prompt("Say done.");
			s.clock(START + 250_000);
			s.expectPrompt(START + 3 * TTL_MS);
			await s.settle(300);
			assert.equal(s.pings().length, 0);
		} finally {
			await s.close();
		}
	}, 30_000);
});

describe("old ping turns in the model view", () => {
	const ping = (customType: string) => ({ role: "custom", customType });
	it("leaves out a whole old ping turn, a tool call it made and the tool's result too, once a later message follows", () => {
		for (const customType of ["sandy-context.keep-warm", "context.keep-warm"]) {
			const turn = [ping(customType), { role: "assistant", id: "call" }, { role: "toolResult", id: "result" }, { role: "assistant", id: "answer" }];
			const before = [{ role: "user", id: "u1" }, { role: "assistant", id: "a1" }];
			const after = [{ role: "user", id: "u2" }];
			assert.deepEqual(withoutPings([...before, ...turn, ...after]), [...before, ...after], customType);
			assert.deepEqual(withoutPings([...before, ...turn]), [...before, ...turn], "a ping with nothing after it left the view");
		}
	});
});

describe("where a session looks for its keep-warm signal", () => {
	it("reads Sandy's thread storage, then BB's from before the rename, then the agent directory", () => {
		assert.equal(signalFile({ SANDY_THREAD_STORAGE: "/t/sandy", BB_THREAD_STORAGE: "/t/bb" }, "/agent", "s1"), "/t/sandy/pi-keep-warm.json");
		assert.equal(signalFile({ BB_THREAD_STORAGE: "/t/bb" }, "/agent", "s1"), "/t/bb/pi-keep-warm.json");
		assert.equal(signalFile({ SANDY_THREAD_STORAGE: "" }, "/agent", "s1"), "/agent/context/keep-warm/s1.json");
	});
});
