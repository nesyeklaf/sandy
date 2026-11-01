import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { type CutFrame, cappedPlan, planCut } from "../src/core/cut.ts";
import { capShadowRecord, readCapShadowRecord } from "../src/core/cap-record.ts";
import { parseConfig, resolveConfig } from "../src/core/config.ts";
import { CAP_SHADOW_KIND } from "../src/core/kinds.ts";
import { capRemoval, formatCapShadowReport, reduceCapShadow } from "../src/core/kept-cap.ts";
import {
	digestText,
	KEPT_CAP_SUITE_DIGEST,
	PROBE_DESIGN,
	PROBE_THRESHOLDS,
	PROBE_THRESHOLDS_DIGEST,
	type ProbeRecord,
	suiteDigest,
	thresholdsDigest,
	validateProbeRecord,
} from "../src/core/kept-cap-probe.ts";
import { decodeContextRecord } from "../src/core/records.ts";
import { retrievalEvents } from "../src/core/retrieval.ts";
import type { CutEnvelope } from "../src/core/policy.ts";
import { estimateBudget } from "../src/core/tokens.ts";
import type { LogEntry } from "../src/core/types.ts";
import { entry } from "./helpers.ts";
import { PROBED_MODEL, passingProbe, probeExpectation } from "./support/kept-cap.ts";
import { small } from "./support/core.ts";
import { compaction, type RawEntry, toolCall, toolResult } from "./support/accounting.ts";

/*
 * The kept-history cap: what it would remove from the range a cut keeps, the shadow counters, and the probe record that
 * must exist before the cap may be switched on. The baseline is planCut of slice 11.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "kept-cap");
const CAP_PROVIDER = 4_500;
const cap = estimateBudget(CAP_PROVIDER);
const roomy = { fixedTokens: 2_000, reserveTokens: 16_384, contextWindow: 200_000 } satisfies CutEnvelope;

/** Turns of a user message, a tool call, a tool result of the given size and an answer: 20 + 30 + size + 50 tokens. */
function turns(sizes: readonly number[], from = 0): LogEntry[] {
	return sizes.flatMap((size, n) => {
		const t = from + n;
		return [
			entry("u" + t, "user", "question " + t, { tokens: 20 }),
			entry("a" + t, "assistant", "reading " + t, { tokens: 30, toolCalls: [{ id: "c" + t, name: "read", args: { path: "src/f" + t + ".ts" } }] }),
			entry("t" + t, "tool", "result " + t, { tokens: size, toolName: "read" }),
			entry("r" + t, "assistant", "answer " + t, { tokens: 50 }),
		];
	});
}

const frameOf = (entries: LogEntry[], extra: Partial<CutFrame> = {}): CutFrame => {
	const visibleTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
	return {
		entries,
		minKeptIndex: 0,
		visibleFromIndex: 0,
		config: small,
		reason: "watermark",
		contextTokens: Math.round(visibleTokens * 1.25),
		visibleTokens,
		limit: small.watermarkTokens,
		hard: 2 * small.watermarkTokens,
		...extra,
	};
};

const keptIndexOf = (entries: LogEntry[], frame: CutFrame): number => {
	const decision = planCut(frame, roomy);
	assert.ok(decision.kind === "ready" || decision.kind === "defer");
	return entries.findIndex((e) => e.id === decision.plan.firstKeptEntryId);
};

