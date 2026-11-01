import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { readCapShadowRecord } from "../src/core/cap-record.ts";
import { capRemoval } from "../src/core/kept-cap.ts";
import { estimateBudget } from "../src/core/tokens.ts";
import { type ContextConfigInput, resolveConfig } from "../src/core/config.ts";
import { CAP_SHADOW_KIND, CUT_DETAILS_KEY } from "../src/core/kinds.ts";
import { keptCapEvidence } from "../src/pi/config.ts";
import { createContextExtension } from "../src/pi/extension.ts";
import { boundaryHarness, commitDrafts, type Log } from "./support/boundary.ts";
import { fakePi } from "./support/host.ts";
import { passingProbe } from "./support/kept-cap.ts";
import { openRuntime } from "./support/lifecycle.ts";
import { type FauxContext, piAi, piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * The kept-history cap through pi: what a boundary and a compaction do in each mode, what a real session sends, and
 * the startup that refuses mode "on" without evidence.
 */

const VERSION = piSdk.VERSION;
const BUDGETS = { watermarkTokens: 20_000, keepRecentTokens: 1_000, maskedTokens: 500, pinnedUserTokens: 300, summaryTokens: 400, taskCutMinTokens: 5_000 };
const withCap = (keptCap: ContextConfigInput["keptCap"]) => resolveConfig({ ...BUDGETS, keptCap });
const OFF = withCap({ mode: "off", tokens: 1_000 });
const SHADOW = withCap({ mode: "shadow", tokens: 1_000 });
const ON = withCap({ mode: "on", tokens: 1_000 });
const FILE = "export const answer = 42;\n" + "// ordinary line of a module\n".repeat(240);
/**
 * A read of about 580 estimated tokens: with the turn it is in it fits the cap of 1,000 provider tokens (625
 * estimated), the turn of the earlier read beside the note's does not.
 */
const SMALL = "export const answer = 42;\n" + "// line\n".repeat(287);

const typesOf = (drafts: readonly SessionBoundaryDraft[]) => drafts.map((draft) => draft.type + (draft.type === "custom" ? ":" + draft.customType : ""));
const compactionOf = (drafts: readonly SessionBoundaryDraft[]) => drafts.find((draft) => draft.type === "compaction") as Extract<SessionBoundaryDraft, { type: "compaction" }>;
const shadowOf = (drafts: readonly SessionBoundaryDraft[]) => {
	const draft = drafts.find((one) => one.type === "custom" && one.customType === CAP_SHADOW_KIND) as Extract<SessionBoundaryDraft, { type: "custom" }> | undefined;
	return draft ? readCapShadowRecord(draft.data) : undefined;
};

/**
 * Twelve turns, then a read and its repeat, which the boundary turns into a note in `config`. The baseline cut keeps
 * both reads; the cap keeps only the later turn, so it archives the read the note points at.
 */
function notedRead(config: typeof OFF, file = FILE) {
	const log = history(12);
	log.user("look");
	log.call("c0", "read", { path: "src/a.ts" });
	const first = log.result("c0", "read", file);
	log.answer("seen");
	log.user("again");
	log.call("cN", "read", { path: "src/a.ts" });
	const second = log.result("cN", "read", file);
	const harness = boundaryHarness(log, config, 5_000);
	commitDrafts(log, harness.turnEnd(["cN"]));
	log.answer("noted");
	const shown = (id: string) => log.tape().modelView().entries.find((entry) => entry.id === id)?.text;
	assert.match(shown(second) ?? "", /Same as the earlier read of/);
	return { log, first, second, harness, shown };
}

/** Turns of a prompt, a read of about 500 tokens and an answer. */
function history(turns: number, log: Log = sessionLog()): Log {
	for (let turn = 0; turn < turns; turn++) log.turn("t" + turn, 2_000);
	return log;
}

describe("the kept cap at pi's boundary on pi " + VERSION, () => {
	it("in shadow adds a record of what the cap would remove and leaves the cut exactly as it is without the cap", () => {
		const log = history(12);
		const off = boundaryHarness(log, OFF).turnEnd([], 25_000);
		const shadow = boundaryHarness(log, SHADOW).turnEnd([], 25_000);
		assert.deepEqual(typesOf(off), ["compaction"]);
		assert.deepEqual(typesOf(shadow), ["compaction", "custom:" + CAP_SHADOW_KIND]);
		const [a, b] = [compactionOf(off), compactionOf(shadow)];
		assert.equal(b.firstKeptEntryId === undefined, a.firstKeptEntryId === undefined);
		assert.deepEqual(b, a, "the same cut, byte for byte");
		const record = shadowOf(shadow);
		assert.ok(record);
		assert.equal(record.mode, "shadow");
		assert.equal(record.applied, false);
		assert.ok(record.entries > 0 && record.tokens > 0 && record.deferral === undefined);
		assert.ok(record.ids && record.ids.length === record.entries);
		assert.ok(!JSON.stringify(record).includes("FACT"), "no content in the record");
	});

	it("keeps the committed cut identical to the cut without the cap, entry for entry", () => {
		const [offLog, shadowLog] = [history(12), history(12)];
		commitDrafts(offLog, boundaryHarness(offLog, OFF).turnEnd([], 25_000));
		commitDrafts(shadowLog, boundaryHarness(shadowLog, SHADOW).turnEnd([], 25_000));
		// Entry ids differ between the two logs; what the model sees of them is the same once they are masked.
		const view = (log: Log) => log.tape().modelView().entries.map((entry) => entry.text.replace(/\[#?[0-9a-f]{0,8} /g, "[").replace(/#[0-9a-f]{8}/g, "#"));
		assert.deepEqual(view(shadowLog), view(offLog));
	});

	it("in off writes nothing", () => {
		assert.deepEqual(typesOf(boundaryHarness(history(12), OFF).turnEnd([], 25_000)), ["compaction"]);
	});

	it("records a deferral when the newest turn is larger than the cap, and the cut is still the baseline", () => {
		const log = history(12);
		log.turn("big", 40_000);
		const drafts = boundaryHarness(log, SHADOW).turnEnd([], 25_000);
		const record = shadowOf(drafts);
		assert.ok(record);
		assert.equal(record.deferral, "atomic-tail");
		assert.equal(record.entries, 0);
		assert.equal(compactionOf(drafts).type, "compaction");
	});

	it("writes no record for a boundary that makes no cut", () => {
		assert.deepEqual(typesOf(boundaryHarness(history(12), SHADOW, 5_000).turnEnd([], 5_000)), []);
	});

	it("in on cuts from the capped start, which the record names", () => {
		const shadowDrafts = boundaryHarness(history(12), SHADOW).turnEnd([], 25_000);
		const onLog = history(12);
		const onDrafts = boundaryHarness(onLog, ON).turnEnd([], 25_000);
		const record = shadowOf(onDrafts);
		assert.ok(record);
		assert.equal(record.applied, true);
		assert.equal(record.mode, "on");
		assert.ok(shadowOf(shadowDrafts)?.cappedFromId);
		const details = compactionOf(onDrafts).details as Record<string, { keptFromId: string; archivedEntries: number }>;
		assert.equal(details[CUT_DETAILS_KEY]?.keptFromId, record.cappedFromId);
		assert.ok((details[CUT_DETAILS_KEY]?.archivedEntries ?? 0) > (compactionOf(shadowDrafts).details as typeof details)[CUT_DETAILS_KEY]!.archivedEntries);
	});

	/** Estimated tokens of what the cut keeps, and what the cap says of that range once more. */
	const keptAfter = (log: Log, keptId: string) => {
		const { entries } = log.tape().history();
		const at = entries.findIndex((entry) => entry.id === keptId);
		const kept = entries.slice(at).reduce((total, entry) => total + entry.tokens, 0);
		return { kept, again: capRemoval(entries, at, estimateBudget(1_000)) };
	};

	it("in on keeps a note whose text back would take the kept range past the cap a note, and the range within the cap", () => {
		// FILE is about 1,750 estimated tokens, the cap 1,000 provider tokens: promoted, the newest round alone outgrows it.
		const { log, first, second, harness, shown } = notedRead(ON);
		const drafts = harness.turnEnd([], 25_000);
		assert.deepEqual(typesOf(drafts), ["compaction", "custom:" + CAP_SHADOW_KIND]);
		const record = shadowOf(drafts);
		assert.equal(record?.applied, true);
		assert.equal(record?.promotions, 0, "nothing is promoted, so nothing is recorded");
		commitDrafts(log, drafts);
		assert.equal(shown(first), undefined, "the cap archives the earlier read");
		assert.ok((shown(second) ?? "").includes("history_read #" + first));
		const { kept, again } = keptAfter(log, compactionOf(drafts).firstKeptEntryId as string);
		assert.ok(kept <= estimateBudget(1_000), "kept " + kept);
		assert.equal(again.kind === "defer" && again.why, "within-cap");
	});

	it("in on gives a note its text back when the text fits the cap, planned on the range after it, and records what it sent", () => {
		const { log, first, second, harness, shown } = notedRead(ON, SMALL);
		const drafts = harness.turnEnd([], 25_000);
		assert.deepEqual(typesOf(drafts), ["context_edit", "compaction", "custom:" + CAP_SHADOW_KIND]);
		assert.equal(shadowOf(drafts)?.promotions, 1);
		commitDrafts(log, drafts);
		assert.equal(shown(first), undefined);
		assert.equal(shown(second), SMALL);
		const { kept, again } = keptAfter(log, compactionOf(drafts).firstKeptEntryId as string);
		assert.ok(kept <= estimateBudget(1_000), "kept " + kept);
		assert.equal(again.kind === "defer" && again.why, "within-cap");
	});

	it("in shadow records the promotions the capped cut would send in on, and sends none beside the baseline", () => {
		const shadow = notedRead(SHADOW, SMALL);
		const drafts = shadow.harness.turnEnd([], 25_000);
		assert.deepEqual(typesOf(drafts), ["compaction", "custom:" + CAP_SHADOW_KIND], "the baseline keeps the earlier read");
		assert.equal(shadowOf(drafts)?.promotions, 1);
		const big = notedRead(SHADOW).harness.turnEnd([], 25_000);
		assert.equal(shadowOf(big)?.promotions, 0, "on would make the capped cut without the promotion");
	});
});

describe("pi's own compaction with the cap on pi " + VERSION, () => {
	const compaction = (config: typeof OFF, reason: "threshold" | "overflow") => {
		const log = history(12);
		const harness = boundaryHarness(log, config);
		const result = harness.beforeCompact(reason, 25_000);
		return { result, appended: harness.appended };
	};
	const keptOf = (result: ReturnType<typeof compaction>["result"]) => result?.compaction.firstKeptEntryId;

	it("keeps the baseline cut on overflow and threshold alike while the cap is in shadow, as it does without the cap", () => {
		for (const reason of ["threshold", "overflow"] as const) {
			const off = compaction(OFF, reason);
			const shadow = compaction(SHADOW, reason);
			assert.ok(off.result && shadow.result, reason);
			assert.equal(typeof keptOf(shadow.result), "string");
			assert.equal(shadow.result.compaction.summary.length, off.result.compaction.summary.length);
			assert.equal(shadow.appended.length, 1, "one shadow record");
			assert.equal(shadow.appended[0]?.customType, CAP_SHADOW_KIND);
			assert.equal(readCapShadowRecord(shadow.appended[0]?.data)?.applied, false);
			assert.equal(off.appended.length, 0);
		}
	});

	it("leaves a note the capped cut of pi's compaction outlives true, edits nothing after it, and records no promotion", () => {
		for (const config of [ON, SHADOW]) {
			for (const reason of ["manual", "threshold", "overflow"] as const) {
				const label = config.keptCap.mode + " " + reason;
				const { log, first, second, harness, shown } = notedRead(config);
				const result = harness.beforeCompact(reason, 25_000);
				assert.ok(result, label);
				const record = readCapShadowRecord(harness.appended.at(-1)?.data);
				assert.equal(record?.promotions, 0, label + ": pi's compaction promotes nothing");
				log.manager.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, 0, result.compaction.details, true);
				assert.equal(shown(first) === undefined, config.keptCap.mode === "on", label + ": only the capped cut archives the earlier read");
				const note = shown(second) ?? "";
				assert.ok(note.includes("history_read #" + first), label);
				assert.match(note, /once it has left your context/, label);
				assert.deepEqual(harness.turnEnd([]), [], label + ": no edit after the request that carried the cut");
			}
		}
	});

	it("takes the capped start on overflow too once the cap is on, since the gate is the startup and no path goes around it", () => {
		const baseline = compaction(OFF, "overflow");
		const capped = compaction(ON, "overflow");
		assert.ok(baseline.result && capped.result);
		assert.notEqual(keptOf(capped.result), keptOf(baseline.result));
		assert.equal(readCapShadowRecord(capped.appended[0]?.data)?.cappedFromId, keptOf(capped.result));
	});
});

describe("a real pi session with the cap on pi " + VERSION, () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Six turns that each read a 12,000-character file; the sixth prompt crosses the watermark and cuts. */
	async function run(keptCap: ContextConfigInput["keptCap"], probeModel?: string) {
		const dir = mkdtempSync(join(tmpdir(), "context-kept-cap-"));
		dirs.push(dir);
		mkdirSync(join(dir, "src"));
		for (let n = 0; n < 14; n++) writeFileSync(join(dir, "src", n + ".ts"), ("// module " + n + "\n" + "export const value = " + n + ";\n").repeat(80));
		const captured: FauxContext[] = [];
		let turn = 0;
		const config = { ...BUDGETS, watermarkTokens: 9_000, notebookMaxBytes: 1_024, keepRecentTokens: 4_800, coldCutMinTokens: 8_000, keptCap };
		// The record the start of mode "on" needs, made for `probeModel`.
		let keptCapProbeFile: string | false = false;
		if (probeModel !== undefined) {
			keptCapProbeFile = join(dir, "probe.json");
			writeFileSync(keptCapProbeFile, JSON.stringify({ ...passingProbe(resolveConfig(config)), model: probeModel }));
		}
		const { runtime, faux } = await openRuntime({
			dir,
			manager: piSdk.SessionManager.inMemory(dir) as never,
			trace: [],
			options: { configFile: false, ledgerFile: false, keepWarm: false, config, keptCapProbeFile },
			respond: (context) => {
				captured.push(context);
				const last = context.messages[context.messages.length - 1];
				if (last?.role === "toolResult") return piAi.fauxAssistantMessage(piAi.fauxText("done " + turn));
				turn++;
				return piAi.fauxAssistantMessage([piAi.fauxToolCall("read", { path: "src/" + turn + ".ts" }, { id: "r" + turn })], { stopReason: "toolUse" });
			},
		});
		try {
			await runtime.session.bindExtensions({});
			for (let n = 0; n < 12; n++) await runtime.session.prompt("read module " + n);
			return { captured, entries: runtime.session.sessionManager.getEntries() as unknown as { type: string; customType?: string; data?: unknown }[] };
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	}

	const sent = (captured: FauxContext[]) => JSON.stringify(captured.map((context) => context.messages), (key, value) => (key === "timestamp" || key === "durationMs" ? undefined : value))
		.replace(/context-kept-cap-\w+/g, "DIR")
		.replace(/#[0-9a-f]{8}/g, "#id")
		.replace(/faux:\d+:\w+/g, "faux");

	it("sends the same requests in shadow as with the cap off, and records what it would have removed", async () => {
		const off = await run({ mode: "off", tokens: 4_800 });
		const shadow = await run({ mode: "shadow", tokens: 4_800 });
		assert.ok(off.entries.some((entry) => entry.type === "compaction"), "the session was cut");
		assert.equal(off.entries.filter((entry) => entry.customType === CAP_SHADOW_KIND).length, 0);
		assert.ok(shadow.entries.filter((entry) => entry.customType === CAP_SHADOW_KIND).length >= 1, "a shadow record");
		assert.equal(shadow.captured.length, off.captured.length);
		assert.equal(sent(shadow.captured), sent(off.captured), "what the provider gets is the same, byte for byte");
	});

	it("caps in on only for a model the probe record covers, and sends the baseline for another", async () => {
		const appliedOf = (entries: { customType?: string; data?: unknown }[]) => entries.filter((entry) => entry.customType === CAP_SHADOW_KIND).map((entry) => readCapShadowRecord(entry.data)?.applied);
		const off = await run({ mode: "off", tokens: 4_800 });
		const covered = await run({ mode: "on", tokens: 4_800 }, "faux/faux-main");
		const other = await run({ mode: "on", tokens: 4_800 }, "entirely-other-provider/entirely-other-model");
		assert.ok(appliedOf(covered.entries).includes(true), "a model the record covers is capped");
		assert.ok(appliedOf(other.entries).length >= 1 && appliedOf(other.entries).every((applied) => applied === false), "another model is not");
		assert.equal(sent(other.captured), sent(off.captured), "what the provider gets is what it gets without the cap");
		assert.notEqual(sent(covered.captured), sent(off.captured));
	});
});

describe("the probe evidence and the session model on pi " + VERSION, () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	it("reads the record again at every cut: one overwritten after the start no longer caps", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-probe-"));
		dirs.push(dir);
		const file = join(dir, "probe.json");
		const config = resolveConfig({ ...BUDGETS, keptCap: { mode: "on", tokens: 1_000 } });
		const write = (change: (r: ReturnType<typeof passingProbe>) => void = () => {}) => {
			const r = passingProbe(config);
			change(r);
			writeFileSync(file, JSON.stringify(r));
		};
		write();
		const log = history(12);
		const harness = boundaryHarness(log, ON, 5_000, () => {
			const { verdict } = keptCapEvidence(config, file, "faux/faux-1");
			return verdict.ok ? undefined : verdict.reason;
		});
		assert.equal(shadowOf(harness.turnEnd([], 25_000))?.applied, false, "the record names another model");
		write((r) => void (r.model = "faux/faux-1"));
		assert.equal(shadowOf(harness.turnEnd([], 25_000))?.applied, true, "a record for the model caps");
		write((r) => void ((r.model = "faux/faux-1"), (r.savedShare = 0)));
		assert.equal(shadowOf(harness.turnEnd([], 25_000))?.applied, false, "a record that now fails does not");
	});
});

describe("a start with the cap on, on pi " + VERSION, () => {
	const files = (content: string | undefined): string => {
		const dir = mkdtempSync(join(tmpdir(), "context-probe-"));
		dirs.push(dir);
		const file = join(dir, "probe.json");
		if (content !== undefined) writeFileSync(file, content);
		return file;
	};
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const config = { keptCap: { mode: "on" as const } };
	const load = (keptCapProbeFile: string | false, extra: ContextConfigInput = config) => {
		const pi = fakePi();
		let error: Error | undefined;
		try {
			createContextExtension({ configFile: false, ledgerFile: false, keepWarm: false, config: extra, keptCapProbeFile })(pi.api);
		} catch (thrown) {
			error = thrown as Error;
		}
		return { pi, error };
	};
	const record = (change: (r: ReturnType<typeof passingProbe>) => void = () => {}) => {
		const r = passingProbe(resolveConfig(config));
		change(r);
		return JSON.stringify(r);
	};

	it("starts with a record that names this cap and passes the frozen thresholds", () => {
		const { error, pi } = load(files(record()));
		assert.equal(error, undefined);
		assert.ok(pi.registered.includes("tool:history_search"));
	});

	it("refuses to start without a record, and registers nothing", () => {
		for (const file of [files(undefined), false] as const) {
			const { error, pi } = load(file);
			assert.ok(error);
			assert.match(error.message, /invalid configuration/);
			assert.match(error.message, /keptCap\.mode "on"/);
			assert.match(error.message, /missing/);
			assert.deepEqual(pi.registered, []);
		}
	});

	it("refuses to start with a record that failed", () => {
		const { error, pi } = load(files(record((r) => void (r.savedShare = 0.001))));
		assert.ok(error);
		assert.match(error.message, /keptCap\.mode "on"/);
		assert.match(error.message, /failed/);
		assert.deepEqual(pi.registered, []);
	});

	it("refuses to start with a record made for another cap", () => {
		const { error, pi } = load(files(record((r) => void (r.cap.tokens += 1_000))));
		assert.ok(error);
		assert.match(error.message, /mismatch/);
		assert.match(error.message, /cap\.tokens/);
		assert.deepEqual(pi.registered, []);
		const other = load(files(record()), { keptCap: { mode: "on", tokens: resolveConfig().keptCap.tokens + 1_000 } });
		assert.match(other.error?.message ?? "", /mismatch/);
	});

	it("refuses a record that is not JSON, and does not look at the record in the other modes", () => {
		const { error } = load(files("{ nope"));
		assert.match(error?.message ?? "", /malformed|cannot be read/);
		for (const mode of ["off", "shadow"] as const) assert.equal(load(files(undefined), { keptCap: { mode } }).error, undefined);
		assert.equal(load(files(undefined), {}).error, undefined, "the default is shadow");
	});
});
