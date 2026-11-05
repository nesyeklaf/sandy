/**
 * The gate for the kept-history cap's mode "on". The cap's effect on answer quality is unproven: the paid probe
 * (backlog #16) replays 24 frozen snapshots, 3 continuations each, 3 repeats, with and without the cap, and writes a
 * probe record. Mode "on" starts only when that record names this cap, this suite and these thresholds, and its numbers
 * pass them. The thresholds below are frozen here, before any run, and their digest is part of the record, so a run
 * cannot be judged by thresholds chosen afterwards. Changing a threshold changes the digest and invalidates every
 * earlier record.
 *
 * Pure: validation reads a parsed record, never a file.
 */
import { createHash } from "node:crypto";
import type { ContextConfig } from "./config.ts";

export function digestText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The frozen pass criteria. Success is the number of 9 runs (3 continuations x 3 repeats) that answered right. */
export const PROBE_THRESHOLDS = {
	/** Mean over the snapshots of capped successes may fall at most this far below the mean of baseline successes, out of 9 runs / 9. */
	maxSuccessDrop: 0.03,
	/** Mean extra history reads per run (reads over the 9 runs of a snapshot, divided by 9) the cap may cost. */
	maxExtraReads: 0.25,
	/** A snapshot where the baseline answered at least this often (of 9) must not have the cap answer never. */
	worstBaselineMin: 6,
	/** The cap must save at least this share of the kept tokens over the suite, or it is not worth its risk. */
	minSavedShare: 0.03,
} as const;

export type ProbeThresholds = typeof PROBE_THRESHOLDS;

export function thresholdsDigest(thresholds: ProbeThresholds): string {
	return digestText(JSON.stringify(thresholds, Object.keys(thresholds).sort()));
}
export const PROBE_THRESHOLDS_DIGEST = thresholdsDigest(PROBE_THRESHOLDS);

/** The frozen design: snapshots, continuations per snapshot, repeats per continuation, arms (baseline, capped). */
export const PROBE_DESIGN = { snapshots: 24, continuations: 3, repeats: 3, arms: 2 } as const;
export type ProbeDesign = { snapshots: number; continuations: number; repeats: number; arms: number };

/** Ids of the 24 snapshots of the suite, in order. */
export const KEPT_CAP_SNAPSHOT_IDS: readonly string[] = Array.from({ length: PROBE_DESIGN.snapshots }, (_, i) => `s${String(i + 1).padStart(2, "0")}`);

/** Digest of the frozen suite: its snapshots' ids and file digests, in id order. */
export function suiteDigest(snapshots: readonly { readonly id: string; readonly digest: string }[]): string {
	return digestText([...snapshots].sort((a, b) => a.id.localeCompare(b.id)).map((one) => `${one.id}=${one.digest}`).join("\n"));
}

/** Set by tools/make-kept-cap-fixtures.ts when the suite is generated; a test checks the committed fixtures against it. */
export const KEPT_CAP_SUITE_DIGEST = "b7532c295030fd43";

export interface ProbeArm {
	/** Runs out of 9 that answered right. */
	passed: number;
	/** History reads (history_read, history_search, repeat file reads) across the 9 runs. */
	reads: number;
}

export interface ProbeRecord {
	version: 1;
	passed: boolean;
	/** The model the continuations ran on, as `provider/id`: whether the cap keeps answers right is a fact about one model. */
	model: string;
	cap: { tokens: number; keepRecentTokens: number };
	suite: string;
	thresholds: string;
	design: ProbeDesign;
	snapshots: { id: string; baseline: ProbeArm; capped: ProbeArm }[];
	/** Share of the baseline's kept tokens the cap removed, over the suite. */
	savedShare: number;
}

export interface ProbeExpectation {
	/** The session model, as `provider/id`. Undefined before the session has one: the record must still name a model. */
	readonly model?: string;
	readonly cap: { readonly tokens: number; readonly keepRecentTokens: number };
	readonly suite: string;
	readonly thresholds: string;
	readonly design: ProbeDesign;
	readonly ids: readonly string[];
}

export function expectedProbe(config: ContextConfig, model?: string): ProbeExpectation {
	return {
		...(model !== undefined ? { model } : {}),
		cap: { tokens: config.keptCap.tokens, keepRecentTokens: config.keepRecentTokens },
		suite: KEPT_CAP_SUITE_DIGEST,
		thresholds: PROBE_THRESHOLDS_DIGEST,
		design: { ...PROBE_DESIGN },
		ids: KEPT_CAP_SNAPSHOT_IDS,
	};
}

export type ProbeVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly kind: "missing" | "malformed" | "mismatch" | "failed"; readonly reason: string };

const bad = (kind: "missing" | "malformed" | "mismatch" | "failed", reason: string): ProbeVerdict => ({ ok: false, kind, reason });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isArm = (value: unknown): value is ProbeArm =>
	isObject(value) && Number.isInteger(value.passed) && (value.passed as number) >= 0 && (value.passed as number) <= PROBE_DESIGN.continuations * PROBE_DESIGN.repeats && typeof value.reads === "number" && Number.isFinite(value.reads) && value.reads >= 0;

