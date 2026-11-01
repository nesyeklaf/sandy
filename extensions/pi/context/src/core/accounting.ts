/**
 * The cost report: what a session paid, from its log alone. Every model request that left is one event, known (with
 * its usage) or unknown (it left, nothing says what it used). The report adds the known ones, counts the unknown
 * ones and never turns an unknown into zero: while one exists the bill is incomplete and has no total.
 *
 * Costs are catalogue prices (the model's price list times the tokens), not what a provider billed.
 *
 * Pure: `accountingEvents` reads session entries as pi stores them, `reduceAccounting` adds events. The runtime's
 * `/context` and the offline `npm run measure` share both.
 */
import { type AttemptEntry, normalizeUsage, type UsageFigures } from "./attempts.ts";
import { liveAliases } from "./duplicates.ts";
import { decodeContextRecord, type SummaryRequest } from "./records.ts";
import type { WarmRecord } from "./warm-record.ts";
import type { RawEntry } from "./session-entries.ts";

export type { UsageFigures } from "./attempts.ts";
export type { RawEntry } from "./session-entries.ts";

/** Who sent the request. */
export type CostSource =
	| "main"
	| "historian"
	| "condenser"
	| "keep-warm"
	| "native-warm"
	| "compaction"
	| "branch-summary"
	| "tool"
	| "other";

export const COST_SOURCES: readonly CostSource[] = ["main", "historian", "condenser", "keep-warm", "native-warm", "compaction", "branch-summary", "tool", "other"];

/** Whether pi's own session statistics count the charge too, or only this engine's records tell of it. */
export type CountedBy = "pi" | "engine";

export type AccountingEvent =
	/** A request with its usage. */
	| { readonly kind: "charge"; readonly id: string; readonly source: CostSource; readonly counted: CountedBy; readonly usage: UsageFigures }
	/** A request that left and left no usage: it cost something of unknown size. */
	| { readonly kind: "unknown"; readonly id: string; readonly source: CostSource; readonly why: string }
	/** A request that was decided against and never left. Costs nothing, and is not a request. */
	| { readonly kind: "skip"; readonly id: string; readonly why: "policy" | "veto" }
	/** A repeated read replaced by a note that is still ours: the tokens it keeps out of every later request. Not a request. */
	| { readonly kind: "dedup"; readonly id: string; readonly tokens: number };

/** One source's line of the report. `requests` counts known and unknown ones. */
export interface SourceLine {
	requests: number;
	known: number;
	unknown: number;
	cost: number;
}

export interface CostReport {
	/** Prices are the catalogue's, not the provider's bill. */
	readonly priceBasis: "catalogue";
	readonly requests: number;
	/** Requests that left with no usage on record. */
	readonly unknown: number;
	/** Requests decided against: pi's policy or this engine's veto. */
	readonly skipped: number;
	/** Estimated tokens the repeated reads still replaced by a note collapsed by them, an estimate at the time of the edit (not a bill, and not what a later cut archived anyway). */
	readonly dedupCollapsedTokens: number;
	/** The cost of the known requests. Not the bill while `unknown` is above zero. */
	readonly knownSubtotal: number;
	/** True when every request that left has its usage. */
	readonly complete: boolean;
	/** The bill, only when it is complete. */
	readonly total: number | undefined;
	/** Tokens and cost of the known requests. */
	readonly tokens: UsageFigures;
	/** The part of the known requests pi's `getSessionStats` counts as well. */
	readonly piCounted: UsageFigures;
	/** The part only this engine's records tell of: historian and condenser requests. */
	readonly engineCounted: UsageFigures;
	readonly bySource: Readonly<Record<CostSource, SourceLine>>;
}

const none = (): UsageFigures => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function add(into: { -readonly [K in keyof UsageFigures]: number }, usage: UsageFigures): void {
	into.input += usage.input;
	into.output += usage.output;
	into.cacheRead += usage.cacheRead;
	into.cacheWrite += usage.cacheWrite;
	into.cost += usage.cost;
}