describe("what the cap removes from the kept range", () => {
	// Baseline: keepRecentTokens 4000 is 2500 estimated; turns 9 to 11 (3300) are kept, the cap is 2812.
	const entries = turns(Array.from({ length: 12 }, () => 1_000));

	it("starts the capped range at the latest round start that fits, and names what goes", () => {
		const keptIndex = keptIndexOf(entries, frameOf(entries));
		assert.equal(entries[keptIndex]?.id, "u9");
		const removal = capRemoval(entries, keptIndex, cap);
		assert.equal(removal.kind, "remove");
		assert.ok(removal.kind === "remove");
		assert.equal(removal.cappedFromId, "u10");
		assert.deepEqual(removal.ids, ["u9", "a9", "t9", "r9"]);
		assert.equal(removal.tokens, 1_100);
		assert.equal(removal.keptTokens, 2_200);
		assert.equal(removal.baselineKeptTokens, 3_300);
		assert.deepEqual(removal.paths, ["src/f9.ts"]);
	});

	it("starts only at a user message, so a tool call is never parted from its result", () => {
		// A cap of 2300 fits turn 10 and the answer and result of turn 9, but neither of those opens a round.
		const keptIndex = keptIndexOf(entries, frameOf(entries));
		const removal = capRemoval(entries, keptIndex, 2_300);
		assert.ok(removal.kind === "remove");
		assert.equal(removal.cappedFromId, "u10");
		for (let i = 0; i < 40; i++) {
			const one = capRemoval(entries, 0, 1_200 + i * 97);
			if (one.kind !== "remove") continue;
			assert.equal(entries.find((e) => e.id === one.cappedFromId)?.kind, "user");
		}
	});

	it("defers a newest round larger than the cap instead of cutting inside it", () => {
		const huge = [...turns(Array.from({ length: 10 }, () => 1_000)), ...turns([5_000], 10)];
		const removal = capRemoval(huge, keptIndexOf(huge, frameOf(huge)), cap);
		assert.ok(removal.kind === "defer");
		assert.equal(removal.why, "atomic-tail");
		assert.equal(removal.keptTokens, 5_100);
	});

	it("leaves a range that fits alone", () => {
		const removal = capRemoval(entries, keptIndexOf(entries, frameOf(entries)), estimateBudget(40_000));
		assert.ok(removal.kind === "defer" && removal.why === "within-cap");
	});

	it("reads only as far from the newest entry as the cap reaches, however long the history", () => {
		const reads = (count: number): number => {
			const log = turns(Array.from({ length: count }, () => 1_000));
			let touched = 0;
			const watched = new Proxy(log, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) touched++;
					return Reflect.get(target, key, receiver);
				},
			});
			capRemoval(watched, log.length - 12, cap);
			return touched;
		};
		const short = reads(50);
		const long = reads(20_000);
		assert.equal(long, short, "the same number of entries read for 200 and for 80,000 entries");
		assert.ok(long < 40, "read " + long);
	});
});

