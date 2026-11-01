import { readUsageFigures, type UsageFigures } from "./attempts.ts";

/**
 * The records of a keep-warm side request, stored under `KEEP_WARM_KIND`. The request is a receipt before it leaves
 * (`start`) and its usage after (`end`); a start without an end is a request of unknown cost, as an attempt is. Both
 * carry `at`, the epoch ms the request started: the provider's cache counts its lifetime from there. Ids, times and
 * figures only, no content.
 */
export type WarmRecord =
	| { readonly type: "start"; readonly id: string; readonly at: number; readonly model?: string }
	| { readonly type: "end"; readonly id: string; readonly at: number; readonly outcome: WarmOutcome; readonly usage?: UsageFigures };

/** How a side request ended: `warmed` read the cache, `missed` did not (the cache had expired), the others sent but got no answer. */
export type WarmOutcome = "warmed" | "missed" | "failed" | "aborted";

const OUTCOMES: readonly unknown[] = ["warmed", "missed", "failed", "aborted"];

export function readWarmRecord(value: unknown): WarmRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined;
	if (record.type === "start") return { type: "start", id: record.id, at: record.at, ...(typeof record.model === "string" ? { model: record.model } : {}) };
	if (record.type !== "end" || !OUTCOMES.includes(record.outcome)) return undefined;
	const usage = readUsageFigures(record.usage);
	return { type: "end", id: record.id, at: record.at, outcome: record.outcome as WarmOutcome, ...(usage ? { usage } : {}) };
}

/** What the session's keep-warm records say about the cache window that began at `since`. */
export interface WarmWindow {
	/** Start of the newest request that read the cache: later pings count from there. */
	readonly warmedAt?: number;
	/** A request after the last warm left and has no usable answer on record (failed, aborted, or no end): it is not sent again. */
	readonly tried: boolean;
	/** The cache had expired when a ping asked: pings stop for the session. */
	readonly missed: boolean;
}

/** Folds the records of every process on the session: only requests that started after `since` belong to the window. */
export function warmWindow(records: Iterable<WarmRecord>, since: number): WarmWindow {
	const started = new Map<string, number>();
	const ended = new Map<string, WarmOutcome>();
	for (const record of records) {
		if (record.type === "start") started.set(record.id, record.at);
		else ended.set(record.id, record.outcome);
	}
	let warmedAt: number | undefined;
	for (const [id, at] of started) if (at > since && ended.get(id) === "warmed") warmedAt = Math.max(warmedAt ?? at, at);
	// A request that did not read the cache only matters if no later one did.
	let tried = false;
	let missed = false;
	for (const [id, at] of started) {
		if (at <= Math.max(since, warmedAt ?? since) || ended.get(id) === "warmed") continue;
		tried = true;
		if (ended.get(id) === "missed") missed = true;
	}
	return { ...(warmedAt !== undefined ? { warmedAt } : {}), tried, missed };
}
