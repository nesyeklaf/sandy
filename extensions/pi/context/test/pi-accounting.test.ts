import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "vitest";
import { accountingEvents, formatCostReport, reduceAccounting } from "../src/core/accounting.ts";
import { ATTEMPT_KIND, RETRIEVAL_KIND, WARMING_KIND } from "../src/core/kinds.ts";
import { reduceRetrieval, retrievalEvents } from "../src/core/retrieval.ts";
import { attempt, piUsage, type RawEntry, totals } from "./support/accounting.ts";
import { lifecycleOptions, openRuntime, seededManager, tempDir } from "./support/lifecycle.ts";
import { piAi, piSdk } from "./support/pi.ts";

type ExtensionAPI = Parameters<NonNullable<Parameters<typeof openRuntime>[0]["extensions"]>[number]>[0];

// Pi copies the UI object by spread, so the stand-in lists its methods instead of answering any name.
const uiFor = (notices: string[]) => {
	const quiet = () => undefined;
	return { notify: (text: string) => notices.push(text), setStatus: quiet, setWidget: quiet, setFooter: quiet, setHeader: quiet, setTitle: quiet, setWorkingMessage: quiet, setEditorText: quiet } as never;
};

/** A request pi's own runtime would send, as the provider payload `before_provider_request` sees; a warm sends one output token. */
const payload = (maxTokens: number) => ({ model: "faux-main", max_tokens: maxTokens, system: "s", messages: [{ role: "user", content: "hello" }] });

/*
 * The accounting through pi's real runtime and a session file on disk: what the report adds up from the log is what
 * pi counts itself, and the engine's own records survive a restart.
 */
