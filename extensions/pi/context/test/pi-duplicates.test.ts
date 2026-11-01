import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { accountingEvents, formatCostReport, reduceAccounting } from "../src/core/accounting.ts";
import { DEFAULT_CONFIG, resolveConfig } from "../src/core/config.ts";
import { CUT_DETAILS_KEY, DUPLICATE_KIND } from "../src/core/kinds.ts";
import { CutController } from "../src/pi/cuts.ts";
import { SessionTape } from "../src/pi/session.ts";
import { type FauxContext, piAi, piSdk } from "./support/pi.ts";
import { openRuntime } from "./support/lifecycle.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * Identical reads kept once, through pi: the controller at pi's boundary against pi's own SessionManager and
 * projector, and a real session whose captured requests show what the provider gets.
 */

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
const FILE = "export const answer = 42;\n" + "// ordinary line of a module\n".repeat(80);
const NOTE = /Same as the earlier read of/;

type Log = ReturnType<typeof sessionLog>;
const read = (log: Log, id: string, text: string, args: Record<string, unknown> = { path: "src/a.ts" }, isError = false) => {
	log.call(id, "read", args);
	return log.manager.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as never);
};
const filler = (log: Log, from: number, count: number) => {
	for (let turn = from; turn < from + count; turn++) {
		log.user("Look at module-" + turn);
		read(log, "f" + turn, "FACT " + turn + "\n" + "y".repeat(2_000), { path: "src/" + turn + ".ts" });
		log.answer("Module " + turn + " is fine.");
	}
};

function harness(log: Log, tokens = 5_000) {
	const ctx = {
		sessionManager: log.manager,
		model: { provider: "faux", id: "faux-1", contextWindow: 200_000 },
		hasUI: false,
		hasPendingMessages: () => false,
		isIdle: () => true,
		getSystemPrompt: () => "You are a coding agent.",
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: null }),
		compact: () => {},
	} as unknown as ExtensionContext;
	const pi = {
		getSettings: () => ({}),
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const counts = { projections: 0 };
	const ledger: Record<string, unknown>[] = [];
	const cuts = new CutController({
		config,
		pi,
		project: ((...args: Parameters<typeof piSdk.buildSessionProjection>) => {
			counts.projections++;
			return piSdk.buildSessionProjection(...args);
		}) as never,
		now: () => Date.UTC(2026, 9, 9, 12, 0, 0),
		tier: () => "short",
		ledger: (record: Record<string, unknown>) => ledger.push(record),
		report: () => {},
		notebookAvailable: () => false,
		competing: () => false,
		capEvidence: () => undefined,
	});
	cuts.start(ctx);
	/** One turn_end whose tool results are those of the given calls; the drafts of the handler are returned. */
	const turnEnd = (calls: string[], size = tokens, entries: unknown[] = []): SessionBoundaryDraft[] => {
		const results = new Map<string, unknown>();
		for (const entry of log.manager.getEntries()) {
			const message = entry.type === "message" ? (entry.message as { role: string; toolCallId?: string }) : undefined;
			if (message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
		}
		const event = {
			type: "turn_end",
			outcome: "completed",
			entries,
			toolResults: calls.map((toolCallId) => results.get(toolCallId) ?? { toolCallId }),
			context: { llmMessages: [] },
		} as never;
		return (cuts.finishTurn(event, ctx, size, cuts.thresholds(ctx))?.entries ?? []).slice(entries.length);
	};
	return { turnEnd, cuts, ctx, counts, ledger };
}

/** Commits drafts as pi does at a boundary. */
function commit(log: Log, drafts: readonly SessionBoundaryDraft[]): void {
	for (const draft of drafts) {
		if (draft.type === "context_edit") log.manager.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom") log.manager.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "compaction") {
			log.manager.appendCompaction(draft.summary, draft.firstKeptEntryId as string, 0, draft.details, true);
		}
	}
}

const shown = (log: Log) => Object.fromEntries(log.tape().modelView().entries.map((entry) => [entry.id, entry.text]));

