import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { FakeAnthropic, type FakeRequest } from "./support/anthropic-server.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";
import { citingAnswer } from "./support/historian.ts";
import { START, TTL_MS, waitingSession } from "./support/waiting-session.ts";

/*
 * The keep-warm ping and the historian's fork read the same cached prefix: the captured main request. One clock says
 * when that prefix was last read, and one refresh at a time keeps it, so an idle window is paid once. Rig:
 * support/waiting-session.ts with the historian forking; a UI lets the last turn schedule the historian.
 */

const VERSION = piSdk.VERSION;
const isFork = (request: FakeRequest) => JSON.stringify(request.body.messages).includes("A separate task follows.");
const quiet = () => {};
const ui = { notify: quiet, setStatus: quiet, setWidget: quiet, setFooter: quiet, setHeader: quiet, setTitle: quiet, setWorkingMessage: quiet, setEditorText: quiet };
/** The text of a request's last message: the evidence a summary request shows. */
function lastText(request: FakeRequest): string {
	const content = (request.body.messages as { content: string | { text?: string }[] }[]).at(-1)?.content;
	return typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n");
}
/** A promise the test opens: a stand-in answer waits on it. */
function gate(): { shut: Promise<void>; open: () => void } {
	let open = () => {};
	const shut = new Promise<void>((resolve) => (open = resolve));
	return { shut, open };
}
const historian = { enabled: true, fork: true, model: "anthropic/claude-fable-5", startTokens: 1_000, chunkMinTokens: 1_000, chunkMaxTokens: 3_000, maxOutputTokens: 1_000 };

