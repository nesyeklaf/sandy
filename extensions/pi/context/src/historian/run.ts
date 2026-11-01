/**
 * The background historian both adapters run: it summarizes the stretch of history the next cut will archive, so a cut
 * never waits for a model call. A host gives it a branch: the models to ask, readers of the next stretch and of the latest
 * summary, a writer, the log of its attempts and, across processes, a claim on the work. It imports no host.
 */
import { randomUUID } from "node:crypto";
import {
	type AttemptEntry,
	type AttemptOutcome,
	type AttemptStep,
	type AttemptsState,
	identifyWork,
	nextAction,
	requestPolicy,
} from "../core/attempts.ts";
import type { ContextConfig } from "../core/config.ts";
import { normalizeUsage, type UsageFigures } from "../core/attempts.ts";
import { estimateBudget } from "../core/tokens.ts";
import {
	type CommitResult,
	CONDENSER_SYSTEM_PROMPT,
	completeSummary,
	condensePrompt,
	HISTORIAN_SYSTEM_PROMPT,
	type HistorianWork,
	historianPrompt,
	type StoredSummary,
	validateCompletion,
} from "../core/historian.ts";
import { applyCondensed, condenseSelection, fitToBudget, parseSummaryDelta, type SummaryState } from "../core/summary.ts";

export interface SummarizeRequest {
	readonly system: string;
	readonly prompt: string;
	/** The prompt with the entries a request already holds named instead of shown, for a fork that continues it. */
	readonly referencing?: (above: (probes: { readonly head: string; readonly tail: string }) => boolean) => string;
	readonly maxTokens: number;
	readonly signal: AbortSignal;
}

export interface SummarizeResult {
	readonly text: string;
	readonly usage?: unknown;
	/** `provider/model` that answered. */
	readonly model?: string;
	/** How the model ended; anything but `stop` is an answer cut short. */
	readonly stopReason?: string;
	/** Tool calls the model made instead of answering. */
	readonly toolCalls?: number;
}

/** One model call of the historian or the condenser. */
type Summarizer = (request: SummarizeRequest) => Promise<SummarizeResult>;

/**
 * One way the historian can ask a model. A call is at most one request on the wire: the host pins a transport that
 * does not resend unseen, so one receipt stands for one paid request.
 */
export interface HistorianRoute {
	/** `provider/model`, named on the receipt and part of the work's identity. */
	readonly model: string;
	/** Which route it is, e.g. `fork`, `primary` or `fallback`, named on the receipt. */
	readonly route: string;
	/**
	 * A gated route (the fork on the main model's cache) decides at the wire whether it sends: it calls `sending` right
	 * before its one request leaves, and only then is its receipt stored. Failing before that, it declined: it cost
	 * nothing, leaves no receipt and the next route is asked. Failing after, the request failed and no other route is
	 * asked for it. An ungated route's receipt is stored before the call, and `sending` does nothing.
	 */
	readonly gated?: boolean;
	readonly call: (request: SummarizeRequest, sending: () => void) => Promise<SummarizeResult>;
}

/**
 * The right to work on a session's historian across processes on one host: one process at a time sends requests and
 * writes. Without one, the process is alone with its session (an in-memory session, a test).
 */
export interface WorkClaim {
	/** Takes the claim, or keeps it; false while another live process holds it. */
	acquire(): boolean;
	/** Names the work the holder is doing, for whoever finds the claim. */
	working(key: string): void;
	/** Whether this process still holds the claim; checked before every request and before the write. */
	held(): boolean;
	release(): void;
}

/**
 * Where the attempts of a branch are kept: the session itself, so a restart finds them. `read` answers from the
 * session's receipts as they read now, with what other processes appended meanwhile; `append` stores one record at
 * once, and a request goes out only after its start record was stored.
 */
export interface AttemptLog {
	readonly read: () => AttemptsState;
	/** Whether a summary of the work `key` names is stored already, by this process or another one. */
	readonly stored?: (key: string) => boolean;
	readonly append: (entry: AttemptEntry) => void;
}