describe("the capped plan", () => {
	/** The baseline is planned once by the caller and handed over, as the controller does. */
	const planned = (at: CutFrame, envelope: CutEnvelope, capTokens: number, decide?: boolean) => cappedPlan(at, envelope, capTokens, { baseline: planCut(at, envelope), ...(decide === undefined ? {} : { decide }) });
	const entries = turns(Array.from({ length: 12 }, () => 1_000));
	const frame = frameOf(entries);

	it("is a candidate cut from the capped start, with the baseline beside it", () => {
		const outcome = planned(frame, roomy, cap);
		assert.equal(outcome.kind, "candidate");
		assert.ok(outcome.kind === "candidate");
		assert.equal(outcome.baseline.kind, "ready");
		assert.deepEqual(outcome.baseline, planCut(frame, roomy));
		assert.ok(outcome.decision?.kind === "ready");
		assert.equal(outcome.decision.plan.firstKeptEntryId, "u10");
		assert.equal(outcome.decision.plan.details.keptFromId, "u10");
		assert.ok(outcome.baseline.kind === "ready");
		assert.ok(outcome.decision.plan.details.archivedEntries > outcome.baseline.plan.details.archivedEntries);
		assert.ok(outcome.decision.expected < outcome.baseline.expected, "the capped cut leaves less");
		assert.equal(outcome.removal.tokens, 1_100);
	});

	it("can reach a limit the baseline misses, and then is ready where the baseline defers", () => {
		const both = planned(frame, roomy, cap);
		assert.ok(both.kind === "candidate" && both.baseline.kind === "ready" && both.decision?.kind === "ready");
		assert.ok(both.decision.expected < both.baseline.expected);
		const limit = Math.round((both.baseline.expected + both.decision.expected) / 2);
		const tight = frameOf(entries, { limit });
		const outcome = planned(tight, roomy, cap);
		assert.ok(outcome.kind === "candidate");
		assert.equal(outcome.baseline.kind, "defer");
		assert.equal(outcome.decision?.kind, "ready");
		assert.equal(planCut(tight, roomy).kind, "defer", "the baseline is what planCut says");
	});

	it("defers, with the baseline unchanged, when the newest round exceeds the cap or the range fits", () => {
		const huge = [...turns(Array.from({ length: 10 }, () => 1_000)), ...turns([5_000], 10)];
		const atomic = planned(frameOf(huge), roomy, cap);
		assert.ok(atomic.kind === "deferral");
		assert.equal(atomic.why, "atomic-tail");
		assert.deepEqual(atomic.baseline, planCut(frameOf(huge), roomy));
		const fits = planned(frame, roomy, estimateBudget(40_000));
		assert.ok(fits.kind === "deferral" && fits.why === "within-cap");
		assert.deepEqual(fits.baseline, planCut(frame, roomy));
	});

	it("plans a shadow from the entries the baseline keeps alone, however long the history before them", () => {
		const touchedFor = (count: number, promoted?: ReadonlyMap<string, number>): number => {
			const log = turns(Array.from({ length: count }, () => 1_000));
			const plain = frameOf(log);
			const baseline = planCut(plain, roomy);
			let touched = 0;
			const watched = new Proxy(log, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) touched++;
					return Reflect.get(target, key, receiver);
				},
			});
			const outcome = cappedPlan({ ...plain, entries: watched, ...(promoted ? { promoted } : {}) }, roomy, cap, { baseline, decide: false });
			assert.ok(outcome.kind === "candidate" && outcome.decision === undefined, "a shadow plans no cut from the capped start");
			return touched;
		};
		for (const promoted of [undefined, new Map([["t9", 300]])]) {
			const short = touchedFor(60, promoted);
			const long = touchedFor(20_000, promoted);
			assert.equal(long, short, "the same number of entries read for 60 and for 20,000 entries");
			assert.ok(long < 80, "read " + long);
		}
	});

	it("does not plan the baseline again when it is handed over, and plans the cut from the capped start only when asked", () => {
		const baseline = planCut(frame, roomy);
		const asked = cappedPlan(frame, roomy, cap, { baseline });
		const own = cappedPlan(frame, roomy, cap);
		assert.deepEqual(asked, own, "the same plan whether the baseline is handed over or planned inside");
		const shadow = cappedPlan(frame, roomy, cap, { baseline, decide: false });
		assert.ok(shadow.kind === "candidate" && asked.kind === "candidate");
		assert.equal(shadow.decision, undefined);
		assert.deepEqual(shadow.removal, asked.removal, "the removal a shadow records is the one the cut would make");
	});

	it("defers as no-cut when the baseline has no cut to cap: nothing to archive, or no room below pi's limit", () => {
		for (const [log, envelope] of [
			[turns([1_000]), roomy],
			[entries, { ...roomy, fixedTokens: small.watermarkTokens * 10 }],
		] as const) {
			const outcome = planned(frameOf([...log]), envelope, cap);
			assert.ok(outcome.kind === "deferral" && outcome.why === "no-cut");
			assert.equal(outcome.baseline.kind, "disabled");
		}
	});
});

