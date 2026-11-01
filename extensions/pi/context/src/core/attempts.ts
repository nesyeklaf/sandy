import type { HistorianWork } from "./historian.ts";
import { digestOf } from "./serialize.ts";

/**
 * The historian's attempt records and the rule on top of them: a failing summary is retried a few times, then it
 * stops, also across restarts, because every retry is a paid request.
 *
 * An attempt is one model request: the summary, a fallback model's try or the condenser, each a receipt of its own.
 * It is written to the session before its request goes out and completed after. One without a completion (a crash, a
 * kill, a branch left behind) is unknown, and unknown counts as paid. The records are the one owner of "attempt": the
 * ledger keeps no second copy.
 */

/** Requests one piece of work gets before it pauses. */
export const ATTEMPT_LIMIT = 3;
/** The wait after the first and after the second failed attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000];

/** How an attempt ended. `stale`: the answer was paid for but the branch had moved on. `aborted`: a shutdown cut it short. */
export type AttemptOutcome = "stored" | "rejected" | "failed" | "stale" | "aborted";

/** What a request asks for: the summary of a stretch, or condensing a summary over budget. */
export type AttemptStep = "summarize" | "condense";

/** What a request used, in the figures the cost report adds up; `cost` is the catalogue price, not what was billed. */
export interface UsageFigures {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
}

/** One stored record of an attempt, or the owner's request to try a paused piece of work again. */
export type AttemptEntry =
	| {
			readonly type: "start";
			readonly id: string;
			/** What the attempt is for, see {@link workKey}. */
			readonly key: string;
			readonly at: number;
			/** The last entry of the stretch the attempt is to summarize. */
			readonly throughId: string;
			/** How many spans of the stretch the key covers, see {@link identifyWork}. */
			readonly cohort?: number;
			readonly step?: AttemptStep;
			/** `provider/model` the request goes to. */
			readonly model?: string;
			/** Which of the historian's routes sent it, e.g. `primary` or `fallback`. */
			readonly route?: string;
	  }
	| {
			readonly type: "end";
			readonly id: string;
			readonly key: string;
			readonly at: number;
			readonly outcome: AttemptOutcome;
			/** A rejection or an error, one line. */
			readonly detail?: string;
			/** Why a shutdown cut an aborted attempt short: the shutdown reason. */
			readonly reason?: string;
			readonly step?: AttemptStep;
			/** What the request used, when the route reported it; an end without usage is a charge of unknown size. */
			readonly usage?: UsageFigures;
	  }
	| { readonly type: "retry"; readonly at: number };

/** An attempt as the records of a branch read: `open` has no completion. */
export interface AttemptState {
	readonly id: string;
	/** When it started. */
	readonly at: number;
	/** When it ended; undefined while open. */
	readonly endedAt?: number;
	readonly outcome: AttemptOutcome | "open";
	readonly detail?: string;
	/** The cohort its start record names. */
	readonly cohort?: number;
}

/** The unfinished work of a branch by work key: attempts that did not store a summary, since the last explicit retry. */
export type AttemptsState = ReadonlyMap<string, readonly AttemptState[]>;

/** Folds a branch's attempt records, oldest first. Work that stored its summary is done and leaves no trace. */
export class AttemptFold {
	readonly #work = new Map<string, AttemptState[]>();

	add(entry: AttemptEntry): void {
		switch (entry.type) {
			case "retry":
				this.#work.clear();
				return;
			case "start": {
				const attempts = this.#work.get(entry.key) ?? [];
				attempts.push({ id: entry.id, at: entry.at, outcome: "open", ...(entry.cohort !== undefined ? { cohort: entry.cohort } : {}) });
				this.#work.set(entry.key, attempts);
				return;
			}
			case "end": {
				const attempts = this.#work.get(entry.key);
				const index = attempts?.findIndex((attempt) => attempt.id === entry.id) ?? -1;
				if (!attempts || index < 0) return;
				if (entry.outcome === "stored") {
					this.#work.delete(entry.key);
					return;
				}
				const open = attempts[index] as AttemptState;
				attempts[index] = {
					...open,
					endedAt: entry.at,
					outcome: entry.outcome,
					...(entry.detail !== undefined ? { detail: entry.detail } : {}),
				};
				return;
			}
		}
	}