/** One branch of a session, as a host gives it to the historian. */
export interface HistorianBranch {
	/** The models to ask, in order: the next is asked only when one fails. Empty when no model may be asked. */
	readonly routes: () => readonly HistorianRoute[];
	readonly claim?: WorkClaim;
	/** The stretch worth summarizing next, with the summary it extends; undefined when too little has accumulated. */
	readonly next: (signal: AbortSignal) => Promise<HistorianWork | undefined>;
	/**
	 * Stores the summary if the branch still reads as the work did (see `commitSummary`), and says whether it did. This
	 * is the commit point: it answers at once, not with a promise, so no storage that finishes later can hold a shutdown
	 * or land after one.
	 */
	readonly write: (work: HistorianWork, summary: StoredSummary) => CommitResult;
	readonly attempts: AttemptLog;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why a run ends: a session shutdown reason of the host, or `branch` when the session moved to another branch. */
export type LifecycleReason = "quit" | "reload" | "new" | "resume" | "fork" | "branch";

/** What a shutdown found: a summary stored or an attempt that finished, an attempt cut short, or no call yet. */
export type LifecycleOutcome = "completed" | "aborted" | "not started";

/** Work that used up its attempts: nothing more is asked until the owner retries. */
export interface HistorianPause {
	readonly attempts: number;
	readonly lastDetail?: string;
}

interface LifecycleHooks {
	/** Receives each failed model call or read; an aborted run is no failure. */
	readonly onError?: (error: unknown) => void;
	/** Receives the first pause of a piece of work in this process, so the host can tell the owner. */
	readonly onPause?: (pause: HistorianPause) => void;
	/** The clock for the wait between attempts. */
	readonly now?: () => number;
}

/** The work in progress from its first model request until its summary is stored. */
interface Flight {
	readonly key: string;
	readonly cohort: number;
	readonly throughId: string;
	readonly branch: HistorianBranch;
	readonly routes: readonly HistorianRoute[];
	/** The request out now, if any. */
	current: Request | undefined;
	/** Requests that answered; they end with the work's outcome. */
	readonly answered: Request[];
}

/** A request that left. Its usage is what the answer (or the error that came with it) reported; none means unknown. */
interface Request {
	readonly id: string;
	readonly step: AttemptStep;
	readonly usage?: UsageFigures;
}

/** The runs of one branch generation. */
interface Worker {
	readonly generation: number;
	readonly abort: AbortController;
	flight: Flight | undefined;
	/** A model call went out in this generation. */
	called: boolean;
	/** An attempt was cut short. */
	cancelled: boolean;
	running: boolean;
	/** The work whose summary this worker stored last: finding it again means the store changed nothing. */
	storedKey?: string;
}

/** Every route of one request failed; each failure is in the message. */
class RequestsFailed extends Error {}

/** A gated route answered without saying it sent: a broken route, whose request has no receipt. */
class UnsentAnswer extends Error {}

/** `promise`, or a rejection as soon as `signal` aborts, so a transport that ignores the signal cannot hold a shutdown. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Runs the historian in the background: one worker per branch generation, started by the host with `start` and
 * ended with `shutdown`. A worker that stores a summary looks again at once, since more history may wait. A shutdown,
 * or the start of a newer generation, aborts the worker promptly and without a drain: cancelled work never advances
 * the summary and never writes onto another branch, so the stretch is summarized again at the next start.
 *
 * Every model request is an attempt, stored on the branch before it goes out (see `core/attempts.ts`): the summary,
 * each fallback model's try and the condenser alike. A piece of work that did not produce a summary gets
 * `ATTEMPT_LIMIT` requests; a fallback or the condenser follows at once, a new run waits. The count and the wait come
 * from the stored records, so a restart or a new turn neither resets nor skips them. A shutdown completes the request
 * it cut short as aborted; leaving a branch cannot (the leaf has moved), so that request stays open, which counts as
 * paid.
 */
export class HistorianLifecycle {
	readonly #config: ContextConfig;
	readonly #hooks: LifecycleHooks;
	readonly #runs = new Set<Promise<void>>();
	readonly #now: () => number;
	/** Work already announced as paused. */
	readonly #announced = new Set<string>();
	#current: Worker | undefined;
	readonly stats = {
		runs: 0,
		failures: 0,
		condensed: 0,
		aborted: 0,
		lastError: undefined as string | undefined,
		/** The pause the latest look found; undefined once work can go on. */
		paused: undefined as HistorianPause | undefined,
	};

