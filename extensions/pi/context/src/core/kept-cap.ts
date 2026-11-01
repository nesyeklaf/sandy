/**
 * The kept-history cap: a bound on the history a cut keeps verbatim. A cut keeps about keepRecentTokens, and a
 * lookup for the start of the turn can overshoot; the cap takes the overshoot out by moving the start of the kept
 * range forward to the oldest user message from which the history still fits. In "shadow" the cap only plans: it
 * records what it would remove and the reducer counts what the agent asked for afterwards. Nothing is sent
 * differently. The effect on answer quality is unproven; mode "on" needs a passing probe record (kept-cap-probe.ts).
 *
 * Pure: {@link capRemoval} reads from the newest entry back and stops at the start of the baseline's kept range, so a
 * long history costs nothing; {@link reduceCapShadow} counts retrieval events along each branch.
 */
import type { CapDeferral, CapShadowRecord } from "./cap-record.ts";
import { type RetrievalEvent, walkBranches } from "./retrieval.ts";
import type { LogEntry } from "./types.ts";

export const CAP_MODES = ["off", "shadow", "on"] as const;
export type CapMode = (typeof CAP_MODES)[number];

/** Tools whose path argument names a file the removed history read. */
const READ_TOOL = "read";

export type CapRemoval =
	| {
			readonly kind: "remove";
			/** The user message the capped range starts at. */
			readonly cappedFromId: string;
			/** The entries between the baseline's start and the capped start, oldest first. */
			readonly ids: readonly string[];
			readonly entries: number;
			readonly tokens: number;
			/** Estimated tokens the capped range keeps, and the baseline range kept. */
			readonly keptTokens: number;
			readonly baselineKeptTokens: number;
			readonly paths: readonly string[];
	  }
	| { readonly kind: "defer"; readonly why: CapDeferral; readonly keptTokens: number };

/** The path a read of an assistant entry names. */
function readPaths(entry: LogEntry): string[] {
	return entry.toolCalls.flatMap((call) => {
		const args = call.args as { path?: unknown } | null;
		return call.name === READ_TOOL && typeof args?.path === "string" ? [args.path] : [];
	});
}

/**
 * What the cap takes out of the range a cut keeps from `keptIndex` on, for a cap of `cap` estimated tokens. The
 * capped range starts at a user message, so a tool call is never parted from its result and a round is never cut in
 * the middle. It defers when the range fits (`within-cap`) and when even the newest round is larger than the cap
 * (`atomic-tail`): the baseline cut stands then. Entries are read by index from the newest back to `keptIndex` and
 * nothing before it.
 */
export function capRemoval(entries: readonly LogEntry[], keptIndex: number, cap: number): CapRemoval {
	let total = 0;
	let cappedAt = -1;
	for (let i = entries.length - 1; i >= keptIndex; i--) {
		const entry = entries[i] as LogEntry;
		total += entry.tokens;
		if (total <= cap && entry.kind === "user") cappedAt = i;
	}
	if (total <= cap) return { kind: "defer", why: "within-cap", keptTokens: total };
	if (cappedAt <= keptIndex) return { kind: "defer", why: "atomic-tail", keptTokens: total };
	const ids: string[] = [];
	const paths = new Set<string>();
	let tokens = 0;
	for (let i = keptIndex; i < cappedAt; i++) {
		const entry = entries[i] as LogEntry;
		ids.push(entry.id);
		tokens += entry.tokens;
		for (const path of readPaths(entry)) paths.add(path);
	}
	return {
		kind: "remove",
		cappedFromId: (entries[cappedAt] as LogEntry).id,
		ids,
		entries: ids.length,
		tokens,
		keptTokens: total - tokens,
		baselineKeptTokens: total,
		paths: [...paths],
	};
}

/** What the shadow records of a session add up to, and how much of the removed history was asked for afterwards. */
export interface CapShadowReport {
	readonly records: number;
	readonly removedEntries: number;
	readonly removedTokens: number;
	/** Removed entries the agent opened with history_read after the cut that removed them, each counted once. */
	readonly neededEntries: number;
	/** Files the removed entries read that the agent read again afterwards, each counted once per cut. */
	readonly neededFiles: number;
	/** Cuts after which at least one removed entry or file was asked for. */
	readonly cutsWithNeed: number;
	/** Attempts to open a removed entry or file that failed: not counted as need. */
	readonly failedReads: number;
	readonly deferred: { readonly atomicTail: number; readonly withinCap: number };
}

/**
 * Counts the shadow records and what followed each: the reads after a record on its branch, before the next record on
 * that branch. It reads the events as {@link reduceRetrieval} does, along every branch with its own state, so a read on
 * one branch is no need of a record on another, and in time linear in the events. A read before the cut, of an entry
 * the cap would not have removed, or that failed (counted apart) is no need. An entry read counts for the entry the
 * archive resolved; a result that names none leaves the count a lower bound.
 */
export function reduceCapShadow(events: readonly RetrievalEvent[]): CapShadowReport {
	let removedEntries = 0;
	let removedTokens = 0;
	let failedReads = 0;
	const deferred = { atomicTail: 0, withinCap: 0 };
	type Window = { ids: Set<string>; paths: Set<string>; askedIds: Set<string>; askedPaths: Set<string> };
	const windows: Window[] = [];
	let window: Window | undefined;
	const undo: (() => void)[] = [];
	walkBranches(
		events,
		undo,
		() => {},
		(event) => {
			if (event.kind === "shadow") {
				const record: CapShadowRecord = event.record;
				removedEntries += record.entries;
				removedTokens += record.tokens;
				if (record.deferral === "atomic-tail") deferred.atomicTail++;
				if (record.deferral === "within-cap") deferred.withinCap++;
				const before = window;
				window = { ids: new Set(record.ids ?? []), paths: new Set(record.paths ?? []), askedIds: new Set(), askedPaths: new Set() };
				windows.push(window);
				undo.push(() => (window = before));
			} else if ((event.kind === "read" || event.kind === "file") && event.ok === false) {
				if (event.kind === "read" ? window?.ids.has(event.entryId) : window?.paths.has(event.path)) failedReads++;
			} else if (event.kind === "read" && window?.ids.has(event.entryId)) window.askedIds.add(event.entryId);
			else if (event.kind === "file" && window?.paths.has(event.path)) window.askedPaths.add(event.path);
		},
	);
	return {
		records: windows.length,
		removedEntries,
		removedTokens,
		neededEntries: windows.reduce((total, one) => total + one.askedIds.size, 0),
		neededFiles: windows.reduce((total, one) => total + one.askedPaths.size, 0),
		cutsWithNeed: windows.filter((one) => one.askedIds.size + one.askedPaths.size > 0).length,
		failedReads,
		deferred,
	};
}

/** The report as lines for `/context` and `npm run measure`. */
export function formatCapShadowReport(report: CapShadowReport): string[] {
	if (report.records === 0) return ["Kept cap: no record in this session"];
	return [
		`Kept cap: ${report.records} cuts planned with the cap; it would remove ${report.removedEntries.toLocaleString("en-US")} entries (an estimated ${report.removedTokens.toLocaleString("en-US")} tokens) from the kept range; ` +
			`deferred ${report.deferred.atomicTail} as atomic tail and ${report.deferred.withinCap} within the cap`,
		`Kept cap, needed after masking (a lower bound): ${report.neededEntries} removed entries opened again, ${report.neededFiles} removed files read again, after ${report.cutsWithNeed} of ${report.records} cuts${report.failedReads > 0 ? `; ${report.failedReads} failed reads not counted` : ""}`,
	];
}
