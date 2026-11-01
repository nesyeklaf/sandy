/**
 * The background historian both adapters run: it summarizes the stretch of history the next cut will archive, so a cut
 * never waits for a model call. A host gives it a branch: a summarizer, readers of the next stretch and of the latest
 * summary, and a writer. It imports no host.
 */
import type { ContextConfig } from "../core/config.ts";
import { estimateBudget } from "../core/tokens.ts";
import {
	type Chunk,
	CONDENSER_SYSTEM_PROMPT,
	condensePrompt,
	HISTORIAN_SYSTEM_PROMPT,
	historianDelta,
	historianPrompt,
} from "../core/historian.ts";
import {
	applyCondensed,
	condenseSelection,
	fitToBudget,
	mergeSummary,
	parseSummaryDelta,
	type SummaryState,
} from "../core/summary.ts";

export interface SummarizeRequest {
	readonly system: string;
	readonly prompt: string;
	readonly maxTokens: number;
	readonly signal: AbortSignal;
}

export interface SummarizeResult {
	readonly text: string;
	readonly usage?: unknown;
	/** `provider/model` that answered. */
	readonly model?: string;
}

/** One model call of the historian or the condenser. */
type Summarizer = (request: SummarizeRequest) => Promise<SummarizeResult>;

/** What the historian summarizes next: a stretch of history and the summary it extends. */
interface HistorianWork {
	readonly summary: SummaryState | undefined;
	readonly chunk: Chunk;
}

/** A summary as the historian stores it, with the usage and model of the calls behind it. */
type StoredSummary = SummaryState & {
	readonly usage?: unknown;
	readonly model?: string;
	readonly condenseUsage?: unknown;
};

/** One branch of a session, as a host gives it to the historian. */
export interface HistorianBranch {
	readonly summarize: Summarizer;
	/** The stretch worth summarizing next, with the summary it extends; undefined when too little has accumulated. */
	readonly next: (signal: AbortSignal) => Promise<HistorianWork | undefined>;
	/** The branch's latest summary now, and whether the branch still holds the entry `anchor`. */
	readonly latest: (
		anchor: string,
		signal: AbortSignal,
	) => Promise<{ readonly summary: SummaryState | undefined; readonly holds: boolean }>;
	readonly write: (summary: StoredSummary, signal: AbortSignal) => Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs the historian in the background, at most one run per branch key. A run that stores a summary looks again at
 * once, since more history may wait; `stop` aborts every run.
 */
export class Historian<Key> {
	readonly #config: ContextConfig;
	readonly #onError: (error: unknown) => void;
	readonly #runs = new Map<Key, Promise<void>>();
	#abort = new AbortController();
	readonly stats = { runs: 0, failures: 0, condensed: 0, lastError: undefined as string | undefined };

	/** `onError` receives each failed model call or read; an aborted run is no failure. */
	constructor(config: ContextConfig, onError: (error: unknown) => void = () => undefined) {
		this.#config = config;
		this.#onError = onError;
	}

	/** Runs going on now. */
	get running(): number {
		return this.#runs.size;
	}

	/** Summarize the branch's next stretch in the background, unless a run for `key` is going or the historian stopped. */
	schedule(key: Key, branch: HistorianBranch): void {
		if (!this.#config.historian.enabled || this.#runs.has(key) || this.#abort.signal.aborted) return;
		const run: Promise<void> = this.#run(branch, this.#abort.signal).then((stored) => {
			if (this.#runs.get(key) !== run) return;
			this.#runs.delete(key);
			if (stored) this.schedule(key, branch);
		});
		this.#runs.set(key, run);
	}

	/** Abort every run and wait until they end. Nothing starts again until `start`. */
	async stop(): Promise<void> {
		this.#abort.abort();
		const runs = [...this.#runs.values()];
		this.#runs.clear();
		await Promise.all(runs);
	}

	/** Allow runs again after `stop`. */
	start(): void {
		if (this.#abort.signal.aborted) this.#abort = new AbortController();
	}

	/** One summary of the next stretch; whether it was stored. */
	async #run(branch: HistorianBranch, signal: AbortSignal): Promise<boolean> {
		try {
			const work = await branch.next(signal);
			if (work === undefined || signal.aborted) return false;
			this.stats.runs++;
			const { summary: previous, chunk } = work;
			const result = await branch.summarize({
				system: HISTORIAN_SYSTEM_PROMPT,
				prompt: historianPrompt(chunk, previous),
				maxTokens: this.#config.historian.maxOutputTokens,
				signal,
			});
			if (signal.aborted) return false;
			const merged = mergeSummary(previous, historianDelta(result.text, chunk), chunk.throughId);
			const condensed = await this.#condense(branch, merged, signal);
			if (signal.aborted) return false;
			// Pi Durable's reader skips a summary over budget, so one written over it would be summarized again forever.
			const summary = fitToBudget(condensed.summary, estimateBudget(this.#config.summaryTokens));
			const { condenseUsage } = condensed;
			// Another summary written meanwhile, or a branch that lost the stretch, makes this one stale.
			const latest = await branch.latest(chunk.throughId, signal);
			if (!latest.holds || latest.summary?.coveredThroughId !== previous?.coveredThroughId) return false;
			await branch.write(
				{
					...summary,
					...(result.usage !== undefined ? { usage: result.usage } : {}),
					...(result.model !== undefined ? { model: result.model } : {}),
					...(condenseUsage !== undefined ? { condenseUsage } : {}),
				},
				signal,
			);
			return true;
		} catch (error) {
			if (!signal.aborted) this.#fail(error);
			return false;
		}
	}

	/**
	 * Shrink a summary over budget by condensing its oldest records into fewer items that keep their entry ids. It
	 * changes only the stored summary; the model sees it at the next cut, which rewrites the context anyway. The result
	 * may still be over budget: `fitToBudget` drops what condensing left over.
	 */
	async #condense(
		branch: HistorianBranch,
		summary: SummaryState,
		signal: AbortSignal,
	): Promise<{ summary: SummaryState; condenseUsage?: unknown }> {
		const selection = condenseSelection(summary, estimateBudget(this.#config.summaryTokens));
		if (!selection) return { summary };
		try {
			const result = await branch.summarize({
				system: CONDENSER_SYSTEM_PROMPT,
				prompt: condensePrompt(selection),
				maxTokens: this.#config.historian.maxOutputTokens,
				signal,
			});
			this.stats.condensed++;
			return {
				summary: applyCondensed(summary, selection, parseSummaryDelta(result.text)),
				condenseUsage: result.usage,
			};
		} catch (error) {
			if (!signal.aborted) this.#fail(error);
			return { summary };
		}
	}

	#fail(error: unknown): void {
		this.stats.failures++;
		this.stats.lastError = message(error);
		this.#onError(error);
	}
}