type Fields = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Whether a failed answer's usage tells nothing: pi-ai starts every answer with all-zero usage and keeps it when the
 * provider never reported any, as when the connection broke after the request left. Zero then means unknown, not free.
 */
function failedWithoutUsage(message: Fields): boolean {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
	const usage = normalizeUsage(message.usage);
	return !usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite <= 0;
}

/**
 * The accounting events of a session's entries, oldest first. Each request is one event however often the log tells of
 * it: entries count by their id, attempts by the attempt's id. A request is an event once it left, so the event stands
 * for the request even when the log ends before its answer.
 */
export function accountingEvents(raw: readonly RawEntry[]): AccountingEvent[] {
	const entries = raw as readonly Fields[];
	const events: AccountingEvent[] = [];
	const seen = new Set<string>();
	const emit = (event: AccountingEvent): void => {
		const key = `${event.kind}:${event.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		events.push(event);
	};
	const charge = (id: string, source: CostSource, counted: CountedBy, raw: unknown, why: string): void => {
		const usage = normalizeUsage(raw);
		emit(usage ? { kind: "charge", id, source, counted, usage } : { kind: "unknown", id, source, why });
	};

	/** Keep-warm side requests by id: sent, and ended once the end record arrived. */
	const sideWarms = new Map<string, Extract<WarmRecord, { type: "end" }> | undefined>();
	const attempts = new Map<string, { step: "summarize" | "condense"; end?: Extract<AttemptEntry, { type: "end" }> }>();
	/** What the summaries carry of the requests behind them, as the decoder reads it. */
	const summaries: { id: string; requests: readonly SummaryRequest[] }[] = [];
	/** The keep-warm ping whose turn is running: its answers are the ping's cost. */
	let ping: { id: string; answers: number } | undefined;
	/** A warm decision whose usage pi has not persisted yet. */
	let warm: string | undefined;
	/** A stop decision nothing has overridden yet; `seen` when the engine sees the requests a warm would send. */
	let stop: { id: string; veto: boolean; seen: boolean } | undefined;

	const endPing = (): void => {
		if (ping && ping.answers === 0) emit({ kind: "unknown", id: ping.id, source: "keep-warm", why: "a keep-warm ping with no answer on record" });
		ping = undefined;
	};
	/** A warm that left and persisted nothing failed or was cancelled after it was sent. */
	const lostWarm = (): void => {
		if (warm) emit({ kind: "unknown", id: warm, source: "native-warm", why: "a cache warm that left and persisted no usage" });
		warm = undefined;
	};
	/**
	 * A stop that stood: no later decision overrode it and no warm left after it. A later handler's override is invisible
	 * to the engine, the request it sends is not: without sight of the requests the stop proves nothing.
	 */
	const finalStop = (): void => {
		if (stop && stop.seen) emit({ kind: "skip", id: stop.id, why: stop.veto ? "veto" : "policy" });
		else if (stop) emit({ kind: "unknown", id: stop.id, source: "native-warm", why: "a stop a later handler may have overridden, on requests this engine cannot see" });
		stop = undefined;
	};
	/** A stop that a later decision followed with nothing between: pi had stopped warming, so a handler overrode it. */
	const overriddenStop = (): void => {
		if (stop) emit({ kind: "unknown", id: stop.id, source: "native-warm", why: "a stop that a later handler may have overridden" });
		stop = undefined;
	};

	entries.forEach((entry, index) => {
		const id = typeof entry.id === "string" ? entry.id : `#${index}`;
		switch (entry.type) {
			case "message": {
				const message = isObject(entry.message) ? entry.message : {};
				if (message.role === "user") {
					endPing();
					lostWarm();
					finalStop();
				} else if (message.role === "assistant") {
					// Not a warm: a warm sent while the run streams can finish after the run's answer.
					finalStop();
					if (ping) ping.answers++;
					if (failedWithoutUsage(message)) emit({ kind: "unknown", id, source: ping ? "keep-warm" : "main", why: "a failed request whose provider reported no usage" });
					else charge(id, ping ? "keep-warm" : "main", "pi", message.usage, "an assistant message with no usage");
				} else if (message.role === "toolResult" && message.usage !== undefined) {
					charge(id, "tool", "pi", message.usage, "a tool result with unreadable usage");
				}
				return;
			}
			case "usage": {
				const source: CostSource = entry.kind === "cache_warm" ? "native-warm" : "other";
				if (source === "native-warm") {
					warm = undefined;
					stop = undefined;
				}
				charge(id, source, "pi", entry.usage, "a usage entry with unreadable usage");
				return;
			}
			case "compaction":
			case "branch_summary": {
				const source = entry.type === "compaction" ? "compaction" : "branch-summary";
				const record = entry.type === "compaction" ? decodeContextRecord(entry) : undefined;
				// Our own cut is built from the log without a model: it is a request only when it carries usage.
				if (record?.kind === "cut" && entry.usage === undefined) return;
				charge(id, source, "pi", entry.usage, `a ${source === "compaction" ? "compaction" : "branch summary"} with no usage`);
				return;
			}
			case "custom":
			case "custom_message": {
				const record = decodeContextRecord(entry);
				if (entry.type === "custom" && (record.kind === "summary" || record.kind === "invalid") && record.requests) summaries.push({ id, requests: record.requests });
				if (record.kind === "keep-warm") {
					endPing();
					ping = { id, answers: 0 };
				} else if (record.kind === "warm-request") {
					const sent = record.warm;
					if (sent.type === "start") {
						if (!sideWarms.has(sent.id)) sideWarms.set(sent.id, undefined);
					} else sideWarms.set(sent.id, sideWarms.get(sent.id) ?? sent);
				} else if (record.kind === "warming") {
					lostWarm();
					if (record.sent) {
						// The warmed request left again after a stop: a later handler overrode the stop. The warm is paid.
						stop = undefined;
						warm = id;
					} else {
						overriddenStop();
						if (record.action === "warm") warm = id;
						else stop = { id, veto: record.veto || record.piAction === "warm", seen: record.requestsSeen };
					}
				} else if (record.kind === "attempt") {
					const attempt = record.entry;
					if (attempt.type === "start") {
						if (!attempts.has(attempt.id)) attempts.set(attempt.id, { step: attempt.step ?? "summarize" });
					} else if (attempt.type === "end") {
						const known = attempts.get(attempt.id) ?? { step: attempt.step ?? "summarize" };
						known.end ??= attempt;
						attempts.set(attempt.id, known);
					}
				}
				return;
			}
		}
	});
	endPing();
	lostWarm();
	finalStop();
	for (const [id, end] of sideWarms) {
		if (!end) emit({ kind: "unknown", id, source: "keep-warm", why: "a keep-warm request that left with no end on record: it counts as paid" });
		else charge(id, "keep-warm", "engine", end.usage, "a " + end.outcome + " keep-warm request with no usage");
	}
	for (const [id, attempt] of attempts) {
		const source: CostSource = attempt.step === "condense" ? "condenser" : "historian";
		if (!attempt.end) emit({ kind: "unknown", id, source, why: "an attempt that never ended: it counts as paid" });
		else charge(id, source, "engine", attempt.end.usage, `a ${attempt.end.outcome} attempt with no usage`);
	}
	summaryCharges(summaries, attempts, emit);
	for (const alias of liveAliases(raw).values()) emit({ kind: "dedup", id: alias.alias, tokens: alias.tokens });
	return events;
}

