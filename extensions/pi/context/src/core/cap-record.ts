import type { CapRemoval } from "./kept-cap.ts";

/** How many removed ids and paths a record names; the counts say the rest. */
export const CAP_RECORD_IDS = 500;
export const CAP_RECORD_PATHS = 50;

export const CAP_MODES_RECORDED = ["shadow", "on"] as const;
export type CapModeRecorded = (typeof CAP_MODES_RECORDED)[number];
export type CapDeferral = "within-cap" | "atomic-tail";

/**
 * What the kept-history cap would remove at one cut, stored under `CAP_SHADOW_KIND` beside the cut. Ids, paths and
 * counts only: the log is the record and a record holds no content. `applied` says whether the cut used the capped
 * start (mode "on") or only planned it (mode "shadow").
 */
export interface CapShadowRecord {
	readonly mode: CapModeRecorded;
	readonly applied: boolean;
	readonly reason: string;
	/** The cap in the provider's tokens. */
	readonly cap: number;
	/** The entry the baseline cut keeps from. */
	readonly cutKeptId: string;
	/** The entry the capped cut keeps from; none when the cap deferred. */
	readonly cappedFromId?: string;
	/** Entries and estimated tokens the cap takes out of the kept range. */
	readonly entries: number;
	readonly tokens: number;
	/** The removed entries, at most {@link CAP_RECORD_IDS}. */
	readonly ids?: readonly string[];
	/** The files the removed entries read, at most {@link CAP_RECORD_PATHS}. */
	readonly paths?: readonly string[];
	readonly deferral?: CapDeferral;
	/** Notes that get their full text back because the cap took away the read they point at. */
	readonly promotions: number;
}

export interface CapShadowInput {
	readonly mode: CapModeRecorded;
	readonly applied: boolean;
	readonly reason: string;
	readonly capTokens: number;
	readonly keptFromId: string;
	readonly removal?: CapRemoval;
	readonly deferral?: CapDeferral;
	readonly promotions: number;
}

export function capShadowRecord(input: CapShadowInput): CapShadowRecord {
	const { removal } = input;
	const removed = removal?.kind === "remove" ? removal : undefined;
	return {
		mode: input.mode,
		applied: input.applied,
		reason: input.reason,
		cap: input.capTokens,
		cutKeptId: input.keptFromId,
		...(removed ? { cappedFromId: removed.cappedFromId } : {}),
		entries: removed?.entries ?? 0,
		tokens: removed?.tokens ?? 0,
		...(removed ? { ids: removed.ids.slice(0, CAP_RECORD_IDS), paths: removed.paths.slice(0, CAP_RECORD_PATHS) } : {}),
		...(input.deferral ? { deferral: input.deferral } : {}),
		promotions: input.promotions,
	};
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function readCapShadowRecord(value: unknown): CapShadowRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	if (!CAP_MODES_RECORDED.includes(r.mode as CapModeRecorded) || typeof r.applied !== "boolean") return undefined;
	if (typeof r.reason !== "string" || typeof r.cutKeptId !== "string" || !isCount(r.cap)) return undefined;
	if (!isCount(r.entries) || !isCount(r.tokens) || !isCount(r.promotions)) return undefined;
	if (r.cappedFromId !== undefined && typeof r.cappedFromId !== "string") return undefined;
	if (r.ids !== undefined && !isStrings(r.ids)) return undefined;
	if (r.paths !== undefined && !isStrings(r.paths)) return undefined;
	if (r.deferral !== undefined && r.deferral !== "within-cap" && r.deferral !== "atomic-tail") return undefined;
	return {
		mode: r.mode as CapModeRecorded,
		applied: r.applied,
		reason: r.reason,
		cap: r.cap,
		cutKeptId: r.cutKeptId,
		...(r.cappedFromId !== undefined ? { cappedFromId: r.cappedFromId } : {}),
		entries: r.entries,
		tokens: r.tokens,
		...(r.ids !== undefined ? { ids: r.ids } : {}),
		...(r.paths !== undefined ? { paths: r.paths } : {}),
		...(r.deferral !== undefined ? { deferral: r.deferral } : {}),
		promotions: r.promotions,
	};
}
