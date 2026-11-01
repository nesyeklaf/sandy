import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../src/core/config.ts";
import { CUT_DETAILS_KEY } from "../src/core/kinds.ts";
import { PI_RESERVE } from "../src/core/policy.ts";
import { CutController } from "../src/pi/cuts.ts";
import { piSdk } from "./support/pi.ts";

/*
 * The cut owner at pi's boundaries, against pi's own SessionManager and projector: drafts of earlier handlers survive,
 * the envelope counts system prompt, tools and the session's reserve, and a cut that frees no headroom is refused so
 * pi's native compaction stays reachable.
 */

type Manager = ReturnType<typeof piSdk.SessionManager.inMemory>;

const VERSION = piSdk.VERSION;
const config = resolveConfig({
	watermarkTokens: 20_000,
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 300,
	summaryTokens: 400,
	taskCutMinTokens: 5_000,
	// These tests pin the drafts of a cut; the cap's shadow record has its own tests.
	keptCap: { mode: "off", tokens: 24_000 },
});
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let clock = Date.UTC(2026, 9, 9, 12, 0, 0);

/** Appends turns of a prompt, a read and its result, and an answer. */
function turns(manager: Manager, from: number, count: number): Manager {
	const assistant = (content: unknown[], stopReason: string) =>
		manager.appendMessage({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason,
			timestamp: ++clock,
		} as never);
	for (let turn = from; turn < from + count; turn++) {
		manager.appendMessage({ role: "user", content: [{ type: "text", text: `Look at module-${turn}.` }], timestamp: ++clock });
		assistant([{ type: "toolCall", id: `c${turn}`, name: "read", arguments: { path: `src/${turn}.ts` } }], "toolUse");
		manager.appendMessage({
			role: "toolResult",
			toolCallId: `c${turn}`,
			toolName: "read",
			content: [{ type: "text", text: `FACT ${turn} holds.\n${"x".repeat(2_000)}` }],
			isError: false,
			timestamp: ++clock,
		} as never);
		assistant([{ type: "text", text: `Module ${turn} is fine.` }], "stop");
	}
	return manager;
}

interface Harness {
	readonly cuts: CutController;
	readonly ctx: ExtensionContext;
	readonly ledger: Record<string, unknown>[];
	readonly reports: string[];
	readonly compacts: { count: number };
}

function harness(
	manager: Manager,
	options: { system?: string; window?: number; tokens?: number; settings?: unknown } = {},
): Harness {
	const ledger: Record<string, unknown>[] = [];
	const reports: string[] = [];
	const compacts = { count: 0 };
	const window = options.window ?? 200_000;
	const pi = {
		getSettings: () => options.settings ?? {},
		getActiveTools: () => ["read"],
		getAllTools: () => [
			{ name: "read", description: "Read a file.", parameters: { type: "object" } },
			{ name: "inactive", description: "y".repeat(400_000), parameters: { type: "object" } },
		],
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: manager,
		model: { provider: "faux", id: "faux-1", contextWindow: window },
		hasUI: false,
		hasPendingMessages: () => false,
		isIdle: () => true,
		getSystemPrompt: () => options.system ?? "You are a coding agent.",
		getContextUsage: () => ({ tokens: options.tokens ?? 25_000, contextWindow: window, percent: null }),
		compact: (callbacks: { onComplete?: () => void }) => {
			compacts.count++;
			callbacks.onComplete?.();
		},
	} as unknown as ExtensionContext;
	const cuts = new CutController({
		config,
		pi,
		project: piSdk.buildSessionProjection as never,
		now: () => clock,
		tier: () => "short",
		ledger: (record) => ledger.push(record),
		report: (_ctx, _kind, text) => reports.push(text),
		notebookAvailable: () => true,
		competing: () => false,
		capEvidence: () => undefined,
	});
	cuts.start(ctx);
	return { cuts, ctx, ledger, reports, compacts };
}

const turnEnd = (entries: unknown[]) =>
	({ type: "turn_end", outcome: "completed", entries, context: { llmMessages: [] } }) as never;
const beforeCompact = (manager: Manager, reason: "threshold" | "overflow" | "manual", tokensBefore: number) =>
	({
		type: "session_before_compact",
		reason,
		preparation: { tokensBefore, firstKeptEntryId: manager.getBranch().at(-1)?.id },
		branchEntries: manager.getBranch(),
	}) as never;
const earlier = { type: "custom_message", customType: "other-extension", content: "kept", display: false } as const;
/** A system prompt the envelope estimates at about `tokens` provider tokens. */
const systemOf = (tokens: number) => "s".repeat(Math.ceil((tokens / 1.6) * 4));

