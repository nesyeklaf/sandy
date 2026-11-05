import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompetitorWarnings, observeOwners } from "../src/pi/coexist.ts";
import { createContextExtension } from "../src/pi/extension.ts";
import { piAi, piSdk } from "./support/pi.ts";

/*
 * Best-effort warning when another extension also compacts the session. A known competitor shows at startup by its
 * command; a competitor with only a hook shows after its cut won where ours was proposed. pi lists no hooks, and the
 * last loaded session_before_compact handler with a result wins, so both load orders run in the real pi runtime.
 */

const VERSION = piSdk.VERSION;
const COMPETITOR_SUMMARY = "COMPETITOR-SUMMARY";

describe("observeOwners", () => {
	it("names a known competitor from its command alone", () => {
		const evidence = observeOwners([{ name: "context" }, { name: "cached-compaction" }], undefined, undefined);
		assert.deepEqual(evidence, [{ reason: "known-command", competitor: "pi-cached-compaction", command: "cached-compaction" }]);
	});

	it("reads a command pi renamed for a name clash", () => {
		assert.equal(observeOwners([{ name: "cached-compaction:2" }], undefined, undefined).length, 1);
	});

	it("sees nothing in unrelated commands", () => {
		assert.deepEqual(observeOwners([{ name: "context" }, { name: "compact-more" }], undefined, undefined), []);
	});

	it("reports a foreign cut only where ours was proposed", () => {
		assert.deepEqual(observeOwners([], "threshold", { ours: false }), [{ reason: "foreign-cut-won", proposed: "threshold" }]);
		assert.deepEqual(observeOwners([], "threshold", { ours: true }), []);
		assert.deepEqual(observeOwners([], undefined, { ours: false }), []);
		assert.deepEqual(observeOwners([], "threshold", undefined), []);
	});
});

