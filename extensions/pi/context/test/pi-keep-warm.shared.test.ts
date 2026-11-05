import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { accountingEvents, reduceAccounting } from "../src/core/accounting.ts";
import { KEEP_WARM_KIND } from "../src/core/kinds.ts";
import { FakeAnthropic, type FakeRequest } from "./support/anthropic-server.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";
import { START, waitingSession } from "./support/waiting-session.ts";

/*
 * The keep-warm ping shares the cache window with pi's own warmer and with other pi processes on the session file:
 * pi's warmer is stopped only while a ping of ours will run, never two requests pay for one window, and the replay
 * goes out with the headers the main request had. Rig: support/waiting-session.ts.
 */

const VERSION = piSdk.VERSION;
const warmingDecision = { type: "cache_warming_decision", warmCost: 1, missCost: 2, continuationProbability: 1, action: "warm" } as const;
type Session = Awaited<ReturnType<typeof waitingSession>>;
const decide = (s: Session) => s.runtime.session.extensionRunner.emitCacheWarmingDecision(warmingDecision);

describe(`the keep-warm ping next to pi's warmer and other processes on pi ${VERSION}`, () => {
	let retention: string | undefined;
	beforeEach(() => {
		retention = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "short";
	});
	afterEach(() => {
		if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = retention;
	});

	it("leaves pi's warmer its decision when the request the ping would replay changed", async () => {
		const s = await waitingSession({
			later: (pi) => {
				pi.on("before_provider_request", (event) => {
					(event.payload as Record<string, unknown>).metadata = { user_id: "changed" };
					return undefined;
				});
			},
		});
		try {
			await s.runtime.session.prompt("Say done.");
			s.expectPrompt(START + 900_000);
			assert.equal(await decide(s), "warm");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("leaves pi's warmer its decision when the signal has expired, and stops it again when a fresh one comes", async () => {
		const s = await waitingSession();
		try {
			await s.runtime.session.prompt("Say done.");
			s.expectPrompt(START + 900_000);
			assert.equal(await decide(s), "stop");
			s.expectPrompt(START + 1);
			assert.equal(await decide(s), "warm", "the next prompt is expected before the cache expires: no ping, pi decides");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("leaves pi's warmer its decision while the agent streams, and after our ping failed", async () => {
		const s = await waitingSession();
		let release = () => {};
		try {
			await s.runtime.session.prompt("Say done.");
			s.expectPrompt(START + 900_000);
			assert.equal(await decide(s), "stop");
			// The second main request is held open: the agent is not idle, our timer does not tick, pi's warmer is the only one.
			s.server.responder = async () => {
				await new Promise<void>((resolve) => (release = resolve));
				return [{ type: "text", text: "done" }];
			};
			const turn = s.runtime.session.prompt("More.");
			await s.waitFor(() => s.server.requests.length === 2);
			assert.equal(await decide(s), "warm", "streaming");
			release();
			await turn;
			// A ping that fails leaves the window to pi.
			s.server.responder = () => {
				throw new Error("HTTP 500");
			};
			s.clock(START + 90_000 + 250_000);
			s.expectPrompt(START + 2_000_000);
			await s.waitFor(() => s.warmRecords().length === 2);
			assert.equal(s.pings().length, 1);
			assert.equal(await decide(s), "warm", "the failed ping was the one try of this window");
		} finally {
			release();
			await s.close();
		}
	}, 30_000);

	it("does not send a ping while pi's own warmer has a request in flight", async () => {
		const s = await waitingSession({ model: "claude-opus-5-5", settings: { cacheWarming: "idle" } });
		let release = () => {};
		try {
			await s.runtime.session.prompt(`Say done. ${"cache ".repeat(70_000)}`);
			s.server.responder = async () => {
				await new Promise<void>((resolve) => (release = resolve));
				return [{ type: "text", text: "done" }];
			};
			const warmer = (s.runtime.session as unknown as { _cacheWarmer: { run: unknown; refresh(run: unknown): Promise<void> } })._cacheWarmer;
			assert.ok(warmer.run, "pi armed its warmer");
			const native = warmer.refresh(warmer.run);
			await s.waitFor(() => s.server.requests.length === 2);
			assert.equal(s.pings().length, 1, "pi's refresh is out");
			s.expectPrompt(START + 900_000);
			s.clock(START + 250_000);
			await s.settle(200);
			assert.equal(s.pings().length, 1, "our ping waits for it");
			assert.equal(s.warmRecords().length, 0);
			release();
			await native;
		} finally {
			release();
			await s.close();
		}
	}, 30_000);

	it("sends the ping with the headers the main request left with", async () => {
		const s = await waitingSession({
			later: (pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-required-route"] = "main-only";
				});
			},
		});
		try {
			await s.runtime.session.prompt("Say done.");
			s.expectPrompt(START + 900_000);
			s.clock(START + 250_000);
			await s.waitFor(() => s.pings().length === 1);
			const header = (request?: FakeRequest) => request?.headers?.["x-required-route"];
			assert.equal(header(s.server.requests[0]), "main-only");
			assert.equal(header(s.pings()[0]), "main-only");
			assert.ok(s.pings()[0]?.headers?.["x-api-key"], "the credential is pi's own");
		} finally {
			await s.close();
		}
	}, 30_000);

	it("hides a ping turn an earlier version left in the session from the model, and counts the new records", async () => {
		const manager = piSdk.SessionManager.inMemory();
		const log = sessionLog(manager);
		log.user("before");
		log.answer("normal answer");
		manager.appendCustomMessageEntry(KEEP_WARM_KIND, "Keep-warm ping from the context engine, not from the user. Reply only with: ok", false);
		log.answer("ok");
		const s = await waitingSession({ shared: { manager, server: await new FakeAnthropic().start(), signalFile: join(mkdtempSync(join(tmpdir(), "warm-")), "signal.json") } });
		try {
			await s.runtime.session.prompt("after");
			const sent = JSON.stringify(s.server.requests[0]?.body.messages);
			assert.match(sent, /normal answer/);
			assert.doesNotMatch(sent, /Keep-warm ping/);
		} finally {
			await s.close();
		}
	}, 30_000);

	it("sends one ping for two pi processes on the same session file", async () => {
		const server = await new FakeAnthropic().start();
		const dir = mkdtempSync(join(tmpdir(), "context-warm-shared-"));
		const signal = join(dir, "signal.json");
		const children: ReturnType<typeof fork>[] = [];
		const spawn = async (file?: string) => {
			const child = fork(join(import.meta.dirname, "support/keep-warm-worker.ts"), [], {
				execArgv: ["--experimental-strip-types"],
				env: { ...process.env, SERVER: server.baseUrl, SIGNAL: signal, SESSION: file ?? "", PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "context-warm-agent-")) },
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});
			children.push(child);
			return await new Promise<{ file: string }>((resolve, reject) => {
				child.once("message", (message) => resolve(message as { file: string }));
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
			});
		};
		try {
			const manager = piSdk.SessionManager.create(process.cwd(), dir);
			const log = sessionLog(manager);
			log.user("seed");
			log.answer("seed done");
			const first = await spawn(manager.getSessionFile());
			const second = await spawn(first.file);
			const prompted = children.map((child) => new Promise((resolve) => child.once("message", resolve)));
			for (const child of children) child.send("prompt");
			await Promise.all(prompted);
			const mains = server.requests.length;
			writeFileSync(signal, JSON.stringify({ until: START + 900_000 }));
			for (const child of children) child.send("arm");
			const pings = () => server.requests.filter((request) => request.body.max_tokens === 1);
			for (let wait = 0; wait < 300 && pings().length < 1; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
			// Long enough for the other process to tick several times.
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(second.file, first.file);
			assert.equal(server.requests.length, mains + 1, "one ping for the two processes");
		} finally {
			for (const child of children) {
				const exit = new Promise((resolve) => child.once("exit", resolve));
				child.send("stop");
				await exit;
			}
			await server.stop();
		}
	}, 40_000);
});
