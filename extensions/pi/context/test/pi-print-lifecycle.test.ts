import assert from "node:assert/strict";
import { citingAnswer } from "./support/historian.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { SUMMARY_KIND } from "../src/core/kinds.ts";
import type { Summarizer } from "../src/pi/extension.ts";
import { SessionTape, type SessionProjector } from "../src/pi/session.ts";
import {
	deferred,
	FakeTransport,
	interactiveUi,
	attemptEntries,
	attemptWords,
	lifecycleOptions,
	type Manager,
	openRuntime,
	type Runtime,
	seededManager,
	summaryEntries,
	tempDir,
} from "./support/lifecycle.ts";
import { piSdk } from "./support/pi.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

/*
 * The historian's lifecycle through pi's real runtime and print mode. The model answers at once; the historian's
 * transport answers only when the test says so, so every trace is ordered by events, never by elapsed time.
 */

const VERSION = piSdk.VERSION;
/** Enough text to move the seeded history past the newest stretch a cut keeps, so older history can be summarized. */
const LONG_PROMPT = `Question: ${"word ".repeat(1_200)}`;
const tape = (manager: Manager) => SessionTape.read(manager.getBranch(), piSdk.buildSessionProjection as SessionProjector, DEFAULT_CONFIG);

describe(`the historian across short runs (pi ${VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	async function setup(turns = 6, hold = true) {
		const dir = tempDir();
		const trace: string[] = [];
		const ledgerFile = join(dir, "ledger.jsonl");
		const manager = seededManager(dir, turns);
		const transport = new FakeTransport(trace);
		const stored = deferred();
		const opened = await openRuntime({
			dir,
			manager,
			trace,
			options: lifecycleOptions(ledgerFile, transport.summarize),
			// The run waits until the historian's request is out, as a run that outlasts the historian's start would.
			beforeAgent: hold ? () => transport.sent.promise : async () => undefined,
			onAppend: (kind) => kind === SUMMARY_KIND && stored.resolve(),
		});
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		return { dir, trace, ledgerFile, manager, transport, stored, ...opened };
	}

	it("print mode ends the run while the historian call is out: nothing is stored, the aborted attempt is recorded", async () => {
		const { trace, ledgerFile, manager, runtime, transport } = await setup();
		await piSdk.runPrintMode(runtime, { mode: "text", initialMessage: "hello" });
		trace.push("print-returned");

		assert.deepEqual(trace, [
			"transport:sent",
			"turn_end",
			"agent_end",
			"session_shutdown:quit",
			"transport:signal-aborted",
			"print-returned",
		]);
		assert.equal(transport.requests.length, 1);
		const [start, end, ...rest] = attemptEntries(manager);
		assert.equal(rest.length, 0, "one attempt: its start and its end");
		assert.deepEqual(
			end?.type === "end" && { outcome: end.outcome, reason: end.reason, step: end.step },
			{ outcome: "aborted", reason: "quit", step: "summarize" },
		);
		assert.ok(
			manager.getEntries().some((entry) => start?.type === "start" && entry.id === start.throughId),
			"the record names the entry the stretch was to be summarized through",
		);
		assert.equal(summaryEntries(manager).length, 0, "no summary was stored");
	});

	it("an aborted attempt leaves the stretch searchable and unsummarized, and the next session takes it up again", async () => {
		const first = await setup();
		await piSdk.runPrintMode(first.runtime, { mode: "text", initialMessage: "hello" });
		const view = tape(first.manager);
		assert.equal(view.history().summary, undefined, "coverage did not advance");
		const gap = view.archive().entries.filter((entry) => entry.status === "visible");
		assert.ok(gap.length >= 12, "the unsummarized stretch is still in the archive the tools search");
		const sentPrompt = first.transport.requests[0]?.prompt;

		// The next start finds the same stretch and, with the answer ready, stores it.
		const resumedTrace: string[] = [];
		const transport = new FakeTransport(resumedTrace);
		const stored = deferred();
		const resumedManager = piSdk.SessionManager.open(first.manager.getSessionFile() as string, join(first.dir, "sessions"));
		const second = await openRuntime({
			dir: first.dir,
			manager: resumedManager,
			trace: resumedTrace,
			options: lifecycleOptions(first.ledgerFile, transport.summarize),
			onAgentEnd: async () => {
				transport.release();
				await stored.promise;
			},
			onAppend: (kind) => kind === SUMMARY_KIND && stored.resolve(),
		});
		cleanup.push(() => second.faux.unregister());
		await piSdk.runPrintMode(second.runtime, { mode: "text", initialMessage: "again" });

		assert.equal(transport.requests[0]?.prompt, sentPrompt, "the same stretch is summarized");
		assert.equal(summaryEntries(resumedManager).length, 1);
		assert.ok(tape(resumedManager).history().summary, "coverage advanced once the answer was stored");
	});

	it("an answer that arrives within the run is stored before the process ends", async () => {
		const { trace, ledgerFile, manager, runtime, transport, stored } = await setup();
		const run = piSdk.runPrintMode(runtime, { mode: "text", initialMessage: "hello" });
		// The answer comes in while the run is still going: the agent's last turn waits for the stored summary.
		await transport.sent.promise;
		transport.release();
		await stored.promise;
		await run;

		assert.deepEqual(trace.filter((line) => !line.startsWith("turn_end")), [
			"transport:sent",
			"transport:answered",
			`append:${SUMMARY_KIND}`,
			"agent_end",
			"session_shutdown:quit",
		]);
		assert.equal(summaryEntries(manager).length, 1);
		assert.deepEqual(attemptWords(manager), ["start", "end:stored"], "a finished attempt is one start and one end");
	});

	it("a run that ends with this turn starts no historian call that the end of the process would kill", async () => {
		const dir = tempDir();
		const trace: string[] = [];
		const ledgerFile = join(dir, "ledger.jsonl");
		const manager = seededManager(dir, 3);
		const transport = new FakeTransport(trace);
		const { runtime, faux } = await openRuntime({
			dir,
			manager,
			trace,
			options: lifecycleOptions(ledgerFile, transport.summarize, 400),
		});
		cleanup.push(() => {
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		// The prompt carries the history over the historian's minimum, so the last turn is the first chance to start.
		await piSdk.runPrintMode(runtime, { mode: "text", initialMessage: LONG_PROMPT });

		assert.deepEqual(trace, ["turn_end", "agent_end", "session_shutdown:quit"]);
		assert.deepEqual(attemptWords(manager), [], "nothing was sent, so nothing was lost");
		assert.equal(summaryEntries(manager).length, 0);
	});
});

describe(`the historian in a session that stays open (pi ${VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	async function interactive(turns: number, chunkMinTokens: number) {
		const dir = tempDir();
		const trace: string[] = [];
		const ledgerFile = join(dir, "ledger.jsonl");
		const manager = seededManager(dir, turns);
		const transport = new FakeTransport(trace);
		const stored = deferred();
		const opened = await openRuntime({
			dir,
			manager,
			trace,
			options: lifecycleOptions(ledgerFile, transport.summarize, chunkMinTokens),
			onAppend: (kind) => kind === SUMMARY_KIND && stored.resolve(),
		});
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		await opened.runtime.session.bindExtensions({ uiContext: interactiveUi });
		return { dir, trace, ledgerFile, manager, transport, stored, ...opened };
	}

	it("a failing summary pauses after three attempts, tells the owner once, and /context retry-historian tries again", async () => {
		const dir = tempDir();
		const trace: string[] = [];
		const manager = seededManager(dir, 6);
		const notices: string[] = [];
		const requests: string[] = [];
		const clock = { now: Date.UTC(2026, 9, 9, 13, 0, 0) };
		// Pi copies the UI object by spread, so the stand-in lists its methods instead of answering any name.
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
		const options = lifecycleOptions(join(dir, "ledger.jsonl"), async (request) => {
			requests.push(request.prompt);
			return { text: "no sections at all" };
		}, 100);
		const opened = await openRuntime({ dir, manager, trace, options: { ...options, now: () => clock.now } });
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		const { session } = opened.runtime;
		await session.bindExtensions({ uiContext: ui });
		const turn = async (text: string, advance: number) => {
			clock.now += advance;
			await session.prompt(text);
			for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		};
		await turn("one", 0);
		await turn("two", 30_000);
		await turn("three", 120_000);
		await turn("four", 3_600_000);
		await turn("five", 3_600_000);
		assert.equal(requests.length, 3, "three attempts and no fourth");
		assert.deepEqual(attemptWords(manager), ["start", "end:rejected", "start", "end:rejected", "start", "end:rejected"]);
		const pauses = notices.filter((text) => text.includes("retry-historian"));
		assert.equal(pauses.length, 1, "the owner is told once");
		assert.match(pauses[0] ?? "", /paused after 3 failed attempts/);

		await session.prompt("/context retry-historian");
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(requests.length, 4, "the command starts a request at once");
		await opened.runtime.dispose();
	});

	it("a turn that ends a run starts the historian, and its answer is stored after the run", async () => {
		const { trace, ledgerFile, manager, runtime, transport, stored } = await interactive(3, 400);
		await runtime.session.prompt(LONG_PROMPT);
		assert.deepEqual(trace, ["turn_end", "transport:sent", "agent_end"]);
		transport.release();
		await stored.promise;
		await runtime.dispose();

		assert.deepEqual(trace.slice(3), ["transport:answered", `append:${SUMMARY_KIND}`, "session_shutdown:quit"]);
		assert.equal(summaryEntries(manager).length, 1);
		assert.deepEqual(attemptWords(manager), ["start", "end:stored"]);
	});

	it("replacing the session cancels the call and nothing is written onto the new session", async () => {
		const { trace, ledgerFile, manager, runtime, transport } = await interactive(6, 100);
		await transport.sent.promise;
		const old = runtime.session.sessionManager;
		await runtime.newSession();
		await runtime.session.bindExtensions({ uiContext: interactiveUi });
		transport.release();
		await runtime.dispose();

		assert.deepEqual(trace.filter((line) => line !== "turn_end"), [
			"transport:sent",
			"session_shutdown:new",
			"transport:signal-aborted",
			"session_shutdown:quit",
		]);
		assert.equal(summaryEntries(manager).length, 0, "the old branch got no summary");
		assert.equal(summaryEntries(runtime.session.sessionManager as Manager).length, 0, "the new session got no summary");
		assert.equal(old, manager);
		assert.deepEqual(attemptWords(manager), ["start", "end:aborted"]);
		assert.deepEqual(attemptEntries(manager).map((record) => record.type === "end" && record.reason), [false, "new"]);
	});

	it("after an edit of covered history, summarizes the stretch once from the edited text and moves on", async () => {
		const dir = tempDir();
		const trace: string[] = [];
		const manager = seededManager(dir, 6);
		const [question0, , , answer1] = manager.getBranch();
		assert.ok(question0 && answer1);
		const old = { version: 1, coveredThroughId: answer1.id, sections: { goal: ["old goal"] } };
		manager.appendCustomEntry(SUMMARY_KIND, old);
		manager.appendContextEdit(question0.id, { content: [{ type: "text", text: "WITHDRAWN question" }] });
		// Answers at once, so the whole historian loop runs on microtasks; a loop that never stops is cut off at four.
		const prompts: string[] = [];
		const summarize: Summarizer = async (request) => {
			prompts.push(request.prompt);
			if (prompts.length >= 4) throw new Error("the historian keeps summarizing the same stretch");
			return { text: citingAnswer(request.prompt) };
		};
		const stored = deferred();
		const opened = await openRuntime({
			dir,
			manager,
			trace,
			options: lifecycleOptions(join(dir, "ledger.jsonl"), summarize, 100),
			onAppend: (kind) => kind === SUMMARY_KIND && stored.resolve(),
		});
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		await opened.runtime.session.bindExtensions({ uiContext: interactiveUi });
		await stored.promise;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(prompts.length, 1, "one historian call, not a loop over the same stretch");
		assert.match(prompts[0] ?? "", /WITHDRAWN question/);
		assert.ok(!prompts[0]?.includes("Question 0:"), "the historian reads the edited text");
		const written = summaryEntries(manager);
		assert.equal(written.length, 2, "the old summary and one new one");
		const history = tape(manager).history();
		assert.equal(history.summaryEligibility?.eligible, true, "the new summary is trusted");
		assert.equal(history.summary?.coveredThroughId, (written[1] as { data?: { coveredThroughId?: string } }).data?.coveredThroughId);
		await opened.runtime.dispose();
	});

	it("moving to another branch cancels the call for the old branch and starts one for the new", async () => {
		const { trace, ledgerFile, manager, runtime, transport, stored } = await interactive(6, 100);
		await transport.sent.promise;
		const branch = manager.getBranch();
		const target = branch[9]?.id as string;
		await runtime.session.navigateTree(target, { summarize: false });
		assert.deepEqual(trace, ["transport:sent", "transport:signal-aborted", "transport:sent"]);
		transport.release();
		await stored.promise;

		const [summary] = summaryEntries(manager);
		const covered = (summary as { data?: { coveredThroughId?: string } } | undefined)?.data?.coveredThroughId;
		assert.ok(covered, "a summary was stored");
		assert.ok(
			manager.getBranch().some((entry) => entry.id === covered),
			"it covers a stretch of the branch it was written on",
		);
		assert.equal(transport.requests.length, 2);
		assert.ok(!transport.requests[1]?.prompt.includes(branch[10]?.id as string), "the new call leaves out the abandoned tail");
		// The leaf had moved when the call was cancelled, so the old attempt stays open on the abandoned tail; the new
		// branch has its own attempt, which was stored.
		assert.deepEqual(attemptWords(manager), ["start", "start", "end:stored"]);
		await runtime.dispose();
	});
});