describe(`the cost and retrieval records in a real session (pi ${piSdk.VERSION})`, () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
	});

	async function setup(extensions: readonly ((pi: ExtensionAPI) => void)[] = [], notices?: string[]) {
		const dir = tempDir();
		const manager = seededManager(dir, 3);
		const opened = await openRuntime({ dir, manager, trace: [], extensions, options: lifecycleOptions(`${dir}/ledger.jsonl`, undefined) });
		cleanup.push(() => {
			opened.faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		});
		// Binding the extensions starts the session for them, which is when the context extension turns on.
		await opened.runtime.session.bindExtensions(notices ? { uiContext: uiFor(notices) } : {});
		return { dir, manager, ...opened };
	}
	const reopen = (manager: Awaited<ReturnType<typeof setup>>["manager"], dir: string) =>
		piSdk.SessionManager.open(manager.getSessionFile() as string, `${dir}/sessions`);

	it("the known costs of a session file add up to what pi's getSessionStats counts", async () => {
		const { dir, manager, runtime } = await setup();
		const assistant = (cost: number) =>
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "x" }], api: "faux", provider: "faux", model: "faux-1", usage: piUsage(cost, 100, 20, 300, 40), stopReason: "stop", timestamp: 1 } as never);
		assistant(2);
		manager.appendUsage("cache_warm", "faux", "faux-main", piUsage(5, 1, 1, 1, 1) as never);
		manager.appendCompaction("Summary by pi", manager.getEntries()[0]?.id ?? null, 1_000, undefined, false, piUsage(7, 3, 3, 3, 3) as never);
		manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "workflow", content: [{ type: "text", text: "r" }], usage: piUsage(11, 2, 2, 2, 2), isError: false, timestamp: 2 } as never);
		manager.branchWithSummary(manager.getEntries()[0]?.id ?? null, "branch", undefined, false, piUsage(13, 4, 4, 4, 4) as never);
		await runtime.session.prompt("hello");

		const stats = runtime.session.getSessionStats();
		const report = reduceAccounting(accountingEvents(reopen(manager, dir).getEntries()));
		assert.equal(report.piCounted.cost, stats.cost);
		assert.deepEqual(
			{ input: report.piCounted.input, output: report.piCounted.output, cacheRead: report.piCounted.cacheRead, cacheWrite: report.piCounted.cacheWrite },
			{ input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite },
		);
		assert.ok(stats.cost >= 38, "the manual costs are in the session");
		assert.equal(report.complete, true);
	});

	it("records pi's cache-warming decision before any warm request leaves, without a veto", async () => {
		const { manager, runtime } = await setup();
		const runner = runtime.session.extensionRunner;
		const base = { warmCost: 1, missCost: 2, continuationProbability: 0.5 };
		assert.equal(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", ...base, action: "warm" }), "warm");
		assert.equal(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", ...base, action: "stop" }), "stop");
		const records = manager.getEntries().flatMap((entry) => (entry.type === "custom" && entry.customType === WARMING_KIND ? [entry.data] : []));
		assert.deepEqual(records, [
			{ piAction: "warm", action: "warm", requestsSeen: false },
			{ piAction: "stop", action: "stop", requestsSeen: false },
		]);
	});

	describe("a stop that another extension's handler overrides", () => {
		const base = { type: "cache_warming_decision" as const, warmCost: 1, missCost: 2, continuationProbability: 0.5 };
		const overrides = (pi: ExtensionAPI) => pi.on("cache_warming_decision", () => ({ action: "warm" as const }));

		it("counts the warm the override sent, and its failure as unknown, never as a skipped request", async () => {
			const { manager, runtime } = await setup([overrides]);
			const runner = runtime.session.extensionRunner;
			await runner.emitBeforeProviderRequest(payload(4096));
			assert.equal(await runner.emitCacheWarmingDecision({ ...base, action: "stop" }), "warm", "pi's runner lets the other handler win");
			// The warm leaves through the same payload hook as every request; it fails, so pi persists no usage.
			await runner.emitBeforeProviderRequest(payload(1));
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 } as never);
			const report = reduceAccounting(accountingEvents(manager.getEntries()));
			assert.equal(report.skipped, 0);
			assert.equal(report.bySource["native-warm"].requests, 1);
			assert.equal(report.bySource["native-warm"].unknown, 1);
			assert.equal(report.complete, false);
		});

		it("counts the override's warm by the usage pi persisted for it", async () => {
			const { manager, runtime } = await setup([overrides]);
			const runner = runtime.session.extensionRunner;
			await runner.emitBeforeProviderRequest(payload(4096));
			await runner.emitCacheWarmingDecision({ ...base, action: "stop" });
			await runner.emitBeforeProviderRequest(payload(1));
			manager.appendUsage("cache_warm", "faux", "faux-main", piUsage(5, 1, 1, 1, 1) as never, "extension override");
			const report = reduceAccounting(accountingEvents(manager.getEntries()));
			assert.equal(report.skipped, 0);
			assert.deepEqual({ requests: report.bySource["native-warm"].requests, known: report.bySource["native-warm"].known, cost: report.bySource["native-warm"].cost }, { requests: 1, known: 1, cost: 5 });
		});

		it("still counts a stop no handler overrode as a skip", async () => {
			const { manager, runtime } = await setup();
			const runner = runtime.session.extensionRunner;
			await runner.emitBeforeProviderRequest(payload(4096));
			assert.equal(await runner.emitCacheWarmingDecision({ ...base, action: "stop" }), "stop");
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 } as never);
			const report = reduceAccounting(accountingEvents(manager.getEntries()));
			assert.equal(report.skipped, 1);
			assert.equal(report.complete, true);
		});
	});

	it("takes a request pi-ai's real adapter failed after it left, without usage, as unknown", async () => {
		const ai = piAi as unknown as {
			getModels(provider: string): unknown[];
			streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<Record<string, unknown>> };
		};
		let sends = 0;
		const response = await ai
			.streamSimple(ai.getModels("anthropic")[0], { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
				apiKey: "not-a-key",
				maxRetries: 0,
				fetch: async () => {
					sends++;
					throw new Error("connection reset after the server took the request");
				},
			})
			.result();
		assert.equal(sends, 1, "the request left");
		assert.equal(response.stopReason, "error");
		const report = reduceAccounting(accountingEvents([{ type: "message", id: "failure", message: response } as RawEntry]));
		assert.equal(report.bySource.main.unknown, 1);
		assert.equal(report.complete, false);
		assert.equal(report.total, undefined);
	});

	it("/context reports what another process on the same session file paid, as the file on disk does", async () => {
		const notices: string[] = [];
		const { dir, manager, runtime } = await setup([], notices);
		await runtime.session.prompt("hello");
		// A second pi process on the same file: its historian paid a request this process never loaded.
		const other = reopen(manager, dir);
		for (const entry of attempt("other-process", "failed", totals(3))) other.appendCustomEntry(ATTEMPT_KIND, (entry as unknown as { data: unknown }).data);
		await runtime.session.prompt("/context");
		const disk = formatCostReport(reduceAccounting(accountingEvents(reopen(manager, dir).getEntries())));
		const shown = notices.at(-1) ?? "";
		for (const line of disk) assert.ok(shown.includes(line), `/context shows "${line}"\n${shown}`);
		assert.match(shown, /historian \$3/);
	});

	it("keeps a read made inside another tool in the session, and finds it again after a restart", async () => {
		const { dir, manager, runtime } = await setup();
		const runner = runtime.session.extensionRunner;
		const result = (toolCallId: string, parentToolCallId: string | undefined, toolName: string, input: Record<string, unknown>, details?: unknown) =>
			runner.emitToolResult({ type: "tool_result", toolCallId, ...(parentToolCallId ? { parentToolCallId } : {}), toolName, input, content: [{ type: "text", text: "SECRET CONTENT" }], details, isError: false } as never);
		await result("c1/1", "c1", "history_search", { query: "q" }, { hits: ["e1", "e2"] });
		await result("c1/2", "c1", "history_read", { id: "e1" });
		await result("c1/3", "c1", "read", { path: "a.ts" });
		await result("c2", undefined, "history_read", { id: "e1" });

		const records = manager.getEntries().flatMap((entry) => (entry.type === "custom" && entry.customType === RETRIEVAL_KIND ? [entry.data] : []));
		assert.equal(records.length, 3, "the three calls inside another tool; the top-level call is in the transcript already");
		assert.equal(JSON.stringify(records).includes("SECRET"), false, "a record holds no content");

		const restarted = reopen(manager, dir);
		const report = reduceRetrieval(retrievalEvents(restarted.getEntries() as never));
		assert.equal(report.searches.total, 1);
		assert.equal(report.entryReadsNested, 1);
		assert.equal(report.fileReads, 1);
	});

	it("records a nested read under the entry the archive resolved, and a failed one as failed", async () => {
		const { dir, manager, runtime } = await setup();
		const runner = runtime.session.extensionRunner;
		const result = (toolCallId: string, toolName: string, input: Record<string, unknown>, details: unknown, isError: boolean) =>
			runner.emitToolResult({ type: "tool_result", toolCallId, parentToolCallId: "c1", toolName, input, content: [{ type: "text", text: "x" }], details, isError } as never);
		// The model typed a prefix with a hash; the archive resolved it to the full id and said so in the result.
		await result("c1/1", "history_read", { id: "#e1" }, { id: "e1-full-id" }, false);
		await result("c1/2", "history_read", { id: "missing" }, undefined, true);
		await result("c1/3", "read", { path: "gone.ts" }, undefined, true);

		const records = manager.getEntries().flatMap((entry) => (entry.type === "custom" && entry.customType === RETRIEVAL_KIND ? [entry.data as Record<string, unknown>] : []));
		assert.deepEqual(records.map((record) => [record.ids ?? record.path, record.failed === true]), [[["e1-full-id"], false], [["missing"], true], ["gone.ts", true]]);
		const report = reduceRetrieval(retrievalEvents(reopen(manager, dir).getEntries() as never), { needed: new Set(["e1-full-id"]) });
		assert.equal(report.entryReads, 1);
		assert.equal(report.fileReads, 0);
		assert.equal(report.failedReads, 2);
	});
});