describe("the shadow record and its counters", () => {
	const entries = turns(Array.from({ length: 12 }, () => 1_000));
	const removal = capRemoval(entries, 0, estimateBudget(CAP_PROVIDER));
	assert.ok(removal.kind === "remove");
	const record = (extra = {}) => capShadowRecord({ mode: "shadow", applied: false, reason: "watermark", capTokens: CAP_PROVIDER, keptFromId: "u0", removal, promotions: 0, ...extra });
	const shadow = (data: unknown): RawEntry => ({ type: "custom", id: "s" + Math.random(), customType: CAP_SHADOW_KIND, data });
	const readOf = (call: string, id: string) => [toolCall(call, "history_read", { id: "#" + id }), toolResult(call, "history_read")];
	const fileOf = (call: string, path: string) => [toolCall(call, "read", { path }), toolResult(call, "read")];
	const report = (raw: RawEntry[]) => reduceCapShadow(retrievalEvents(raw));

	it("holds ids, counts and paths, never text", () => {
		const data = record();
		assert.ok(JSON.stringify(data).length < 600);
		assert.deepEqual(readCapShadowRecord(JSON.parse(JSON.stringify(data))), data);
		assert.equal(readCapShadowRecord({ ...data, entries: "many" }), undefined);
		assert.equal(readCapShadowRecord(null), undefined);
		assert.deepEqual(decodeContextRecord(shadow(data)), { kind: "cap-shadow", shadow: data });
	});

	it("caps the ids a record carries and says how many were left out", () => {
		const long = Array.from({ length: 900 }, (_, i) => "e" + i);
		const data = capShadowRecord({ mode: "shadow", applied: false, reason: "watermark", capTokens: 1, keptFromId: "u0", promotions: 0, removal: { ...removal, ids: long, entries: 900 } });
		assert.equal(data.ids?.length, 500);
		assert.equal(data.entries, 900);
	});

	it("counts what a cut would remove and which of it the agent asked for afterwards", () => {
		const raw: RawEntry[] = [
			...readOf("early", "t9"),
			shadow(record()),
			compaction({ ours: true }),
			...readOf("h1", "t9"),
			...readOf("h2", "t9"),
			...readOf("h3", "unrelated"),
			...fileOf("r1", "src/f9.ts"),
			...fileOf("r2", "src/other.ts"),
		];
		const r = report(raw);
		assert.equal(r.records, 1);
		assert.equal(r.removedEntries, 40);
		assert.equal(r.removedTokens, 11_000);
		assert.equal(r.neededEntries, 1, "the same entry asked for twice counts once, an earlier read not at all");
		assert.equal(r.neededFiles, 1);
		assert.equal(r.cutsWithNeed, 1);
	});

	it("counts a deferral and a cut nobody asked back", () => {
		const r = report([
			shadow(record()),
			shadow(capShadowRecord({ mode: "shadow", applied: false, reason: "cold", capTokens: CAP_PROVIDER, keptFromId: "u3", deferral: "atomic-tail", promotions: 0 })),
			shadow(capShadowRecord({ mode: "shadow", applied: false, reason: "task", capTokens: CAP_PROVIDER, keptFromId: "u5", deferral: "within-cap", promotions: 0 })),
		]);
		assert.deepEqual(
			{ records: r.records, cutsWithNeed: r.cutsWithNeed, atomic: r.deferred.atomicTail, within: r.deferred.withinCap, removed: r.removedEntries },
			{ records: 3, cutsWithNeed: 0, atomic: 1, within: 1, removed: 40 },
		);
	});

	it("counts a read on the branch that holds the record, not on a sibling branch, and a prefix the archive resolved", () => {
		const at = (parts: RawEntry[], id: string, parentId: string | null): RawEntry[] => parts.map((one, i) => ({ ...one, id: i === 0 ? id : id + "." + i, parentId: i === 0 ? parentId : i === 1 ? id : id + "." + (i - 1) }));
		const failed = (one: RawEntry): RawEntry => ({ ...one, message: { ...(one as unknown as { message: object }).message, isError: true } });
		const lookup = (call: string, typed: string, resolved: string, ok = true): RawEntry[] => [
			toolCall(call, "history_read", { id: typed }),
			ok ? toolResult(call, "history_read", { id: resolved }) : failed(toolResult(call, "history_read")),
		];
		const ids = ["t9", "t8"];
		const withIds = capShadowRecord({ mode: "shadow", applied: false, reason: "watermark", capTokens: CAP_PROVIDER, keptFromId: "u0", removal: { ...removal, ids, entries: 2 }, promotions: 0 });
		const raw: RawEntry[] = [
			{ type: "message", id: "m0", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ ...shadow(withIds), id: "s1", parentId: "m0" },
			...at(lookup("a", "#t9fe", "t9"), "a1", "s1"),
			...at(lookup("b", "#t8", "t8"), "b1", "m0"),
			...at(lookup("c", "#t8", "t8", false), "c1", "s1"),
		];
		const r = report(raw);
		assert.equal(r.neededEntries, 1, "the prefix resolved to t9 counts; the read on the sibling branch does not");
		assert.equal(r.cutsWithNeed, 1);
		assert.equal(r.failedReads, 1, "a failed read of a removed entry is counted apart");
		assert.ok(formatCapShadowReport(r).join("\n").includes("1 failed reads not counted"));
	});

	it("starts over for a new session and ignores a record it cannot read", () => {
		const r = report([shadow(record()), shadow({ junk: true })]);
		assert.equal(r.records, 1);
		assert.ok(formatCapShadowReport(r).join("\n").includes("Kept cap"));
		assert.deepEqual(formatCapShadowReport(report([])), ["Kept cap: no record in this session"]);
	});
});

