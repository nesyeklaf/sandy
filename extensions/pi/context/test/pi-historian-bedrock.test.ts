import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { attemptEntries, lifecycleOptions, openRuntime, seededManager, tempDir } from "./support/lifecycle.ts";
import { piSdk } from "./support/pi.ts";

/*
 * A session model whose client resends unseen is not asked for summaries. Without a historian.model the session has
 * no historian, and the owner is told so once, with the reason and what to set, instead of a generic failure.
 */

const VERSION = piSdk.VERSION;

const bedrock = {
	provider: "local-bedrock",
	id: "bedrock-test",
	name: "bedrock-test",
	api: "bedrock-converse-stream",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

const ticks = async (count = 200) => {
	for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe(`a session on a model the historian refuses (pi ${VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	async function session(hasUi: boolean) {
		const dir = tempDir();
		const manager = seededManager(dir, 6);
		const notices: string[] = [];
		const stderr: string[] = [];
		const original = console.error;
		console.error = (...parts: unknown[]) => stderr.push(parts.join(" "));
		cleanup.push(() => {
			console.error = original;
		});
		const register = (pi: Parameters<NonNullable<Parameters<typeof openRuntime>[0]["extensions"]>[number]>[0]) =>
			pi.registerProvider(bedrock.provider, { baseUrl: bedrock.baseUrl, apiKey: "synthetic", api: bedrock.api, models: [bedrock] } as never);
		const opened = await openRuntime({
			dir,
			manager,
			trace: [],
			options: lifecycleOptions(join(dir, "ledger.jsonl"), undefined, 100),
			extensions: [register],
		});
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		const { session } = opened.runtime;
		await session.setModel(bedrock as never);
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
		await session.bindExtensions(hasUi ? { uiContext: ui } : {});
		await ticks();
		return { manager, notices, stderr, session, runtime: opened.runtime };
	}

	const unavailable =
		/Historian unavailable: the session model local-bedrock\/bedrock-test uses bedrock-converse-stream \(Amazon Bedrock\), whose client retries a request unseen;.*Set historian\.model/;

	it("tells the owner once why there are no summaries and sends none", async () => {
		const s = await session(true);
		assert.equal(s.session.model?.api, "bedrock-converse-stream");
		await s.session.prompt("/context");
		await ticks();
		await s.session.prompt("/context");
		await ticks();
		assert.equal(attemptEntries(s.manager).length, 0, "no request was sent");
		const told = s.notices.filter((text) => /^Historian unavailable/i.test(text));
		assert.equal(told.length, 1, s.notices.join("\n---\n"));
		assert.match(told[0] ?? "", unavailable);
		const status = s.notices.filter((text) => text.startsWith("Prompt:"));
		assert.equal(status.length, 2, "/context ran twice");
		for (const text of status) {
			assert.match(text, unavailable);
			assert.doesNotMatch(text, /no model may be asked/);
		}
		await s.runtime.dispose();
	});

	it("without a UI says it on stderr, once", async () => {
		const s = await session(false);
		await s.session.prompt("/context");
		await ticks();
		assert.equal(attemptEntries(s.manager).length, 0);
		assert.equal(s.stderr.filter((text) => unavailable.test(text)).length, 1, s.stderr.join("\n---\n"));
		await s.runtime.dispose();
	});
});