	constructor(config: ContextConfig, hooks: LifecycleHooks = {}) {
		this.#config = config;
		this.#hooks = hooks;
		this.#now = hooks.now ?? Date.now;
	}

	/** Runs going on now. */
	get running(): number {
		return this.#runs.size;
	}

	/**
	 * The owner's request to try again: stores it on the branch, which frees work that paused or waits out its delay.
	 * Returns whether anything was waiting. The caller starts the worker.
	 */
	retry(branch: HistorianBranch): boolean {
		if (branch.attempts.read().size === 0) return false;
		branch.attempts.append({ type: "retry", at: this.#now() });
		this.#announced.clear();
		this.stats.paused = undefined;
		return true;
	}

	/**
	 * Summarize the branch's next stretch in the background. A newer `generation` cancels the worker of the older one;
	 * an older one, or one already shut down, starts nothing; a worker already going is left alone.
	 */
	start(work: HistorianBranch, generation: number): void {
		const current = this.#current;
		if (current && generation < current.generation) return;
		if (current && generation === current.generation && current.abort.signal.aborted) return;
		if (current && generation > current.generation) this.#cancel(current, "branch");
		const worker =
			current && generation === current.generation
				? current
				: { generation, abort: new AbortController(), flight: undefined, called: false, cancelled: false, running: false };
		this.#current = worker;
		if (!this.#config.historian.enabled || worker.running) return;
		worker.running = true;
		const run: Promise<void> = this.#loop(worker, work).then(() => {
			worker.running = false;
			this.#runs.delete(run);
		});
		this.#runs.add(run);
	}

	/**
	 * Abort the current worker and wait until it ends, which is prompt: no call is drained. Nothing starts in this
	 * generation again. Returns what was found: `aborted` when an attempt was cut short, `completed` when attempts
	 * ended on their own, `not started` when no call went out.
	 */
	async shutdown(reason: LifecycleReason): Promise<LifecycleOutcome> {
		const worker = this.#current;
		if (!worker) return "not started";
		this.#cancel(worker, reason);
		await Promise.all(this.#runs);
		return worker.cancelled ? "aborted" : worker.called ? "completed" : "not started";
	}

	#cancel(worker: Worker, reason: LifecycleReason): void {
		if (worker.abort.signal.aborted) return;
		worker.abort.abort(reason);
		const { flight } = worker;
		if (!flight) return;
		worker.cancelled = true;
		this.stats.aborted++;
		worker.flight = undefined;
		if (reason !== "branch") this.#endAll(flight, "aborted", { reason });
	}

	/** Completes a request on its branch. A store that fails leaves it open, which counts as paid. */
	#end(
		flight: Flight,
		request: Request,
		outcome: AttemptOutcome,
		extra: { detail?: string; reason?: string } = {},
	): void {
		try {
			flight.branch.attempts.append({ type: "end", id: request.id, key: flight.key, at: this.#now(), outcome, step: request.step, ...(request.usage ? { usage: request.usage } : {}), ...extra });
		} catch (error) {
			this.#fail(error);
		}
	}

	/** Completes every request of the work still open: the answered ones and the one out now. */
	#endAll(flight: Flight, outcome: AttemptOutcome, extra: { detail?: string; reason?: string } = {}): void {
		const open = [...flight.answered, ...(flight.current ? [flight.current] : [])];
		flight.answered.length = 0;
		flight.current = undefined;
		for (const request of open) this.#end(flight, request, outcome, extra);
	}

	async #loop(worker: Worker, branch: HistorianBranch): Promise<void> {
		try {
			while (!worker.abort.signal.aborted && (await this.#run(worker, branch))) continue;
		} finally {
			// A worker that waits, pauses or is done leaves the session to whichever process has work next. A worker a newer
			// generation replaced leaves the claim to that one.
			if (worker.flight === undefined && this.#current === worker) branch.claim?.release();
		}
	}

	/**
	 * The receipt boundary: every model request of the historian goes through here. It asks the routes in order until
	 * one answers, storing a start record before each request and sending nothing once the work is out of requests, the
	 * claim is lost, or the run ended. A failed request ends at once; an answered one ends with the work. A gated route
	 * stores its record when it sends, so declining costs no attempt, and a failure after it sent asks no other route.
	 */
	async #ask(worker: Worker, flight: Flight, step: AttemptStep, request: Omit<SummarizeRequest, "signal">): Promise<SummarizeResult | undefined> {
		const { signal } = worker.abort;
		const failures: string[] = [];
		for (const route of flight.routes) {
			const follows = failures.length > 0 || step === "condense";
			if (follows) {
				const decision = nextAction(flight.key, flight.branch.attempts.read(), this.#now(), { inFlight: undefined, ended: signal.aborted, follows });
				if (decision.action !== "start") break;
			}
			let id: string | undefined;
			const start = () => {
				if (id !== undefined) throw new Error(`historian route ${route.route} sent twice`);
				if (signal.aborted) throw new Error("the historian's run ended");
				if (flight.branch.claim && !flight.branch.claim.held()) throw new Error("another pi process took over the historian's work");
				id = randomUUID();
				flight.branch.attempts.append({
					type: "start",
					id,
					key: flight.key,
					at: this.#now(),
					throughId: flight.throughId,
					cohort: flight.cohort,
					step,
					model: route.model,
					route: route.route,
				});
				flight.current = { id, step };
				worker.called = true;
				this.stats.runs++;
			};
			if (!route.gated) start();
			try {
				const result = await abortable(route.call({ ...request, signal }, route.gated ? start : () => {}), signal);
				if (id === undefined) throw new UnsentAnswer(`historian route ${route.route} answered without sending`);
				flight.current = undefined;
				const usage = normalizeUsage(result?.usage);
				flight.answered.push({ id, step, ...(usage ? { usage } : {}) });
				return result;
			} catch (error) {
				if (signal.aborted || error instanceof UnsentAnswer) throw error;
				// Declined before it sent: nothing was paid, the next route is asked.
				if (id === undefined) continue;
				flight.current = undefined;
				failures.push(message(error));
				// An error that carries the answer it came with names what the request used; without one it is a charge of unknown size.
				const usage = normalizeUsage((error as { usage?: unknown } | null)?.usage);
				this.#end(flight, { id, step, ...(usage ? { usage } : {}) }, "failed", { detail: message(error) });
				if (route.gated) break;
			}
		}
		if (failures.length === 0) return undefined;
		throw new RequestsFailed(failures.join("; then: "));
	}

	/** One summary of the next stretch; whether it was stored. */
	async #run(worker: Worker, branch: HistorianBranch): Promise<boolean> {
		const { signal } = worker.abort;
		try {
			const work = await abortable(branch.next(signal), signal);
			if (work === undefined || signal.aborted) return false;
			const routes = branch.routes();
			if (routes.length === 0) throw new Error("no model may be asked for the historian");
			// Another process on this session holds the work: its requests are under way or about to be.
			if (branch.claim && !branch.claim.acquire()) return false;
			const policy = requestPolicy({
				models: routes.map((route) => route.route + ":" + route.model),
				maxOutputTokens: this.#config.historian.maxOutputTokens,
				chunkMaxTokens: this.#config.historian.chunkMaxTokens,
				summaryTokens: this.#config.summaryTokens,
				prompts: [HISTORIAN_SYSTEM_PROMPT, CONDENSER_SYSTEM_PROMPT],
			});
			const attempts = branch.attempts.read();
			const { key, cohort } = identifyWork(work, attempts, policy);
			// A stored summary moves the work on; the same work again would be asked for again and again without new input.
			if (key === worker.storedKey) throw new Error("historian work " + key + " unchanged after its summary was stored; not asking again");
			// A process whose snapshot predates another's summary of this same work would pay for it again.
			if (branch.attempts.stored?.(key)) return false;
			branch.claim?.working(key);
			const decision = nextAction(key, attempts, this.#now(), {
				inFlight: worker.flight?.current?.id,
				ended: signal.aborted,
			});
			if (decision.action === "pause") {
				this.#pause(key, decision);
				return false;
			}
			this.stats.paused = undefined;
			if (decision.action === "wait") return false;
			const { coverage, readAt } = work;
			const flight: Flight = {
				key,
				cohort,
				throughId: work.spans.at(-1)?.entryId ?? coverage.throughId,
				branch,
				routes,
				current: undefined,
				answered: [],
			};
			worker.flight = flight;
			const result = await this.#ask(worker, flight, "summarize", {
				system: HISTORIAN_SYSTEM_PROMPT,
				prompt: historianPrompt(work),
				referencing: (above) => historianPrompt(work, above),
				maxTokens: this.#config.historian.maxOutputTokens,
			});
			if (signal.aborted) return false;
			if (result === undefined) {
				worker.flight = undefined;
				return false;
			}
			// Only a complete, sourced answer is a summary; anything else leaves the coverage where it was.
			const valid = validateCompletion(
				{
					text: result.text,
					...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
					...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
				},
				work,
			);
			if (!valid.ok) {
				worker.flight = undefined;
				const detail = `historian answer rejected (${valid.reason}): ${valid.detail}`;
				this.#endAll(flight, "rejected", { detail });
				this.#fail(new Error(detail));
				return false;
			}
			const merged = completeSummary(work, valid);
			const condensed = await this.#condense(worker, flight, merged, work.order);
			if (signal.aborted) return false;
			// Pi Durable's reader skips a summary over budget, so one written over it would be summarized again forever.
			const summary = fitToBudget(condensed.summary, estimateBudget(this.#config.summaryTokens));
			const { condenseUsage } = condensed;
			if (branch.claim && !branch.claim.held()) throw new Error("another pi process took over the historian's work");
			// The write is the commit point and returns only once the summary is stored or found stale, so a shutdown cannot
			// fall into it. Another summary written meanwhile, an edited source or a branch that lost the stretch is stale.
			worker.flight = undefined;
			const committed = branch.write(work, {
				...summary,
				...(readAt !== undefined ? { projectedThroughId: readAt } : {}),
				...(result.usage !== undefined ? { usage: result.usage } : {}),
				...(result.model !== undefined ? { model: result.model } : {}),
				...(condenseUsage !== undefined ? { condenseUsage } : {}),
			});
			this.#endAll(flight, committed.status === "stored" ? "stored" : "stale", committed.status === "stored" ? {} : { detail: committed.why });
			if (committed.status === "stored") worker.storedKey = key;
			return committed.status === "stored";
		} catch (error) {
			if (!signal.aborted) {
				const { flight } = worker;
				worker.flight = undefined;
				if (flight) this.#endAll(flight, "failed", { detail: message(error) });
				this.#fail(error);
			}
			return false;
		}
	}

	/** Work that used its attempts waits for the owner; the first look in this process tells the host. */
	#pause(key: string, pause: HistorianPause): void {
		this.stats.paused = pause;
		if (this.#announced.has(key)) return;
		this.#announced.add(key);
		this.#hooks.onPause?.(pause);
	}

	/**
	 * Shrink a summary over budget by condensing its oldest records into fewer items that keep their entry ids. It
	 * changes only the stored summary; the model sees it at the next cut, which rewrites the context anyway. The result
	 * may still be over budget: `fitToBudget` drops what condensing left over.
	 */
	async #condense(
		worker: Worker,
		flight: Flight,
		summary: SummaryState,
		order: ReadonlyMap<string, number>,
	): Promise<{ summary: SummaryState; condenseUsage?: unknown }> {
		const { signal } = worker.abort;
		const selection = condenseSelection(summary, estimateBudget(this.#config.summaryTokens));
		if (!selection) return { summary };
		try {
			// Past the limit no condenser is asked: `fitToBudget` trims the summary instead.
			const result = await this.#ask(worker, flight, "condense", {
				system: CONDENSER_SYSTEM_PROMPT,
				prompt: condensePrompt(selection),
				maxTokens: this.#config.historian.maxOutputTokens,
			});
			if (result === undefined) return { summary };
			this.stats.condensed++;
			return {
				// The history's order reads a cited range as every entry in it, so a condensed item cannot drop one.
				summary: applyCondensed(summary, selection, parseSummaryDelta(result.text), order),
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
		this.#hooks.onError?.(error);
	}
}