describe("the cap in the configuration", () => {
	it("defaults to shadow with a cap above keepRecentTokens", () => {
		const config = resolveConfig();
		assert.equal(config.keptCap.mode, "shadow");
		assert.ok(config.keptCap.tokens >= config.keepRecentTokens);
	});

	it("is read strictly", () => {
		assert.deepEqual(parseConfig({ keptCap: { mode: "off", tokens: 30_000 } }), resolveConfig({ keptCap: { mode: "off", tokens: 30_000 } }));
		for (const bad of [{ mode: "always" }, { mode: 1 }, { tokens: "big" }, { other: 1 }, "on"]) {
			const result = parseConfig({ keptCap: bad });
			assert.ok("configErrors" in result, JSON.stringify(bad));
		}
	});

	it("refuses a cap below what a cut keeps anyway", () => {
		const result = parseConfig({ keepRecentTokens: 16_000, keptCap: { tokens: 8_000 } });
		assert.ok("configErrors" in result);
		assert.match(result.configErrors.join("\n"), /keptCap\.tokens .* keepRecentTokens/);
	});
});

describe("the probe record that gates the cap", () => {
	const expected = probeExpectation();
	const verdict = (raw: unknown) => validateProbeRecord(raw, expected);
	const worse = (change: (record: ProbeRecord) => void): ProbeRecord => {
		const record = structuredClone(passingProbe());
		change(record);
		return record;
	};

	it("accepts a complete record for this cap that passes the frozen thresholds", () => {
		assert.deepEqual(verdict(passingProbe()), { ok: true });
	});

	it("reports a missing record", () => {
		for (const raw of [undefined, null]) {
			const result = verdict(raw);
			assert.ok(!result.ok && result.kind === "missing");
		}
	});

	it("reports an unreadable record as malformed", () => {
		for (const raw of ["passed", 3, {}, { ...passingProbe(), snapshots: "all" }, worse((r) => void (r.savedShare = Number.NaN)), worse((r) => void (r.snapshots[0]!.capped.passed = 12))]) {
			const result = verdict(raw);
			assert.ok(!result.ok && result.kind === "malformed", JSON.stringify(result));
		}
	});

	it("reports a record that names no model as malformed and one made for another model as mismatched", () => {
		const { model: _model, ...unnamed } = passingProbe();
		for (const raw of [unnamed, worse((r) => void (r.model = "no-slash")), worse((r) => void ((r as { model: unknown }).model = 7))]) {
			const result = verdict(raw);
			assert.ok(!result.ok && result.kind === "malformed", JSON.stringify(result));
		}
		const forModel = (model: string) => validateProbeRecord(passingProbe(), probeExpectation(undefined, model));
		assert.deepEqual(forModel(PROBED_MODEL), { ok: true });
		const other = forModel("entirely-other-provider/entirely-other-model");
		assert.ok(!other.ok && other.kind === "mismatch" && other.reason.includes("model"), JSON.stringify(other));
	});

	it("reports a record made for another cap, suite, thresholds or design as mismatched", () => {
		const cases: [string, ProbeRecord][] = [
			["cap.tokens", worse((r) => void (r.cap.tokens += 1_000))],
			["cap.keepRecentTokens", worse((r) => void (r.cap.keepRecentTokens += 1_000))],
			["suite", worse((r) => void (r.suite = "0000000000000000"))],
			["thresholds", worse((r) => void (r.thresholds = "0000000000000000"))],
			["design", worse((r) => void (r.design.repeats = 1))],
			["snapshots", worse((r) => void (r.snapshots[3]!.id = "not-in-the-suite"))],
			["snapshots", worse((r) => void r.snapshots.pop())],
		];
		for (const [field, record] of cases) {
			const result = verdict(record);
			assert.ok(!result.ok && result.kind === "mismatch", field + " " + JSON.stringify(result));
			assert.ok(!result.ok && result.reason.includes(field), result.ok ? "" : result.reason);
		}
	});

	it("reports a record whose numbers miss a threshold as failed, whatever its own verdict says", () => {
		const cases: [string, ProbeRecord][] = [
			["success", worse((r) => void r.snapshots.forEach((s, i) => (s.capped.passed = i < 12 ? s.baseline.passed - 2 : s.baseline.passed)))],
			["reads", worse((r) => void r.snapshots.forEach((s) => (s.capped.reads = s.baseline.reads + 4)))],
			["worst snapshot", worse((r) => void (r.snapshots[5]!.capped.passed = 0, r.snapshots[5]!.baseline.passed = 9))],
			["saving", worse((r) => void (r.savedShare = PROBE_THRESHOLDS.minSavedShare / 2))],
		];
		for (const [name, record] of cases) {
			assert.equal(record.passed, true, "the record claims to have passed");
			const result = verdict(record);
			assert.ok(!result.ok && result.kind === "failed", name + " " + JSON.stringify(result));
		}
		const claimed = verdict(worse((r) => void (r.passed = false)));
		assert.ok(!claimed.ok && claimed.kind === "malformed", "a verdict that contradicts its numbers is not trusted");
	});
});