describe("a repeated read at pi's boundary on pi " + VERSION, () => {
	it("replaces the fresh result of an identical read by a note that names the earlier one, and keeps the original", () => {
		const log = sessionLog();
		log.user("look");
		const first = read(log, "c1", FILE);
		log.answer("seen");
		log.user("again");
		const second = read(log, "c2", FILE);
		const drafts = harness(log).turnEnd(["c2"]);
		assert.deepEqual(drafts.map((draft) => draft.type), ["context_edit", "custom"]);
		const [edit, record] = drafts as [Extract<SessionBoundaryDraft, { type: "context_edit" }>, Extract<SessionBoundaryDraft, { type: "custom" }>];
		assert.equal(edit.targetId, second);
		assert.match(JSON.stringify(edit.replacement), NOTE);
		assert.ok(JSON.stringify(edit.replacement).includes("#" + first));
		assert.equal(record.customType, DUPLICATE_KIND);
		assert.ok(!JSON.stringify(record.data).includes("ordinary line"), "the record holds no content");
		commit(log, drafts);
		const after = shown(log);
		assert.equal(after[first], FILE, "the earlier read is untouched");
		assert.match(after[second] ?? "", NOTE);
		const written = log.manager.getEntry(second) as unknown as { message: { content: { text: string }[] } };
		assert.equal(written.message.content[0]?.text, FILE, "the raw result survives in the log");
	});

	it("keeps the drafts of earlier handlers first and unchanged", () => {
		const log = sessionLog();
		log.user("look");
		read(log, "c1", FILE);
		log.answer("seen");
		const second = read(log, "c2", FILE);
		const earlier = { type: "custom_message", customType: "other-extension", content: "kept", display: false };
		const drafts = harness(log).turnEnd(["c2"], 5_000, [earlier]);
		assert.equal((drafts[0] as { targetId?: string }).targetId, second);
	});

	it("leaves other ranges, other arguments, changed content, errors, foreign edits and nested results alone", () => {
		const log = sessionLog();
		log.user("look");
		read(log, "c1", FILE);
		log.answer("seen");
		const calls = [
			read(log, "d1", FILE, { path: "src/a.ts", offset: 10, limit: 50 }),
			read(log, "d2", FILE, { path: "src/b.ts" }),
			read(log, "d3", FILE + "one more line"),
			read(log, "d4", FILE, { path: "src/a.ts" }, true),
		];
		log.call("d5", "codemode", { code: "read a.ts" });
		const nested = log.result("d5", "codemode", FILE);
		const foreign = read(log, "d6", FILE);
		log.replace(foreign, "edited by another extension");
		const { turnEnd } = harness(log);
		assert.deepEqual(turnEnd(["d1", "d2", "d3", "d4", "d5", "d6"]), []);
		assert.equal(calls.length + (nested ? 1 : 0), 5);
	});

	it("projects the branch once at a boundary with a fresh read, and not at all at one without a read or a cut", () => {
		const log = sessionLog();
		filler(log, 0, 20);
		const { turnEnd, counts } = harness(log);
		counts.projections = 0;
		log.user("hello");
		log.answer("fine");
		assert.deepEqual(turnEnd([]), []);
		assert.equal(counts.projections, 0);
		log.user("look");
		read(log, "c1", FILE);
		assert.deepEqual(turnEnd(["c1"]), []);
		assert.equal(counts.projections, 1);
	});

	it("does not edit a result a request has already carried", () => {
		const log = sessionLog();
		log.user("look");
		read(log, "c1", FILE);
		log.answer("seen");
		read(log, "c2", FILE);
		assert.deepEqual(harness(log).turnEnd(["other"]), []);
	});

	it("collapses a third copy to the first, never to the second", () => {
		const log = sessionLog();
		log.user("look");
		const first = read(log, "c1", FILE);
		log.answer("seen");
		const second = read(log, "c2", FILE);
		const { turnEnd } = harness(log);
		commit(log, turnEnd(["c2"]));
		log.answer("again");
		read(log, "c3", FILE);
		const drafts = turnEnd(["c3"]);
		assert.ok(JSON.stringify(drafts[0]).includes("#" + first));
		assert.ok(!JSON.stringify(drafts[0]).includes("#" + second));
	});

	it("counts what the notes collapsed in the cost report", () => {
		const log = sessionLog();
		log.user("look");
		read(log, "c1", FILE);
		log.answer("seen");
		read(log, "c2", FILE);
		const requests = reduceAccounting(accountingEvents(log.manager.getEntries())).requests;
		commit(log, harness(log).turnEnd(["c2"]));
		const report = reduceAccounting(accountingEvents(log.manager.getEntries()));
		assert.ok(report.dedupCollapsedTokens > 300, "collapsed " + report.dedupCollapsedTokens);
		assert.equal(report.requests, requests, "the note adds no request");
		assert.ok(formatCostReport(report).some((line) => line.startsWith("Repeated reads kept once")));
	});
});