/** The numbers against the frozen thresholds: the reason it fails, none when it passes. */
export function probeShortfall(record: Pick<ProbeRecord, "snapshots" | "savedShare">): string | undefined {
	const runs = PROBE_DESIGN.continuations * PROBE_DESIGN.repeats;
	const n = record.snapshots.length;
	const mean = (pick: (s: ProbeRecord["snapshots"][number]) => number) => record.snapshots.reduce((sum, s) => sum + pick(s), 0) / n;
	const drop = (mean((s) => s.baseline.passed) - mean((s) => s.capped.passed)) / runs;
	if (drop > PROBE_THRESHOLDS.maxSuccessDrop) return `success: the cap answers ${(drop * 100).toFixed(1)} points less often than the baseline, the limit is ${PROBE_THRESHOLDS.maxSuccessDrop * 100}`;
	const extra = (mean((s) => s.capped.reads) - mean((s) => s.baseline.reads)) / runs;
	if (extra > PROBE_THRESHOLDS.maxExtraReads) return `reads: ${extra.toFixed(2)} more reads per continuation, the limit is ${PROBE_THRESHOLDS.maxExtraReads}`;
	const worst = record.snapshots.find((s) => s.capped.passed === 0 && s.baseline.passed >= PROBE_THRESHOLDS.worstBaselineMin);
	if (worst) return `worst snapshot ${worst.id}: the cap never answers where the baseline did ${worst.baseline.passed} of ${runs} times`;
	if (record.savedShare < PROBE_THRESHOLDS.minSavedShare) return `saving: ${record.savedShare} of the kept tokens, the minimum is ${PROBE_THRESHOLDS.minSavedShare}`;
	return undefined;
}

/**
 * Whether a probe record lets mode "on" start for this configuration. Checked in order: missing, malformed (unreadable,
 * or a verdict its own numbers contradict), mismatch (another model, cap, suite, thresholds or design: the evidence
 * is about something else), failed (the numbers miss a threshold, whatever the record claims).
 */
export function validateProbeRecord(raw: unknown, expected: ProbeExpectation): ProbeVerdict {
	if (raw === undefined || raw === null) return bad("missing", "no probe record");
	if (!isObject(raw)) return bad("malformed", "the probe record is not an object");
	const { cap, design, snapshots } = raw;
	if (raw.version !== 1) return bad("malformed", "version must be 1");
	if (typeof raw.passed !== "boolean") return bad("malformed", "passed must be true or false");
	if (!isObject(cap) || typeof cap.tokens !== "number" || typeof cap.keepRecentTokens !== "number") return bad("malformed", "cap must hold tokens and keepRecentTokens");
	if (typeof raw.model !== "string" || !/^[^/\s]+\/\S+$/.test(raw.model)) return bad("malformed", "model must be provider/id");
	if (typeof raw.suite !== "string" || typeof raw.thresholds !== "string") return bad("malformed", "suite and thresholds must be digests");
	if (!isObject(design) || ![design.snapshots, design.continuations, design.repeats, design.arms].every(Number.isInteger)) return bad("malformed", "design must hold counts");
	if (typeof raw.savedShare !== "number" || !Number.isFinite(raw.savedShare)) return bad("malformed", "savedShare must be a number");
	if (!Array.isArray(snapshots) || !snapshots.every((s) => isObject(s) && typeof s.id === "string" && isArm(s.baseline) && isArm(s.capped))) return bad("malformed", "snapshots must each hold an id and baseline and capped counts of 0 to 9");
	const record = raw as unknown as ProbeRecord;
	if (expected.model !== undefined && record.model !== expected.model) return bad("mismatch", `model is ${record.model}, the session model is ${expected.model}`);
	if (record.cap.tokens !== expected.cap.tokens) return bad("mismatch", `cap.tokens is ${record.cap.tokens}, this configuration has ${expected.cap.tokens}`);
	if (record.cap.keepRecentTokens !== expected.cap.keepRecentTokens) return bad("mismatch", `cap.keepRecentTokens is ${record.cap.keepRecentTokens}, this configuration has ${expected.cap.keepRecentTokens}`);
	if (record.suite !== expected.suite) return bad("mismatch", `suite is ${record.suite}, the frozen suite is ${expected.suite}`);
	if (record.thresholds !== expected.thresholds) return bad("mismatch", `thresholds is ${record.thresholds}, the frozen thresholds are ${expected.thresholds}`);
	for (const key of Object.keys(expected.design) as (keyof ProbeDesign)[]) {
		if (record.design[key] !== expected.design[key]) return bad("mismatch", `design.${key} is ${record.design[key]}, the frozen design has ${expected.design[key]}`);
	}
	const ids = record.snapshots.map((s) => s.id);
	if (ids.length !== expected.ids.length || expected.ids.some((id, i) => ids[i] !== id)) return bad("mismatch", "snapshots are not the 24 snapshots of the frozen suite, in order");
	const shortfall = probeShortfall(record);
	if (shortfall === undefined && !record.passed) return bad("malformed", "the record says it failed, but its numbers pass every threshold");
	if (shortfall !== undefined) return bad("failed", shortfall);
	return { ok: true };
}