/**
 * The requests only a summary tells of. A summary's usage is the same request as a stored attempt receipt of the same
 * step and figures, so each receipt answers for one summary and the rest are requests nobody else recorded: the
 * summaries a historian wrote before attempt receipts existed. One that names no readable usage is a request of unknown
 * size, never a free one.
 */
function summaryCharges(
	summaries: readonly { id: string; requests: readonly SummaryRequest[] }[],
	attempts: ReadonlyMap<string, { step: "summarize" | "condense"; end?: Extract<AttemptEntry, { type: "end" }> }>,
	emit: (event: AccountingEvent) => void,
): void {
	const figuresKey = (step: string, usage: UsageFigures | undefined) => `${step}:${usage ? JSON.stringify(usage) : "none"}`;
	const receipts = new Map<string, number>();
	for (const { step, end } of attempts.values()) {
		if (end?.outcome !== "stored") continue;
		const key = figuresKey(step, end.usage);
		receipts.set(key, (receipts.get(key) ?? 0) + 1);
	}
	const answered = (step: "summarize" | "condense", usage: UsageFigures | undefined): boolean => {
		const key = figuresKey(step, usage);
		const left = receipts.get(key) ?? 0;
		if (left > 0) receipts.set(key, left - 1);
		return left > 0;
	};
	for (const summary of summaries) {
		for (const { step, usage } of summary.requests) {
			if (answered(step, usage)) continue;
			const source: CostSource = step === "condense" ? "condenser" : "historian";
			const id = `${summary.id}:${step}`;
			emit(usage ? { kind: "charge", id, source, counted: "engine", usage } : { kind: "unknown", id, source, why: `a stored summary whose ${step} request left no usage on record` });
		}
	}
}