describe("a cut that archives the earlier read on pi " + VERSION, () => {
	/** A note made at an earlier boundary, a long stretch of other work after it. */
	function withNote() {
		const log = sessionLog();
		log.user("look");
		const first = read(log, "c0", FILE);
		log.answer("seen");
		filler(log, 0, 18);
		log.user("again");
		const second = read(log, "cN", FILE);
		const rig = harness(log);
		commit(log, rig.turnEnd(["cN"]));
		log.answer("noted");
		return { log, first, second, ...rig };
	}

	it("gives the kept note its full text back in the same boundary, before the cut", () => {
		const { log, first, second, turnEnd } = withNote();
		assert.match(shown(log)[second] ?? "", NOTE);
		const drafts = turnEnd([], 25_000);
		assert.deepEqual(drafts.map((draft) => draft.type), ["context_edit", "compaction"]);
		commit(log, drafts);
		const after = shown(log);
		assert.equal(after[second], FILE, "the retained duplicate is whole again");
		assert.equal(after[first], undefined, "the original is archived");
		assert.equal(SessionTape.read(log.manager.getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG).duplicates().aliases.size, 0);
	});

	it("makes no note for a read the same cut archives the earlier copy of", () => {
		const log = sessionLog();
		log.user("look");
		read(log, "c0", FILE);
		log.answer("seen");
		filler(log, 0, 18);
		log.user("again");
		const second = read(log, "cN", FILE);
		const drafts = harness(log).turnEnd(["cN"], 25_000);
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction"]);
		commit(log, drafts);
		assert.equal(shown(log)[second], FILE);
		assert.ok((drafts[0] as { details?: Record<string, unknown> }).details?.[CUT_DETAILS_KEY]);
	});

	it("leaves a note whose earlier read a cut not ours archived: it names the entry history_read opens, and no later boundary edits it", () => {
		const { log, first, second, turnEnd } = withNote();
		log.manager.appendCompaction("FOREIGN", log.manager.getEntry(second)?.parentId as string, 0, undefined, false);
		assert.equal(shown(log)[first], undefined);
		assert.deepEqual(turnEnd([]), [], "an edit here would break the prefix the last request cached");
		assert.ok((shown(log)[second] ?? "").includes("history_read #" + first));
		assert.match(shown(log)[second] ?? "", /once it has left your context/);
	});

	it("makes our cut of a compaction pi starts without a note that points at nothing, and edits nothing after it", () => {
		const { log, first, second, cuts, ctx, turnEnd } = withNote();
		const out = cuts.beforeCompact({ reason: "manual", branchEntries: log.manager.getBranch(), preparation: { tokensBefore: 25_000 } } as never, ctx);
		assert.ok(out);
		commit(log, [{ type: "compaction", ...out.compaction } as never]);
		assert.equal(shown(log)[first], undefined, "the original is archived");
		const note = shown(log)[second] ?? "";
		assert.ok(note.includes("history_read #" + first));
		assert.match(note, /once it has left your context/);
		assert.deepEqual(turnEnd([]), [], "no repair after the request that carried the cut");
	});

	it("counts the text a note gets back in the cut's expected size", () => {
		/** The cut's estimate against the context it leaves, both in provider tokens at the same ratio. */
		const miss = (noted: boolean) => {
			const log = sessionLog();
			log.user("look");
			read(log, "c0", FILE);
			log.answer("seen");
			filler(log, 0, 18);
			log.user("again");
			read(log, "cN", FILE);
			const rig = harness(log);
			const drafts = rig.turnEnd(["cN"]);
			if (noted) commit(log, drafts);
			log.answer("noted");
			const ratio = 2.5;
			const cut = rig.turnEnd([], Math.ceil(log.tape().modelView().tokens * ratio));
			assert.equal(cut.some((draft) => draft.type === "context_edit"), noted, "only the note is promoted");
			commit(log, cut);
			rig.cuts.settled(rig.ctx, 1_000);
			const estimated = rig.ledger.find((record) => record.class === "cut-reconciled")?.estimated as number;
			return estimated - log.tape().modelView().tokens * ratio;
		};
		const whole = miss(false);
		const promoted = miss(true);
		assert.ok(Math.abs(promoted - whole) < 20, "missed by " + promoted + " with the promotion, " + whole + " without a note");
	});

	it("makes the cut without the promotion when the promoted text would keep it above its limit, and the note stays", () => {
		const big = "file line unchanged\n".repeat(8_000);
		const log = sessionLog();
		log.user("look");
		const first = read(log, "c0", big);
		log.answer("seen");
		filler(log, 0, 18);
		log.user("again");
		const second = read(log, "cN", big);
		const { turnEnd } = harness(log);
		commit(log, turnEnd(["cN"]));
		log.answer("noted");
		const drafts = turnEnd([], 25_000);
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction"]);
		commit(log, drafts);
		assert.equal(shown(log)[first], undefined);
		assert.ok((shown(log)[second] ?? "").includes("history_read #" + first));
	});

	it("gives a note its text back when another extension edited its read call away", () => {
		const { log, first, second, turnEnd } = withNote();
		log.replace(log.manager.getEntry(second)?.parentId as string, "call was edited away");
		assert.match(shown(log)[second] ?? "", NOTE);
		const drafts = turnEnd([], 25_000);
		assert.deepEqual(drafts.map((draft) => draft.type), ["context_edit", "compaction"]);
		commit(log, drafts);
		assert.equal(shown(log)[first], undefined);
		assert.equal(shown(log)[second], FILE);
	});

	it("leaves a note whose earlier read stays whole, and one another extension edited later", () => {
		const { log, second, turnEnd } = withNote();
		assert.deepEqual(turnEnd([]), []);
		log.replace(second, "their own replacement");
		commit(log, turnEnd([], 25_000).filter((draft) => draft.type === "compaction"));
		assert.equal(SessionTape.read(log.manager.getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG).duplicates().aliases.size, 0);
		assert.equal(shown(log)[second], "their own replacement", "their edit stands; a promotion would undo it");
	});
});