describe(`keep-warm and the historian's fork on one cache clock, on pi ${VERSION}`, () => {
	let retention: string | undefined;
	beforeEach(() => {
		retention = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "short";
	});
	afterEach(() => {
		if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = retention;
	});

	it("sends no ping while a fork reads the prefix, and pings next from the fork's read", async () => {
		const manager = piSdk.SessionManager.inMemory();
		const log = sessionLog(manager);
		const server = await new FakeAnthropic().start();
		const s = await waitingSession({
			shared: { manager, server, signalFile: join(mkdtempSync(join(tmpdir(), "context-clock-")), "signal.json") },
			config: { keepRecentTokens: 1_000, maskedTokens: 500, pinnedUserTokens: 500, historian },
		});
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		server.responder = async (request) => {
			if (isFork(request)) {
				await held;
				return [{ type: "text", text: "## Topic\n- A stretch" }];
			}
			if (request.body.max_tokens === 1) return [{ type: "text", text: "x" }];
			// The answer ends late in the cache's lifetime: a ping is due as soon as the session is idle.
			s.clock(START + 250_000);
			return [{ type: "text", text: "done" }];
		};
		try {
			await s.runtime.session.bindExtensions({ uiContext: ui as never });
			for (let index = 0; index < 6; index++) log.turn(`seed ${index}`, 8_000);
			s.expectPrompt(START + 900_000);
			await s.runtime.session.prompt("Continue the work.");
			await s.waitFor(() => server.requests.some(isFork));
			assert.ok(server.requests.some(isFork), "the summary was not forked");
			// Many keep-warm ticks while the fork is out.
			await s.settle(300);
			assert.equal(s.pings().length, 0, "a ping read the prefix while the fork was reading it");
			release();
			await s.waitFor(() => s.ledger().some((line) => line.class === "historian-route"));
			const route = s.ledger().find((line) => line.class === "historian-route");
			assert.equal(route?.historianVia, "fork");
			assert.ok(Number(route?.cacheRead) > 0, "the fork did not read the cache");
			await s.settle(300);
			assert.equal(s.pings().length, 0, "the ping counted the cache from the main request, not from the fork's read");
			// Due again only near the end of the lifetime the fork's read started.
			s.clock(START + 250_000 + TTL_MS - 30_000);
			await s.waitFor(() => s.pings().length === 1);
			assert.equal(s.pings().length, 1);
			assert.ok((s.pings()[0]?.cacheRead ?? 0) > 0, "the ping after the fork missed the cache");
		} finally {
			release();
			await s.close();
		}
	}, 30_000);

	it("forks the next summary from a prefix a ping kept warm past the main request's lifetime", async () => {
		const manager = piSdk.SessionManager.inMemory();
		const log = sessionLog(manager);
		for (let index = 0; index < 6; index++) log.turn(`seed ${index}`, 8_000);
		const server = await new FakeAnthropic().start();
		const s = await waitingSession({
			shared: { manager, server, signalFile: join(mkdtempSync(join(tmpdir(), "context-clock-")), "signal.json") },
			config: { keepRecentTokens: 1_000, maskedTokens: 500, pinnedUserTokens: 500, historian },
		});
		let release = () => {};
		let released = false;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		server.responder = async (request) => {
			// The historian's first summary, asked at session start before any main request, waits on the test.
			if (request.body.model === "claude-fable-5") {
				if (!released) await held;
				return [{ type: "text", text: citingAnswer(lastText(request)) }];
			}
			if (isFork(request)) return [{ type: "text", text: citingAnswer(lastText(request)) }];
			if (request.body.max_tokens === 1) return [{ type: "text", text: "x" }];
			s.clock(START + 250_000);
			return [{ type: "text", text: "done" }];
		};
		try {
			await s.runtime.session.bindExtensions({ uiContext: ui as never });
			s.expectPrompt(START + 900_000);
			await s.runtime.session.prompt("Continue the work.");
			await s.waitFor(() => s.pings().length === 1);
			assert.deepEqual(s.warmRecords().find((record) => record.type === "end")?.outcome, "warmed");
			// Past the main request's lifetime, inside the one the ping's read started.
			s.clock(START + TTL_MS + 20_000);
			released = true;
			release();
			const routes = () => s.ledger().filter((line) => line.class === "historian-route" && line.status === "answered");
			await s.waitFor(() => routes().length >= 2);
			const next = routes()[1];
			assert.equal(next?.rejection, undefined, "the summary after the ping was not forked");
			assert.equal(next?.historianVia, "fork");
		} finally {
			released = true;
			release();
			await s.close();
		}
	}, 30_000);
	it("holds the fork while a ping already reads the prefix, then forks from the ping's read", async () => {
		const manager = piSdk.SessionManager.inMemory();
		const log = sessionLog(manager);
		for (let index = 0; index < 6; index++) log.turn(`seed ${index}`, 8_000);
		const server = await new FakeAnthropic().start();
		const s = await waitingSession({
			shared: { manager, server, signalFile: join(mkdtempSync(join(tmpdir(), "context-clock-")), "signal.json") },
			config: { keepRecentTokens: 1_000, maskedTokens: 500, pinnedUserTokens: 500, historian },
		});
		const initial = gate();
		const ping = gate();
		let pingAnswered = false;
		/** Whether the ping had answered when the fork arrived. */
		let forkAfterPing: boolean | undefined;
		server.responder = async (request) => {
			// The historian's first summary, asked at session start before any main request, waits on the test.
			if (request.body.model === "claude-fable-5") {
				await initial.shut;
				return [{ type: "text", text: citingAnswer(lastText(request)) }];
			}
			if (isFork(request)) {
				forkAfterPing = pingAnswered;
				return [{ type: "text", text: citingAnswer(lastText(request)) }];
			}
			if (request.body.max_tokens === 1) {
				await ping.shut;
				pingAnswered = true;
				return [{ type: "text", text: "x" }];
			}
			s.clock(START + 250_000);
			return [{ type: "text", text: "done" }];
		};
		try {
			await s.runtime.session.bindExtensions({ uiContext: ui as never });
			s.expectPrompt(START + 900_000);
			await s.runtime.session.prompt("Continue the work.");
			await s.waitFor(() => s.pings().length === 1);
			assert.equal(s.pings().length, 1, "no ping went out");
			// The first summary ends while the ping's answer is outstanding: the next piece would fork.
			initial.open();
			await s.settle(300);
			assert.equal(server.requests.filter(isFork).length, 0, "the fork read the prefix while the ping was reading it");
			ping.open();
			await s.waitFor(() => s.ledger().some((line) => line.class === "historian-route" && line.historianVia === "fork"));
			assert.equal(forkAfterPing, true, "the fork did not wait for the ping's answer");
			assert.ok((server.requests.find(isFork)?.cacheRead ?? 0) > 0, "the fork did not read what the ping refreshed");
			assert.equal(s.pings().length, 1);
			assert.equal(s.warmRecords().find((record) => record.type === "end")?.outcome, "warmed");
		} finally {
			initial.open();
			ping.open();
			await s.close();
		}
	}, 30_000);
});