	snapshot(): AttemptsState {
		return new Map([...this.#work].map(([key, attempts]) => [key, [...attempts]]));
	}
}

/**
 * What a piece of work is: the whole summary it extends, the stale checkpoint it replaces, the first `cohort` spans
 * of the stretch it reads (each entry with where it starts and how the whole entry reads) and `policy`, every
 * setting that shapes the request (see {@link requestPolicy}). Not how far the stretch reaches beyond the cohort, nor
 * where its last span ends: unrelated turns lengthen it, and they must not reset the attempts or the wait. A changed
 * summary, an edit or removal inside the cohort, or a changed setting or model is new work.
 */
export function workKey(work: HistorianWork, cohort: number, policy: string): string {
	return digestOf(
		work.previous ? JSON.stringify(work.previous) : "",
		work.supersedes ?? "",
		String(cohort),
		...work.spans.slice(0, cohort).map((span) => [span.entryId, span.from, span.digest].join(":")),
		policy,
	);
}

/** The settings a request depends on, as one string for {@link workKey}. */
export function requestPolicy(policy: {
	readonly models: readonly string[];
	readonly maxOutputTokens: number;
	readonly chunkMaxTokens: number;
	readonly summaryTokens: number;
	readonly prompts: readonly string[];
}): string {
	return JSON.stringify([policy.models, policy.maxOutputTokens, policy.chunkMaxTokens, policy.summaryTokens, digestOf(...policy.prompts)]);
}

/**
 * The key of `work`: the key of earlier attempts whose cohort it still reads the same, so growth keeps their count and
 * wait; else a new key over every span it reads.
 */
export function identifyWork(work: HistorianWork, state: AttemptsState, policy: string): { key: string; cohort: number } {
	for (const [key, attempts] of state) {
		const cohort = attempts[0]?.cohort;
		if (cohort === undefined || cohort > work.spans.length) continue;
		if (workKey(work, cohort, policy) === key) return { key, cohort };
	}
	const cohort = work.spans.length;
	return { key: workKey(work, cohort, policy), cohort };
}

/** What this process is doing: the attempt in flight and whether its worker was shut down. */
export interface WorkerState {
	readonly inFlight: string | undefined;
	readonly ended: boolean;
	/**
	 * The request follows one of the same attempt at once: a fallback model after a failed one, or the condenser after
	 * an answer. Only the limit holds it back.
	 */
	readonly follows?: boolean;
}

export type NextAction =
	| { readonly action: "start" }
	/** `until` is when the backoff ends; absent while an attempt is in flight or the worker has ended. */
	| { readonly action: "wait"; readonly why: "backoff" | "in-flight" | "ended"; readonly until?: number }
	| { readonly action: "pause"; readonly attempts: number; readonly lastDetail?: string };

/**
 * Whether the piece of work `key` may get another request now. It starts when no attempt is in flight, fewer than
 * `ATTEMPT_LIMIT` were made (open ones that no live worker owns count, as paid) and, after a rejected, failed or stale
 * attempt, the wait is over. After the limit it pauses until the owner retries.
 */
export function nextAction(key: string, state: AttemptsState, now: number, worker: WorkerState): NextAction {
	if (worker.ended) return { action: "wait", why: "ended" };
	const attempts = state.get(key) ?? [];
	if (attempts.some((attempt) => attempt.outcome === "open" && attempt.id === worker.inFlight)) {
		return { action: "wait", why: "in-flight" };
	}
	if (attempts.length >= ATTEMPT_LIMIT) {
		const lastDetail = attempts.findLast((attempt) => attempt.detail !== undefined)?.detail;
		return { action: "pause", attempts: attempts.length, ...(lastDetail !== undefined ? { lastDetail } : {}) };
	}
	const last = attempts.at(-1);
	if (!last || worker.follows) return { action: "start" };
	// A cut-short or unknown attempt says nothing against the work, so only the limit holds it back. A bad answer waits.
	if (last.outcome === "aborted" || last.outcome === "open") return { action: "start" };
	const delay = RETRY_DELAYS_MS[Math.min(attempts.length, RETRY_DELAYS_MS.length) - 1] as number;
	const until = (last.endedAt ?? last.at) + delay;
	return now < until ? { action: "wait", why: "backoff", until } : { action: "start" };
}

/** Usage figures as stored, or undefined when they are not all finite numbers. */
export function readUsageFigures(value: unknown): UsageFigures | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const figures = value as Record<string, unknown>;
	const keys = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
	if (!keys.every((key) => typeof figures[key] === "number" && Number.isFinite(figures[key]))) return undefined;
	return { input: figures.input as number, output: figures.output as number, cacheRead: figures.cacheRead as number, cacheWrite: figures.cacheWrite as number, cost: figures.cost as number };
}

/**
 * The usage of a request in the figures of the report, from pi-ai's usage (`cost.total`) or from figures already
 * stored (`cost`). Undefined when the source is no usage or lacks a number: the request is then unknown.
 */
export function normalizeUsage(source: unknown): UsageFigures | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const usage = source as Record<string, unknown>;
	const cost = typeof usage.cost === "object" && usage.cost !== null ? (usage.cost as Record<string, unknown>).total : usage.cost;
	return readUsageFigures({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost });
}

/** An attempt record as stored, or undefined when it cannot be read. */
export function readAttemptEntry(value: unknown): AttemptEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const text = (field: unknown): field is string => typeof field === "string";
	const time = (field: unknown): field is number => typeof field === "number" && Number.isFinite(field);
	if (!time(record.at)) return undefined;
	switch (record.type) {
		case "retry":
			return { type: "retry", at: record.at };
		case "start":
			return text(record.id) && text(record.key) && text(record.throughId)
				? {
						type: "start",
						id: record.id,
						key: record.key,
						at: record.at,
						throughId: record.throughId,
						...(typeof record.cohort === "number" && Number.isInteger(record.cohort) ? { cohort: record.cohort } : {}),
						...(record.step === "summarize" || record.step === "condense" ? { step: record.step } : {}),
						...(text(record.model) ? { model: record.model } : {}),
						...(text(record.route) ? { route: record.route } : {}),
					}
				: undefined;
		case "end": {
			const outcomes: readonly unknown[] = ["stored", "rejected", "failed", "stale", "aborted"];
			if (!text(record.id) || !text(record.key) || !outcomes.includes(record.outcome)) return undefined;
			return {
				type: "end",
				id: record.id,
				key: record.key,
				at: record.at,
				outcome: record.outcome as AttemptOutcome,
				...(text(record.detail) ? { detail: record.detail } : {}),
				...(text(record.reason) ? { reason: record.reason } : {}),
				...(record.step === "summarize" || record.step === "condense" ? { step: record.step } : {}),
				...(readUsageFigures(record.usage) ? { usage: readUsageFigures(record.usage) as UsageFigures } : {}),
			};
		}
		default:
			return undefined;
	}
}
