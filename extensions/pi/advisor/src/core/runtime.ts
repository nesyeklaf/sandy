import { AdvisorContext } from "./advisorContext.ts";
import type { Asker } from "./asker.ts";
import type { AdvisorConfig } from "./config.ts";
import { renderDelta, sliceAfter, type WithId } from "./delta.ts";
import { gate, type GateResult } from "./gate.ts";
import { buildLedger } from "./ledger.ts";
import { parseState, renderState, goalCheck, reminder, submit, type Exec, type SessionState, type Submitted } from "./proposals.ts";
import { changeWork, runRules } from "./rules.ts";
import { textOf, type Block, type CompleteFn, type Msg, type Review } from "./types.ts";
import { parseReview } from "./verdict.ts";
import { StateWatch, type StateChanges, type WatchSnapshot } from "./watch.ts";

export type Entry = WithId<Msg>;

export interface Deps {
	config: AdvisorConfig;
	/** The advisor's conversation. Without one, a bare model call through complete is used. */
	asker?: Asker;
	complete: CompleteFn;
	exec: Exec;
	sandy: string;
	sessionId: string;
	threadId?: string;
	/** Message entries of the current branch, oldest first. */
	entries: () => Entry[];
}

export interface ReviewResult {
	review?: Review;
	submitted: Submitted[];
}

/**
 * One advisor per session. All calls run one after the other on one queue: the context is append-only,
 * so two overlapping calls would interleave their messages and break the cache prefix.
 */
export class Advisor {
	readonly ctx: Asker;
	readonly seen = new Set<string>();
	private cursor: string | undefined;
	private tail: Promise<unknown> = Promise.resolve();
	private turnsSinceNote = Number.POSITIVE_INFINITY;
	private turnsSinceReview = 0;
	private notesThisRun = 0;
	/** The ideas state last read, and the text of it the advisor has already been told. */
	private state: SessionState | undefined;
	private sentState: string | undefined;
	private readonly watch = new StateWatch();
	gateCounts = { released: 0, checked: 0, unchecked: 0 };

	private readonly d: Deps;

	constructor(d: Deps) {
		this.d = d;
		const { cache, model } = d.config;
		this.ctx = d.asker ?? new AdvisorContext({ complete: d.complete, sessionId: `advisor:${d.sessionId}`, retention: cache.retention, budgetTokens: cache.budgetTokens, maxOutputTokens: cache.maxOutputTokens, reasoning: model.reasoning });
	}

	private serial<T>(job: () => Promise<T>): Promise<T> {
		const run = this.tail.then(job, job);
		this.tail = run.catch(() => undefined);
		return run;
	}

	/** Where the session stands in the ideas plugin. Never throws; without an answer the advisor just does not know. */
	private async readState(): Promise<SessionState | undefined> {
		if (!this.d.config.proposals.enabled || !this.d.threadId) return undefined;
		try {
			const r = await this.d.exec(this.d.sandy, ["ideas", "thread", this.d.threadId]);
			this.state = r.code === 0 ? parseState(r.stdout) : undefined;
		} catch {
			this.state = undefined;
		}
		return this.state;
	}

	/** New material for the advisor. The ideas state goes last and only when it changed, so earlier context stays a stable prefix. */
	private async pending(): Promise<{ delta: string; lastId: string | undefined; sent: () => void; raw: string }> {
		const { messages, lastId } = sliceAfter(this.d.entries(), this.cursor);
		const { cache } = this.d.config;
		const raw = renderDelta(messages, { toolResultMaxChars: cache.toolResultMaxChars, textMaxChars: cache.textMaxChars });
		const state = await this.readState();
		const text = state ? renderState(state) : undefined;
		const fresh = text !== undefined && text !== this.sentState;
		const warn = state ? reminder(state, changeWork(messages)) : undefined;
		const body = fresh ? `${raw}\n\n${text}` : raw;
		return { delta: warn ? `${body}\n\n${warn}` : body, lastId, raw, sent: () => { if (fresh) this.sentState = text; } };
	}