/** Adds the events: the known cost, the count of unknown ones and the split by source. */
export function reduceAccounting(events: readonly AccountingEvent[]): CostReport {
	const bySource = Object.fromEntries(COST_SOURCES.map((source) => [source, { requests: 0, known: 0, unknown: 0, cost: 0 }])) as Record<CostSource, SourceLine>;
	const tokens = none();
	const piCounted = none();
	const engineCounted = none();
	let requests = 0;
	let unknown = 0;
	let skipped = 0;
	let dedupCollapsedTokens = 0;
	for (const event of events) {
		if (event.kind === "skip") {
			skipped++;
			continue;
		}
		if (event.kind === "dedup") {
			dedupCollapsedTokens += event.tokens;
			continue;
		}
		const line = bySource[event.source];
		line.requests++;
		requests++;
		if (event.kind === "unknown") {
			line.unknown++;
			unknown++;
			continue;
		}
		line.known++;
		line.cost += event.usage.cost;
		add(tokens, event.usage);
		add(event.counted === "pi" ? piCounted : engineCounted, event.usage);
	}
	const complete = unknown === 0;
	return { priceBasis: "catalogue", requests, unknown, skipped, dedupCollapsedTokens, knownSubtotal: tokens.cost, complete, total: complete ? tokens.cost : undefined, tokens, piCounted, engineCounted, bySource };
}

const dollars = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const count = (value: number) => value.toLocaleString("en-US");

/** The report as lines for `/context` and `npm run measure`. */
export function formatCostReport(report: CostReport): string[] {
	const parts = COST_SOURCES.flatMap((source) => {
		const line = report.bySource[source];
		if (line.requests === 0) return [];
		return [`${source} ${dollars(line.cost)} (${line.requests}${line.unknown > 0 ? `, ${line.unknown} unknown` : ""})`];
	});
	const split = parts.length > 0 ? `: ${parts.join(", ")}` : "";
	const skips = report.skipped > 0 ? `; ${report.skipped} cache warms skipped` : "";
	const head = report.complete
		? `Cost, catalogue prices (not billed cash): ${dollars(report.knownSubtotal)} over ${count(report.requests)} requests, complete`
		: `Cost incomplete, catalogue prices (not billed cash): ${dollars(report.knownSubtotal)} known so far over ${count(report.requests - report.unknown)} requests, plus ${count(report.unknown)} requests that left with no usage on record (unknown, not zero)`;
	const dedup = report.dedupCollapsedTokens > 0 ? [`Repeated reads kept once: ~${count(report.dedupCollapsedTokens)} tokens collapsed by notes that are still ours`] : [];
	return [`${head}${skips}`, ...(split ? [`By source${split}`] : []), ...dedup];
}