describe("cut boundaries on pi " + VERSION, () => {
	it("keeps the drafts of earlier handlers first and unchanged, and appends the cut", () => {
		const { cuts, ctx } = harness(turns(piSdk.SessionManager.inMemory(), 0, 20));
		const result = cuts.finishTurn(turnEnd([earlier]), ctx, 25_000, cuts.thresholds(ctx));
		assert.ok(result);
		assert.equal(result.entries.length, 2);
		assert.equal(result.entries[0], earlier);
		const cut = result.entries[1] as { type: string; details: Record<string, unknown> };
		assert.equal(cut.type, "compaction");
		assert.ok(cut.details[CUT_DETAILS_KEY]);
		assert.deepEqual(cuts.pending(), { reason: "watermark", position: "run" });
	});

	it("adds nothing to a turn that already carries a compaction", () => {
		const { cuts, ctx } = harness(turns(piSdk.SessionManager.inMemory(), 0, 20));
		const foreign = { type: "compaction", summary: "theirs", firstKeptEntryId: "x" };
		assert.equal(cuts.finishTurn(turnEnd([foreign]), ctx, 25_000, cuts.thresholds(ctx)), undefined);
		assert.deepEqual(cuts.pending(), { reason: undefined, position: undefined });
	});

	it("counts only the active tools and the system prompt in the envelope", () => {
		const { cuts, ctx } = harness(piSdk.SessionManager.inMemory(), { system: systemOf(10_000) });
		const fixed = cuts.envelope(ctx).fixedTokens;
		assert.ok(fixed >= 10_000 && fixed < 10_100, `fixed ${fixed}`);
	});

	it("resolves the reserve as pi does: model override, then setting, then pi's default", () => {
		const manager = piSdk.SessionManager.inMemory();
		const compaction = { reserveTokens: 8_000, modelOverrides: { "faux/faux-1": { reserveTokens: 2_000 } } };
		const reserve = (settings: unknown) => {
			const { cuts, ctx } = harness(manager, { settings });
			return cuts.envelope(ctx).reserveTokens;
		};
		assert.equal(reserve({ compaction }), 2_000);
		assert.equal(reserve({ compaction: { reserveTokens: 8_000 } }), 8_000);
		assert.equal(reserve({}), PI_RESERVE);
	});

	it("refuses a watermark cut the system prompt would fill, without a draft", () => {
		const { cuts, ctx, ledger, reports } = harness(turns(piSdk.SessionManager.inMemory(), 0, 20), {
			system: systemOf(config.watermarkTokens),
		});
		assert.equal(cuts.finishTurn(turnEnd([earlier]), ctx, 25_000, cuts.thresholds(ctx)), undefined);
		assert.equal(ledger.at(-1)?.class, "cut-refused");
		assert.equal(ledger.at(-1)?.why, "short");
		assert.match(reports.at(-1) ?? "", /system prompt and tools alone take an estimated/);
	});

	it("returns nothing, never an empty result, when the cut frees no headroom below pi's compaction", () => {
		const manager = turns(piSdk.SessionManager.inMemory(), 0, 20);
		const { cuts, ctx, ledger, reports } = harness(manager, {
			window: 30_000,
			settings: { compaction: { reserveTokens: 4_000 } },
			system: systemOf(27_000),
		});
		assert.equal(cuts.beforeCompact(beforeCompact(manager, "threshold", 27_500), ctx), undefined);
		assert.equal(ledger.at(-1)?.class, "cut-disabled");
		assert.equal(ledger.at(-1)?.why, "no-room");
		assert.match(reports.at(-1) ?? "", /pi compacts on its own/);
		assert.deepEqual(cuts.pending(), { reason: undefined, position: undefined });
	});

	it("does not repeat a cut the next request refuted, so pi's own compaction runs, and cuts again later", () => {
		const manager = turns(piSdk.SessionManager.inMemory(), 0, 20);
		const { cuts, ctx, ledger } = harness(manager);
		const first = cuts.beforeCompact(beforeCompact(manager, "threshold", 25_000), ctx);
		assert.ok(first?.compaction);
		assert.deepEqual(cuts.pending(), { reason: "threshold", position: "pi" });
		// The provider counts more than before the cut: the estimate failed.
		cuts.settled(ctx, 26_000);
		const reconciled = ledger.at(-1);
		assert.equal(reconciled?.class, "cut-reconciled");
		assert.equal(reconciled?.failed, true);
		assert.equal(reconciled?.prompt, 26_000);
		assert.equal(cuts.beforeCompact(beforeCompact(manager, "threshold", 26_000), ctx), undefined);
		assert.equal(ledger.at(-1)?.why, "repeat");
		turns(manager, 20, 4);
		assert.ok(cuts.beforeCompact(beforeCompact(manager, "threshold", 28_000), ctx)?.compaction);
	});

	it("keeps cutting after a request confirmed the estimate", () => {
		const manager = turns(piSdk.SessionManager.inMemory(), 0, 20);
		const { cuts, ctx, ledger } = harness(manager);
		assert.ok(cuts.beforeCompact(beforeCompact(manager, "overflow", 25_000), ctx));
		cuts.settled(ctx, 6_000);
		assert.equal(ledger.at(-1)?.failed, undefined);
		assert.ok(cuts.beforeCompact(beforeCompact(manager, "overflow", 25_000), ctx));
	});

	it("starts a task cut before a prompt only when it frees headroom", async () => {
		const input = { type: "input", text: "next", source: "interactive" } as never;
		const roomy = turns(piSdk.SessionManager.inMemory(), 0, 20);
		const ready = harness(roomy, { tokens: 12_000 });
		ready.cuts.requestTask({ reason: "task done" });
		await ready.cuts.input(input, ready.ctx);
		assert.equal(ready.compacts.count, 1);
		assert.ok(ready.cuts.beforeCompact(beforeCompact(roomy, "manual", 12_000), ready.ctx));
		assert.deepEqual(ready.cuts.pending(), { reason: "task", position: "prompt" });

		const full = harness(turns(piSdk.SessionManager.inMemory(), 0, 20), { tokens: 12_000, system: systemOf(11_000) });
		full.cuts.requestTask({ reason: "task done" });
		await full.cuts.input(input, full.ctx);
		assert.equal(full.compacts.count, 0);
		assert.equal(full.ledger.at(-1)?.class, "cut-refused");
	});
});