	/** Called at message_end of a final answer. entries() must not contain that answer yet. */
	async gateFinal(answer: string): Promise<GateResult> {
		const { gate: g } = this.d.config;
		const ledger = buildLedger(this.d.entries().map((e) => e.message).filter((m): m is Msg => !!m));
		const suspicions = answer.length < g.minChars ? [] : runRules(answer, ledger, g.rules);
		const job = this.serial(async () => {
			if (suspicions.length === 0) return gate({ answer, suspicions, ask: async () => undefined, delta: "", timeoutMs: g.timeoutMs, onTimeout: g.onTimeout });
			const { delta, lastId, sent } = await this.pending();
			let asked = false;
			const r = await gate({
				answer,
				suspicions,
				delta,
				timeoutMs: g.timeoutMs,
				onTimeout: g.onTimeout,
				mode: g.mode,
				ask: async (prompt, signal) => {
					const reply = await this.ctx.ask(prompt, signal);
					asked = reply !== undefined;
					return reply;
				},
			});
			if (asked) {
				this.cursor = lastId;
				sent();
			}
			return r;
		});
		// A review still running when the answer arrives may hold the queue; the answer waits at most twice the gate timeout.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<GateResult>((resolve) => {
			timer = setTimeout(() => resolve({ text: answer, changed: false, outcome: "unchecked", suspicions }), g.timeoutMs * 2);
		});
		const result = suspicions.length === 0 ? await job : await Promise.race([job, late]).finally(() => clearTimeout(timer));
		this.gateCounts[result.outcome]++;
		if (result.review) await this.propose(result.review);
		return result;
	}

	/** Called after a turn that used tools. Returns a note to steer with, proposals are already submitted. */
	async reviewTurn(): Promise<(ReviewResult & { note?: string }) | undefined> {
		const r = this.d.config.review;
		this.turnsSinceReview++;
		this.turnsSinceNote++;
		if (!r.enabled || this.turnsSinceReview < r.everyTurns) return undefined;
		this.turnsSinceReview = 0;
		return this.serial(async () => {
			const { delta, lastId, raw, sent } = await this.pending();
			if (!raw.includes("\n")) return undefined;
			const goal = this.state ? goalCheck(this.state) : undefined;
			const reply = await this.askWithTimeout(`${delta}${goal ? `\n\n${goal}` : ""}\n\n### Task\nReview the session so far. Report claims you can settle, a note if the session is off course, and proposals.`, r.timeoutMs);
			if (reply === undefined) return undefined;
			this.cursor = lastId;
			sent();
			const review = parseReview(reply);
			if (!review) return undefined;
			const submitted = await this.propose(review);
			let note = review.note;
			if (note && (!r.steer || this.turnsSinceNote < r.immuneTurns || this.notesThisRun >= r.maxNotesPerRun)) note = undefined;
			if (note) {
				this.notesThisRun++;
				this.turnsSinceNote = 0;
			}
			return { review, submitted, ...(note && { note }) };
		});
	}

	/** Reads the ideas state without asking the model and says what changed since the last poll: tasks closed, owner notes added. */
	async poll(): Promise<StateChanges | undefined> {
		const state = await this.readState();
		return state ? this.watch.update(state) : undefined;
	}

	/** The open tasks last seen, to keep across a process restart. */
	watchSnapshot(): WatchSnapshot | undefined {
		return this.watch.snapshot();
	}

	restoreWatch(snapshot: WatchSnapshot): void {
		this.watch.restore(snapshot);
	}

	newRun(): void {
		this.notesThisRun = 0;
	}

	private async askWithTimeout(prompt: string, ms: number): Promise<string | undefined> {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), ms);
		try {
			return await this.ctx.ask(prompt, ctl.signal);
		} finally {
			clearTimeout(timer);
		}
	}

	private async propose(review: Review): Promise<Submitted[]> {
		const p = this.d.config.proposals;
		if (!p.enabled || review.proposals.length === 0) return [];
		const intentId = this.state?.intent?.id;
		return submit(review.proposals, { exec: this.d.exec, sandy: this.d.sandy, ...(this.d.threadId && { threadId: this.d.threadId }), seen: this.seen, max: p.maxPerSession, project: p.taskProject, ...(intentId && { intentId }) });
	}

	/** The assistant text of a message, for the gate. */
	static answerOf(m: Msg): string {
		return textOf(m);
	}
	static isFinal(m: Msg): boolean {
		return m.role === "assistant" && m.stopReason === "stop" && !(Array.isArray(m.content) && m.content.some((b: Block) => b.type === "toolCall"));
	}
}