describe("a repeated read in a real pi session on pi " + VERSION, () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function run(second: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "context-duplicates-"));
		dirs.push(dir);
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), FILE);
		const captured: FauxContext[] = [];
		let calls = 0;
		const { runtime, faux } = await openRuntime({
			dir,
			manager: piSdk.SessionManager.inMemory(dir) as never,
			trace: [],
			options: { configFile: false, ledgerFile: false, keepWarm: false },
			respond: (context) => {
				captured.push(context);
				calls++;
				// Requests 1 and 3 ask for a read, 2 and 4 answer.
				return calls % 2 === 1
					? piAi.fauxAssistantMessage([piAi.fauxToolCall("read", { path: "src/a.ts" }, { id: "r" + calls })], { stopReason: "toolUse" })
					: piAi.fauxAssistantMessage(piAi.fauxText("done " + calls));
			},
		});
		try {
			await runtime.session.bindExtensions({});
			await runtime.session.prompt("read the file");
			second(dir);
			await runtime.session.prompt("read it again");
			return { captured, manager: runtime.session.sessionManager };
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	}

	it("sends the second identical read as a note, with the cached earlier prefix byte for byte the same", async () => {
		const { captured, manager } = await run(() => {});
		assert.equal(captured.length, 4);
		const [, , third, fourth] = captured;
		assert.ok(third && fourth);
		const prefix = JSON.stringify(third.messages);
		assert.equal(JSON.stringify(fourth.messages.slice(0, third.messages.length)), prefix, "the cached prefix is unchanged");
		assert.ok(prefix.includes("ordinary line of a module"), "the first read is whole in the prefix");
		const added = JSON.stringify(fourth.messages.slice(third.messages.length));
		assert.match(added, NOTE);
		assert.ok(!added.includes("ordinary line of a module"), "the second read is not sent again");
		const results = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		assert.equal(results.length, 2);
		for (const entry of results) {
			assert.ok(JSON.stringify((entry as { message: unknown }).message).includes("ordinary line of a module"), "the raw results survive");
		}
		const report = reduceAccounting(accountingEvents(manager.getEntries() as never));
		assert.ok(report.dedupCollapsedTokens > 300);
	});

	it("sends both reads whole when the file changed in between", async () => {
		const { captured } = await run((dir) => writeFileSync(join(dir, "src", "a.ts"), FILE + "// edited\n"));
		const fourth = captured[3];
		assert.ok(fourth);
		const sent = JSON.stringify(fourth.messages);
		assert.ok(!NOTE.test(sent));
		assert.equal(sent.split("export const answer = 42;").length - 1, 2, "both results are whole");
	});
});
