import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ATTEMPT_LIMIT } from "../src/core/attempts.ts";
import { SUMMARY_KIND } from "../src/core/kinds.ts";
import { citingAnswer } from "./support/historian.ts";
import { attemptEntries, attemptWords, deferred, type FauxResponder, lifecycleOptions, openRuntime, seededManager, tempDir } from "./support/lifecycle.ts";
import { piAi, piSdk } from "./support/pi.ts";

/*
 * Every model request the historian sends is a request of its own: a receipt is stored before it goes out, naming the
 * model, and the limit of three counts these receipts. Pi's own model registry sends the requests, through faux models
 * that record what pi-ai received.
 */

const VERSION = piSdk.VERSION;
const PRIMARY = "hist-primary";
const FALLBACK = "hist-fallback";

interface Sent {
	readonly model: string;
	readonly options: Record<string, unknown> | undefined;
}

/** The text of the request's user message: the historian's prompt. */
const promptOf = (context: Parameters<FauxResponder>[0]): string => {
	const content = context.messages.findLast((message: { role: string }) => message.role === "user")?.content;
	return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("") : String(content ?? "");
};

describe(`each historian request is a receipt of its own (pi ${VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	async function session(answer: (model: string, prompt: string) => unknown) {
		const dir = tempDir();
		const manager = seededManager(dir, 6);
		const sent: Sent[] = [];
		/** The receipts on disk when each request went out: how many, and the model the latest names. */
		const onDisk: { readonly starts: number; readonly model: string | undefined }[] = [];
		const notices: string[] = [];
		const clock = { now: Date.UTC(2026, 9, 9, 13, 0, 0) };
		const stored = deferred();
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
		const base = lifecycleOptions(join(dir, "ledger.jsonl"), undefined, 100);
		const respond: FauxResponder = (context, options, model) => {
			if (!model.id.startsWith("hist-")) return undefined;
			sent.push({ model: model.id, options });
			const file = manager.getSessionFile();
			assert.ok(file);
			const starts = attemptEntries(piSdk.SessionManager.open(file)).filter((record) => record.type === "start");
			onDisk.push({ starts: starts.length, model: (starts.at(-1) as { model?: string } | undefined)?.model });
			return answer(model.id, promptOf(context));
		};
		const opened = await openRuntime({
			dir,
			manager,
			trace: [],
			models: [PRIMARY, FALLBACK],
			respond,
			options: {
				...base,
				now: () => clock.now,
				config: { ...base.config, historian: { ...base.config?.historian, model: "faux/" + PRIMARY, fallbackModel: "faux/" + FALLBACK } },
			},
			onAppend: (kind) => kind === SUMMARY_KIND && stored.resolve(),
		});
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		const { session } = opened.runtime;
		await session.bindExtensions({ uiContext: ui });
		const turn = async (text: string, advance: number) => {
			clock.now += advance;
			await session.prompt(text);
			for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
		};
		return { manager, sent, onDisk, notices, stored, turn, runtime: opened.runtime };
	}

	/** Waits a bounded number of event-loop turns for the summary, so a failure reports what was stored instead of a timeout. */
	const settled = async (stored: { settled: () => boolean }) => {
		for (let i = 0; i < 500 && !stored.settled(); i++) await new Promise((resolve) => setImmediate(resolve));
	};

	const failing = () => piAi.fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" });

	it("a failed primary and its fallback are two receipts, each naming its model", async () => {
		const s = await session((model, prompt) => (model === PRIMARY ? failing() : piAi.fauxAssistantMessage(citingAnswer(prompt))));
		await s.turn("one", 0);
		await settled(s.stored);
		assert.deepEqual(s.sent.map((one) => one.model), [PRIMARY, FALLBACK]);
		assert.deepEqual(
			s.onDisk,
			[
				{ starts: 1, model: "faux/" + PRIMARY },
				{ starts: 2, model: "faux/" + FALLBACK },
			],
			"one receipt per request, in the session file before the request went out",
		);
		assert.deepEqual(attemptWords(s.manager), ["start", "end:failed", "start", "end:stored"]);
		await s.runtime.dispose();
	});

	it("asks pi-ai for a transport that cannot resend: SSE and no retries", async () => {
		const s = await session((model, prompt) => (model === PRIMARY ? failing() : piAi.fauxAssistantMessage(citingAnswer(prompt))));
		await s.turn("one", 0);
		await settled(s.stored);
		assert.equal(s.sent.length, 2);
		for (const one of s.sent) {
			assert.equal(one.options?.transport, "sse", one.model);
			assert.equal(one.options?.maxRetries, 0, one.model);
		}
		await s.runtime.dispose();
	});

	it("the limit of three counts requests: a failing primary and fallback pause after three, not six", async () => {
		const s = await session(() => failing());
		await s.turn("one", 0);
		assert.deepEqual(s.sent.map((one) => one.model), [PRIMARY, FALLBACK], "the first try is two requests");
		for (const text of ["two", "three", "four", "five"]) await s.turn(text, 3_600_000);
		assert.equal(s.sent.length, ATTEMPT_LIMIT, "three requests and no fourth");
		assert.deepEqual(s.sent.map((one) => one.model), [PRIMARY, FALLBACK, PRIMARY], "the fallback is not asked past the limit");
		assert.equal(attemptEntries(s.manager).filter((record) => record.type === "start").length, ATTEMPT_LIMIT);
		const pauses = s.notices.filter((text) => text.includes("retry-historian"));
		assert.equal(pauses.length, 1, "the owner is told once");
		assert.match(pauses[0] ?? "", /paused after 3 failed attempts/);
		await s.runtime.dispose();
	});
});