describe("CompetitorWarnings", () => {
	it("words each reason once", () => {
		const warnings = new CompetitorWarnings();
		const known = observeOwners([{ name: "cached-compaction" }], undefined, undefined);
		const won = observeOwners([], "threshold", { ours: false });
		assert.equal(warnings.fresh(known).length, 1);
		assert.deepEqual(warnings.fresh(known), []);
		assert.equal(warnings.fresh(won).length, 1);
		assert.deepEqual(warnings.fresh(won), []);
		assert.equal(warnings.fresh([...known, ...won]).length, 0);
	});

	it("names the competitor and the cause", () => {
		const [known, won] = [
			...new CompetitorWarnings().fresh(observeOwners([{ name: "cached-compaction" }], undefined, undefined)),
			...new CompetitorWarnings().fresh(observeOwners([], "threshold", { ours: false })),
		];
		assert.match(known ?? "", /^context: .*pi-cached-compaction.*\/cached-compaction/);
		assert.match(won ?? "", /^context: .*another extension.*threshold/);
	});
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

type Manager = ReturnType<typeof piSdk.SessionManager.inMemory>;

/** Turns large enough that pi finds something to compact. */
function seed(manager: Manager, turns: number): void {
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({ role: "user", content: [{ type: "text", text: `Turn ${turn}. ${"x".repeat(8_000)}` }], timestamp: ++clock });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Done ${turn}.` }],
			api: "faux",
			provider: "faux",
			model: "faux-coexist",
			usage,
			stopReason: "stop",
			timestamp: ++clock,
		} as never);
	}
}

interface Competitor {
	readonly command: boolean;
	readonly hook: boolean;
	/**
	 * Declares a tool too large for any cut to fit below pi's own compaction, inactive until `armed.on` is set; the hook
	 * activates it while it runs, so a handler loaded after it sees the large declaration.
	 */
	readonly armed?: { on: boolean };
}

function competitorExtension({ command, hook, armed }: Competitor) {
	return (pi: ExtensionAPI) => {
		if (command) pi.registerCommand("cached-compaction", { description: "competitor", handler: async () => {} });
		if (armed) {
			pi.registerTool({
				name: "huge",
				label: "huge",
				description: "word ".repeat(200_000),
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "huge")));
		}
		if (hook) {
			pi.on("session_before_compact", (event) => ({
				...(armed?.on ? (pi.setActiveTools([...pi.getActiveTools(), "huge"]), {}) : {}),
				compaction: {
					summary: COMPETITOR_SUMMARY,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			}));
		}
	};
}

/** The extension and a competitor, loaded in `order`, in a real pi session; returns what the user was told. */
async function run(
	competitor: Competitor | undefined,
	order: "ours first" | "ours last",
	scenario: (session: Awaited<ReturnType<typeof piSdk.createAgentSession>>["session"], told: string[]) => Promise<void>,
	prepare: (manager: Manager) => void = (manager) => seed(manager, 12),
): Promise<void> {
	const registration = piAi.registerFauxProvider({
		models: [{ id: "faux-coexist", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 }],
	});
	const model = registration.getModel();
	const provider = (pi: ExtensionAPI) =>
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: registration.api,
			models: registration.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
			})),
		} as never);
	const ours = createContextExtension({
		configFile: false,
		ledgerFile: false,
		keepWarm: false,
		config: { watermarkTokens: 20_000, keepRecentTokens: 1_000, maskedTokens: 500, pinnedUserTokens: 300, summaryTokens: 400 },
	});
	const others = competitor ? [competitorExtension(competitor)] : [];
	const dir = mkdtempSync(join(tmpdir(), "context-coexist-"));
	const loader = new piSdk.DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		extensionFactories: [provider, ...(order === "ours first" ? [ours, ...others] : [...others, ours])],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const modelRuntime = await piSdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	const manager = piSdk.SessionManager.inMemory(dir);
	prepare(manager);
	const { session } = await piSdk.createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: manager,
		model: model as never,
	});
	// Without a UI the warnings go to stderr.
	const told: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		const line = args.join(" ");
		if (line.startsWith("context:")) told.push(line);
	};
	try {
		await session.bindExtensions({});
		await scenario(session, told);
	} finally {
		console.error = original;
		session.dispose();
		registration.unregister();
	}
}

const lastCompaction = (manager: Manager) => {
	const compactions = manager.getEntries().filter((entry) => entry.type === "compaction");
	return compactions.at(-1) as { summary: string } | undefined;
};

describe(`a competing compaction hook in the pi ${VERSION} runtime`, () => {
	it("is named after its cut won, when it loads after us", async () => {
		await run({ command: false, hook: true }, "ours first", async (session, told) => {
			assert.deepEqual(told, [], "an invisible hook is not claimed at startup");
			await session.compact();
			assert.equal(lastCompaction(session.sessionManager)?.summary, COMPETITOR_SUMMARY);
			assert.equal(told.length, 1);
			assert.match(told[0] ?? "", /another extension/);
		});
	});

	it("is not named when it loads before us and we win", async () => {
		await run({ command: false, hook: true }, "ours last", async (session, told) => {
			await session.compact();
			assert.notEqual(lastCompaction(session.sessionManager)?.summary, COMPETITOR_SUMMARY);
			assert.match(lastCompaction(session.sessionManager)?.summary ?? "", /<context reason="manual">/);
			assert.deepEqual(told, []);
		});
	});

	it("is named once, however often it wins", async () => {
		await run({ command: false, hook: true }, "ours first", async (session, told) => {
			await session.compact();
			seed(session.sessionManager, 12);
			await session.compact();
			assert.equal(lastCompaction(session.sessionManager)?.summary, COMPETITOR_SUMMARY);
			assert.equal(told.length, 1);
		});
	});
});

describe(`a refused cut before a foreign winner in the pi ${VERSION} runtime`, () => {
	it("does not count the earlier cut of ours as a proposal", async () => {
		const armed = { on: false };
		// The competitor loads first: its large tool is active when ours runs, so ours refuses the second cut.
		await run({ command: false, hook: true, armed }, "ours last", async (session, told) => {
			await session.compact();
			assert.match(lastCompaction(session.sessionManager)?.summary ?? "", /<context reason="manual">/, "ours won the first");
			assert.deepEqual(told, []);
			seed(session.sessionManager, 12);
			armed.on = true;
			await session.compact();
			assert.equal(lastCompaction(session.sessionManager)?.summary, COMPETITOR_SUMMARY);
			assert.ok(
				told.some((line) => /pi compacts on its own/.test(line)),
				"the refusal is reported: " + JSON.stringify(told),
			);
			assert.ok(!told.some((line) => /in place of ours/.test(line)), "ours proposed nothing: " + JSON.stringify(told));
		});
	});
});

describe(`a known competitor's command in the pi ${VERSION} runtime`, () => {
	for (const order of ["ours first", "ours last"] as const) {
		it(`is named at startup, once, when we load ${order === "ours first" ? "before" : "after"} it`, async () => {
			await run({ command: true, hook: false }, order, async (session, told) => {
				assert.equal(told.length, 1);
				assert.match(told[0] ?? "", /pi-cached-compaction.*\/cached-compaction/);
				await session.compact();
				assert.equal(told.length, 1, "no hook, no second warning");
			});
		});
	}

	it("is named for its command at startup and for its cut when it wins", async () => {
		await run({ command: true, hook: true }, "ours first", async (session, told) => {
			assert.equal(told.length, 1);
			await session.compact();
			await session.compact().catch(() => undefined);
			assert.equal(told.length, 2);
			assert.match(told[0] ?? "", /\/cached-compaction/);
			assert.match(told[1] ?? "", /another extension/);
		});
	});
});

describe(`a foreign compaction already in the log on pi ${VERSION}`, () => {
	it("is not reported as a loaded competitor when the session resumes", async () => {
		await run(
			undefined,
			"ours last",
			async (session, told) => {
				assert.equal(lastCompaction(session.sessionManager)?.summary, "OLD-FOREIGN-SUMMARY");
				assert.deepEqual(told, []);
			},
			(manager) => {
				seed(manager, 4);
				const first = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
				assert.ok(first);
				manager.appendCompaction("OLD-FOREIGN-SUMMARY", first.id, 0, undefined, false);
				seed(manager, 2);
			},
		);
	});
});