describe("the frozen 24-snapshot suite", () => {
	const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { suite: string; snapshots: { id: string; file: string; digest: string }[] };

	it("has 24 snapshots whose digests are the ones the probe record names", () => {
		assert.equal(manifest.snapshots.length, PROBE_DESIGN.snapshots);
		assert.equal(readdirSync(FIXTURES).filter((f) => f !== "manifest.json").length, PROBE_DESIGN.snapshots);
		assert.equal(manifest.suite, KEPT_CAP_SUITE_DIGEST);
		assert.equal(suiteDigest(manifest.snapshots), KEPT_CAP_SUITE_DIGEST);
		for (const one of manifest.snapshots) {
			assert.equal(one.digest, digestText(readFileSync(join(FIXTURES, one.file), "utf8")), one.file + " changed after the suite was frozen");
		}
	});

	it("has thresholds that were frozen before any run", () => {
		assert.equal(PROBE_THRESHOLDS_DIGEST, thresholdsDigest(PROBE_THRESHOLDS));
		assert.deepEqual(PROBE_DESIGN, { snapshots: 24, continuations: 3, repeats: 3, arms: 2 });
	});
});

describe("the offline replay", () => {
	const tool = join(here, "..", "tools", "probe-kept-cap.ts");
	const run = (...args: string[]) => spawnSync("node", ["--experimental-strip-types", "--no-warnings", tool, ...args], { encoding: "utf8", env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });

	it("replays all 24 snapshots without a network and prints the layout of the report", () => {
		const result = run("--offline", FIXTURES);
		assert.equal(result.status, 0, result.stderr);
		const lines = result.stdout.trim().split("\n");
		assert.ok(lines.some((line) => line.startsWith("snapshot ")), "a header");
		assert.equal(lines.filter((line) => /^\s*s\d\d /.test(line)).length, 24);
		assert.match(result.stdout, /24 snapshots: \d+ would lose range, \d+ within the cap, \d+ deferred as atomic tail/);
		assert.match(result.stdout, /needed after masking \(synthetic later reads, not measured retrieval\): \d+ of \d+ removed entries/);
		assert.equal(result.stdout, run("--offline", FIXTURES).stdout, "the same fixtures give the same report");
	});

	it("says where the numbers are shown that the later reads are synthetic, not measured retrieval", () => {
		const result = run("--offline", FIXTURES);
		const lines = result.stdout.trim().split("\n");
		assert.match(lines[0] ?? "", /Synthetic fixtures/, "before the table");
		assert.match(lines.find((line) => line.startsWith("needed after masking")) ?? "", /synthetic later reads, not measured retrieval/, "on the aggregate line");
		assert.match(lines.at(-1) ?? "", /synthetic fixtures only/i, "on the footer");
	});

	it("does not run a paid probe, and says so", () => {
		const result = run(FIXTURES);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /--offline/);
		assert.match(result.stderr, /#16/);
	});

	it("rejects a directory that is not the frozen suite", () => {
		const result = run("--offline", here);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /manifest/);
	});
});
