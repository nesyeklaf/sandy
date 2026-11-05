import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionBeforeCompactEvent,
	SessionBoundaryDraft,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ContextConfig } from "../core/config.ts";
import { capShadowRecord } from "../core/cap-record.ts";
import { type CappedPlan, type CutDecision, type CutFrame, type CutPlan, cappedPlan, planCut } from "../core/cut.ts";
import { type DuplicatePromotion, duplicateReadEdits, promotionsFromKept } from "../core/duplicates.ts";
import { notebookReminder } from "../core/guidance.ts";
import { CAP_SHADOW_KIND, CUT_DETAILS_KEY, DUPLICATE_KIND, REMINDER_KIND, TASK_DONE_KIND } from "../core/kinds.ts";
import {
	boundaryCut,
	type CacheTier,
	cacheTtlMs,
	type CutEnvelope,
	type CutThresholds,
	cutFrees,
	cutThresholds,
	envelopeHolds,
	nativeLimit,
	notebookReminderDue,
	PI_RESERVE,
	promptCut,
} from "../core/policy.ts";
import { estimateBudget, estimateTokens, PROVIDER_TOKENS_PER_ESTIMATE } from "../core/tokens.ts";
import { type SessionProjector, SessionTape } from "./session.ts";

/** What a boundary handler returns to pi: the drafts of the handlers before us, maybe with ours appended. */
export type BoundaryOutcome = { readonly entries: SessionBoundaryDraft[] } | undefined;

/** Where a cut happened: between two requests of a run, before a prompt, or for pi's own compaction. */
export type CutPosition = "run" | "prompt" | "pi";

export interface CutControllerDeps {
	readonly config: ContextConfig;
	readonly pi: ExtensionAPI;
	readonly project: SessionProjector;
	readonly now: () => number;
	readonly tier: () => CacheTier;
	/** Appends one record to the ledger file. */
	readonly ledger: (record: Record<string, unknown>) => void;
	/** Tells the user about a size problem, once per session and kind. */
	readonly report: (ctx: ExtensionContext, kind: string, text: string) => void;
	/** Whether the agent can write its notebook in the current run; reminders are pointless otherwise. */
	readonly notebookAvailable: () => boolean;
	/** Another extension also compacts the session; a stale checkpoint of it is carried, never replaced. */
	readonly competing: () => boolean;
	/**
	 * In mode "on": why the probe evidence does not cover the session's model, none when it does. A cut then keeps the
	 * baseline start and plans the cap in shadow only. Read when a cut is decided, so a record that changed or a model
	 * that was switched is seen.
	 */
	readonly capEvidence: (ctx: ExtensionContext) => string | undefined;
}

/** A committed cut's expectation, checked against the first request that carries the cut. */
interface Expectation {
	readonly key: string;
	readonly reason: string;
	readonly expected: number;
	readonly before: number | undefined;
	readonly limit: number | undefined;
	readonly hard: number;
}

export const SIZE_ADVICE =
	"raise watermarkTokens, or lower keepRecentTokens, maskedTokens, pinnedUserTokens or summaryTokens";

const count = (value: number) => `~${Math.round(value).toLocaleString("en-US")}`;

/**
 * The room pi keeps for the answer in this session, resolved as pi resolves it: the model's override, then the
 * setting, then pi's default.
 */
function reserveFor(pi: ExtensionAPI, model: ExtensionContext["model"]): number {
	type Compaction = { reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number } | undefined> };
	const settings = typeof pi.getSettings === "function" ? (pi.getSettings() as { compaction?: Compaction }) : undefined;
	const compaction = settings?.compaction;
	const override = model ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens : undefined;
	return override ?? compaction?.reserveTokens ?? PI_RESERVE;
}

/**
 * The system prompt and the declarations of the active tools as the provider receives them, estimated from their
 * text. An estimate: what the provider counts is reconciled after the cut.
 */
function fixedTokens(pi: ExtensionAPI, ctx: ExtensionContext): number {
	const system = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	const active = typeof pi.getActiveTools === "function" ? new Set(pi.getActiveTools()) : new Set<string>();
	const declared = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	const tools = declared
		.filter((tool) => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
	return Math.ceil((estimateTokens(system) + estimateTokens(JSON.stringify(tools))) * PROVIDER_TOKENS_PER_ESTIMATE);
}

/**
 * A cut decided: the baseline cut, and the cut with the kept-history cap planned beside it when the cap is not off and
 * the baseline is ready. `cut` is what is made: the baseline, except in mode "on" where a ready capped candidate
 * replaces it. The cap never turns a refused cut into a made one: it is planned only for a ready baseline.
 */
interface Decided {
	readonly baseline: CutDecision;
	readonly capped: CappedPlan | undefined;
	readonly cut: CutDecision;
	/**
	 * Whether the baseline and the capped cut were sized with the notes they give their text back, and so make those
	 * promotions. Only a boundary that can edit (our own turn-end cut) sizes them; a cut that misses its limit with them
	 * is made without, and its notes stay notes.
	 */
	readonly promotes?: { readonly baseline: boolean; readonly capped: boolean };
}

/** The notes a cut that keeps from entry `keptFromId` gives their text back, as the estimated tokens each adds to its entry. */
type Promote = (keptFromId: string) => ReadonlyMap<string, number>;

/**
 * A cut planned with the promotions it makes itself. The promoted text can move where the cut keeps from, and with it
 * which notes it promotes, so the cut is planned again on the history after them until the promotions stay the same,
 * at most three times. Undefined when they do not settle or the cut planned with them has no plan: it is made without.
 */
function withPromotions<T>(plan: (promoted: ReadonlyMap<string, number>) => T, keptFromOf: (one: T) => string | undefined, promote: Promote, first: T): T | undefined {
	let result = first;
	let promoted: ReadonlyMap<string, number> = new Map();
	for (let round = 0; round < 3; round++) {
		const made = keptFromOf(result);
		if (!made) return undefined;
		const next = promote(made);
		if (next.size === promoted.size && [...next.keys()].every((id) => promoted.has(id))) return result;
		promoted = next;
		result = plan(next);
	}
	return undefined;
}

function compactionDraft(plan: CutPlan): SessionBoundaryDraft {
	return {
		type: "compaction",
		summary: plan.text,
		firstKeptEntryId: plan.firstKeptEntryId,
		details: { [CUT_DETAILS_KEY]: plan.details },
	};
}

/**
 * The one owner of cuts: the cut intent (pending reason, task requests, the prompt's reason), the drafts our boundary
 * handlers add, and the expectation of the latest cut. Planning stays pure in core; only this controller turns a
 * {@link CutDecision} into pi drafts and results. Branch state is read from the session tape, never rebuilt here.
 */
export class CutController {
	private readonly deps: CutControllerDeps;
	/** Reason for the cache break the next request will show. */
	private pendingCut: string | undefined;
	private pendingPosition: CutPosition | undefined;
	/** Reason for the compaction the input handler is waiting for. */
	private promptReason: "watermark" | "cold" | "model" | "task" | undefined;
	/** A task finished since the last cut chance; the next one cuts if the context is large enough. */
	private taskDone = false;
	/** The latest committed cut, until the first request carrying it reconciles it. */
	private expectation: Expectation | undefined;
	/** The reason of the cut our compaction handler proposed in the current attempt; each attempt starts without one. */
	private proposal: string | undefined;
	/** The cut the latest reconciliation refuted. */
	private failedKey: string | undefined;

	constructor(deps: CutControllerDeps) {
		this.deps = deps;
	}

	private tapeOf(ctx: ExtensionContext): SessionTape {
		return SessionTape.read(ctx.sessionManager.getBranch(), this.deps.project, this.deps.config);
	}

	/** Resets the cut intent for a session; a finished task recorded in the log survives a restart. */
	start(ctx: ExtensionContext): void {
		this.pendingCut = undefined;
		this.pendingPosition = undefined;
		this.promptReason = undefined;
		this.expectation = undefined;
		this.proposal = undefined;
		this.failedKey = undefined;
		this.taskDone = this.tapeOf(ctx).state.taskCutPending;
	}

	/** Moving in the tree breaks the cache; the task intent and expectations are those of the new branch. */
	tree(ctx: ExtensionContext): void {
		this.pendingCut ??= "branch";
		this.expectation = undefined;
		this.failedKey = undefined;
		this.taskDone = this.tapeOf(ctx).state.taskCutPending;
	}

	/** A finished task asks for a cut at the next chance; kept in the log, since under SANDY a new process may take it. */
	requestTask(data: unknown): void {
		this.taskDone = true;
		this.deps.pi.appendEntry(TASK_DONE_KIND, data ?? {});
	}

	envelope(ctx: ExtensionContext): CutEnvelope {
		return {
			fixedTokens: fixedTokens(this.deps.pi, ctx),
			reserveTokens: reserveFor(this.deps.pi, ctx.model),
			contextWindow: ctx.model?.contextWindow,
		};
	}

	thresholds(ctx: ExtensionContext): CutThresholds {
		return cutThresholds(this.deps.config, ctx.model?.contextWindow, reserveFor(this.deps.pi, ctx.model));
	}

	/**
	 * The reason of the cut proposed in the compaction attempt that just ended, if any, and forgets it. Not the previous
	 * cut's expectation, which lives on until a request reconciles it: an attempt that proposed nothing reads undefined.
	 */
	takeProposal(): string | undefined {
		const proposal = this.proposal;
		this.proposal = undefined;
		return proposal;
	}

	/** The cut the next request will show as planned, and where it happened. */
	pending(): { readonly reason: string | undefined; readonly position: CutPosition | undefined } {
		return { reason: this.pendingCut, position: this.pendingPosition };
	}

	/**
	 * The provider accepted a request after the pending cut. `prompt` is its prompt when it was the planned request,
	 * undefined otherwise; it reconciles the latest cut's expectation. A cut whose real prompt would not have been
	 * accepted is remembered, and the identical cut is not made again.
	 */
	settled(ctx: ExtensionContext, prompt: number | undefined): void {
		const reason = this.pendingCut;
		this.pendingCut = undefined;
		this.pendingPosition = undefined;
		if (prompt === undefined) return;
		const expectation = this.expectation;
		this.expectation = undefined;
		if (expectation) {
			const before = expectation.before ?? prompt;
			const limit = expectation.limit ?? before;
			const hard = expectation.limit === undefined ? Number.POSITIVE_INFINITY : expectation.hard;
			const failed = !cutFrees(prompt, before, limit, hard);
			this.failedKey = failed ? expectation.key : undefined;
			this.deps.ledger({
				t: new Date(this.deps.now()).toISOString(),
				class: "cut-reconciled",
				reason: expectation.reason,
				estimated: Math.round(expectation.expected),
				prompt,
				miss: Math.round(prompt - expectation.expected),
				...(failed ? { failed: true } : {}),
			});
		}
		const soft = this.thresholds(ctx).soft;
		if (prompt >= soft) {
			this.deps.report(
				ctx,
				"oversized",
				`context: after a ${reason ?? "planned"} cut the prompt is ~${prompt.toLocaleString("en-US")} tokens, at or above the watermark ${soft.toLocaleString("en-US")}. Watermark cuts are refused until the hard threshold; ${SIZE_ADVICE}.`,
			);
		}
	}

	/** Whether a finished task asks for a cut at this chance; the request is used up either way. */
	private taskCut(tokens: number | undefined): boolean {
		const due = this.taskDone && tokens !== undefined && tokens >= this.deps.config.taskCutMinTokens;
		this.taskDone = false;
		return due;
	}

	/**
	 * Decides the cut for `reason` from the tape, and logs and reports a cut that is not made: one that misses its
	 * limit, repeats a refuted cut, or does not fit below pi's own compaction. `promote` names the notes a ready cut
	 * would give their text back, the baseline's and the capped one's each; a cut is planned on the history after them
	 * when it is still ready so (`promotes`), and is made without them otherwise.
	 */
	private decide(
		ctx: ExtensionContext,
		tape: SessionTape,
		reason: string,
		tokens: number | undefined,
		limit: number | undefined,
		hard: number,
		promote?: Promote,
	): Decided {
		const history = tape.history();
		const envelope = this.envelope(ctx);
		// A competitor keeps its checkpoint whatever our summary covers, so its sources are not read for the answer.
		const competing = this.deps.competing();
		const frame: CutFrame = {
			entries: history.entries,
			minKeptIndex: history.minKeptIndex,
			visibleFromIndex: history.visibleFromIndex,
			summary: history.summary,
			checkpoint: history.checkpoint,
			checkpointSuperseded: !competing && history.checkpointSuperseded,
			competing,
			notebook: history.notebook,
			config: this.deps.config,
			reason,
			contextTokens: tokens,
			visibleTokens: tape.modelView().tokens,
			limit,
			hard,
			...(this.failedKey ? { failedKey: this.failedKey } : {}),
		};
		const decision = planCut(frame, envelope);
		if (decision.kind === "ready" && promote) {
			const settled = withPromotions((promoted) => planCut({ ...frame, promoted }, envelope), (one) => (one.kind === "disabled" ? undefined : one.plan.details.keptFromId), promote, decision);
			if (settled?.kind === "ready") return this.withCap(ctx, frame, envelope, decision, settled, promote, true);
			return this.withCap(ctx, frame, envelope, decision, decision, promote, false);
		}
		if (decision.kind === "ready") return this.withCap(ctx, frame, envelope, decision, decision);
		if (decision.kind === "disabled" && decision.why === "empty") return { baseline: decision, capped: undefined, cut: decision };
		const why = decision.why;
		const expected = Math.round(decision.expected ?? 0);
		this.deps.ledger({
			t: new Date(this.deps.now()).toISOString(),
			class: decision.kind === "disabled" ? "cut-disabled" : "cut-refused",
			why,
			reason,
			tokens,
			limit,
			projected: expected,
			hard,
			fixed: envelope.fixedTokens,
			reserve: envelope.reserveTokens,
		});
		const fixedNote = envelopeHolds(this.deps.config, envelope, limit ?? nativeLimit(envelope))
			? ""
			: ` The system prompt and tools alone take an estimated ${count(envelope.fixedTokens)}.`;
		const text =
			why === "no-room"
				? `context: a ${reason} cut would leave an estimated ${count(expected)} tokens with system prompt and tools, not below pi's own compaction at ${count(nativeLimit(envelope))}; pi compacts on its own.${fixedNote}`
				: why === "repeat"
					? `context: the last ${reason} cut left more than estimated, and the same cut would again; it waits for more history to archive.`
					: tokens !== undefined && tokens < hard
						? `context: a ${reason} cut would leave an estimated ${count(expected)} tokens, not below ${count(limit ?? tokens)}, so it waits until the prompt reaches ${count(hard)}. To cut at the watermark, ${SIZE_ADVICE}.${fixedNote}`
						: `context: at ${count(tokens ?? 0)} tokens a ${reason} cut would free too little (to an estimated ${count(expected)}). The prompt keeps growing; ${SIZE_ADVICE}.${fixedNote}`;
		this.deps.report(ctx, why === "short" ? "refused" : why, text);
		return { baseline: decision, capped: undefined, cut: decision };
	}

	/**
	 * The cap beside a ready baseline: planned in shadow and in "on", used for the cut only in "on" and only while the
	 * probe evidence covers the session's model. `plain` is the baseline planned on the frame as it is, `baseline` the
	 * one planned with its promotions. The cut from the capped start is planned only when it will be used; a shadow
	 * records the removal alone, planned on the same history and promotions as the cut would be.
	 */
	private withCap(
		ctx: ExtensionContext,
		frame: CutFrame,
		envelope: CutEnvelope,
		plain: Extract<CutDecision, { kind: "ready" }>,
		baseline: Extract<CutDecision, { kind: "ready" }>,
		promote?: Promote,
		baselinePromotes = false,
	): Decided {
		const { keptCap } = this.deps.config;
		if (keptCap.mode === "off") return { baseline, capped: undefined, cut: baseline, promotes: { baseline: baselinePromotes, capped: false } };
		const budget = estimateBudget(keptCap.tokens);
		const decide = keptCap.mode === "on" && this.deps.capEvidence(ctx) === undefined;
		let capped = cappedPlan(frame, envelope, budget, { baseline: plain, decide });
		let cappedPromotes = false;
		// The capped start archives more than the baseline, so it may give more notes their text back, and the text it
		// gives back lands in the range the cap bounds: the cap is planned on the history after its own promotions.
		if (promote && capped.kind === "candidate") {
			const first = capped;
			const keptFromOf = (one: CappedPlan) => (one.kind !== "candidate" ? undefined : one.decision ? one.decision.plan.details.keptFromId : one.removal.cappedFromId);
			const settled = withPromotions((promoted) => cappedPlan({ ...frame, promoted }, envelope, budget, { decide }), keptFromOf, promote, first);
			if (settled?.kind === "candidate" && (settled.decision?.kind === "ready" || first.decision?.kind !== "ready")) {
				capped = settled;
				cappedPromotes = true;
			}
		}
		const cut = decide && capped.kind === "candidate" && capped.decision?.kind === "ready" ? capped.decision : baseline;
		return { baseline, capped, cut, promotes: { baseline: baselinePromotes, capped: cappedPromotes } };
	}

	/**
	 * The record of what the cap does at this cut, none when it was not planned or the baseline has no cut to cap.
	 * `promotions` are the notes the capped cut gives their text back beyond those the baseline gives back, both as
	 * that boundary makes them: none at a compaction pi starts, which promotes nothing.
	 */
	private capRecord(decided: Decided, reason: string, promotions: number): SessionBoundaryDraft | undefined {
		const { capped, baseline } = decided;
		const { keptCap } = this.deps.config;
		if (!capped || baseline.kind !== "ready" || keptCap.mode === "off" || (capped.kind === "deferral" && capped.why === "no-cut")) return undefined;
		const candidate = capped.kind === "candidate" ? capped : undefined;
		const record = capShadowRecord({
			mode: keptCap.mode,
			applied: keptCap.mode === "on" && decided.cut !== baseline,
			reason,
			capTokens: keptCap.tokens,
			keptFromId: baseline.plan.firstKeptEntryId,
			...(candidate ? { removal: candidate.removal } : {}),
			...(capped.kind === "deferral" && capped.why !== "no-cut" ? { deferral: capped.why } : {}),
			promotions,
		});
		return { type: "custom", customType: CAP_SHADOW_KIND, data: record };
	}

	private commit(
		decision: Extract<CutDecision, { kind: "ready" }>,
		reason: string,
		position: CutPosition,
		tokens: number | undefined,
		limit: number | undefined,
		hard: number,
	): void {
		this.pendingCut = reason;
		this.pendingPosition = position;
		this.taskDone = false;
		this.expectation = { key: decision.key, reason, expected: decision.expected, before: tokens, limit, hard };
	}

	/** The entries of the history a cut takes out of the model's context. */
	private archivedBy(tape: SessionTape, plan: CutPlan | undefined): ReadonlySet<string> {
		const archived = new Set<string>();
		if (!plan) return archived;
		const { entries } = tape.history();
		const keptAt = entries.findIndex((entry) => entry.id === plan.details.keptFromId);
		for (const entry of entries.slice(0, keptAt < 0 ? entries.length : keptAt)) archived.add(entry.id);
		return archived;
	}

	/**
	 * The notes our cut gives their text back: one per text whose whole copies the cut all takes away. Only at our own
	 * cut, which breaks the cached prefix anyway; a note stays true without it, since it names the entry history_read
	 * opens, so no other boundary edits an earlier result for it.
	 */
	private promotionsFor(tape: SessionTape, keptFromId: string): DuplicatePromotion[] {
		const { reads, aliases } = tape.duplicates();
		if (aliases.size === 0) return [];
		// Only the history the cut keeps matters, read from the newest entry back to where the cut keeps from.
		const { entries } = tape.history();
		const kept = new Set<string>();
		for (let i = entries.length - 1; i >= 0; i--) {
			const id = (entries[i] as { id: string }).id;
			kept.add(id);
			if (id === keptFromId) return promotionsFromKept(reads, aliases, (read) => kept.has(read));
		}
		return [];
	}

	/**
	 * What a boundary does about repeated reads: the fresh result of a read the model already holds, unchanged, is
	 * replaced by a note, and the notes {@link promotionsFor} our cut names get their text back. Context edits, each new
	 * note followed by its ownership record. Only results no request has carried yet are collapsed, so the prefix the
	 * provider has cached stays byte for byte as it was. Nothing is made of or for an entry the cut archives. A turn
	 * that read nothing and makes no cut does not project the branch for this.
	 */
	private duplicateDrafts(
		event: TurnEndEvent,
		tape: SessionTape,
		plan: CutPlan | undefined,
		promotions: readonly DuplicatePromotion[],
	): SessionBoundaryDraft[] {
		const results = event.toolResults ?? [];
		const freshRead = results.some((result) => (result as { toolName?: string }).toolName === "read");
		if (!freshRead && promotions.length === 0) return [];
		const fresh = new Set(results.map((result) => result.toolCallId));
		const collapses = freshRead ? duplicateReadEdits({ reads: tape.duplicates().reads, fresh, archived: this.archivedBy(tape, plan) }) : [];
		return [
			...promotions.map((one): SessionBoundaryDraft => ({ type: "context_edit", targetId: one.targetId, replacement: one.replacement as never })),
			...collapses.flatMap((one): SessionBoundaryDraft[] => [
				{ type: "context_edit", targetId: one.targetId, replacement: one.replacement as never },
				{ type: "custom", customType: DUPLICATE_KIND, data: one.record },
			]),
		];
	}

	/**
	 * Planned cut between two requests of a run: at the hard threshold, at the soft one when no user prompt will come
	 * to cut at (no UI, or the next prompt is already queued), or after a finished task. Before that, a notebook
	 * reminder. Drafts of handlers that ran before us stay first and unchanged, and their context edits count as made;
	 * a turn that did not complete, or one that already carries a compaction, gets nothing from us. Repeated reads
	 * ({@link duplicateDrafts}) come before the cut, which is planned from the branch as the earlier drafts leave it.
	 */
	finishTurn(event: TurnEndEvent, ctx: ExtensionContext, tokens: number, thresholds: CutThresholds): BoundaryOutcome {
		if (event.outcome !== "completed" || event.entries.some((entry) => entry.type === "compaction")) return undefined;
		const deferToPrompt = ctx.hasUI && !ctx.hasPendingMessages();
		const task = this.taskCut(tokens);
		const reason = boundaryCut(tokens, thresholds, deferToPrompt) ? "watermark" : task ? "task" : undefined;
		// pi commits the earlier drafts with ours, so the cut is planned from the branch with their context edits applied.
		// Their other drafts get ids only when pi commits them and land after every persisted entry, inside the kept
		// range: the plan must not name them, so it does not read them.
		const edits = event.entries.filter((entry) => entry.type === "context_edit");
		const tape = SessionTape.readAtBoundary(ctx.sessionManager.getBranch(), edits, this.deps.project, this.deps.config);
		const appended: SessionBoundaryDraft[] = [];
		if (reason) {
			const limit = reason === "watermark" ? thresholds.soft : tokens;
			// Notes the cut gives their text back count in its size; a cut that misses its limit with them is made without.
			const decided = this.decide(ctx, tape, reason, tokens, limit, thresholds.hard, (keptFromId) => new Map(this.promotionsFor(tape, keptFromId).map((one) => [one.targetId, one.tokens])));
			const decision = decided.cut;
			if (decision.kind !== "ready") return undefined;
			const { baseline, capped, promotes } = decided;
			const made = promotes?.baseline && baseline.kind === "ready" ? this.promotionsFor(tape, baseline.plan.details.keptFromId) : [];
			// A shadow plans no cut from the capped start, so its promotions are those of the removal's start.
			const cappedFrom = capped?.kind !== "candidate" ? undefined : capped.decision ? (capped.decision.kind === "ready" ? capped.decision.plan.details.keptFromId : undefined) : capped.removal.cappedFromId;
			const cappedMade = promotes?.capped && cappedFrom ? this.promotionsFor(tape, cappedFrom) : [];
			const promotions = decision === baseline ? made : cappedMade;
			this.commit(decision, reason, "run", tokens, limit, thresholds.hard);
			const record = this.capRecord(decided, reason, Math.max(0, cappedMade.length - made.length));
			appended.push(...this.duplicateDrafts(event, tape, decision.plan, promotions), compactionDraft(decision.plan), ...(record ? [record] : []));
		} else {
			appended.push(...this.duplicateDrafts(event, tape, undefined, []));
			const reminder = this.reminder(tape, tokens, thresholds);
			if (reminder) appended.push(reminder);
		}
		return appended.length > 0 ? { entries: [...event.entries, ...appended] } : undefined;
	}

	/** The notebook reminder, when the agent can write its notebook and the prompt nears the watermark without one. */
	private reminder(tape: SessionTape, tokens: number, thresholds: CutThresholds): SessionBoundaryDraft | undefined {
		if (!this.deps.notebookAvailable()) return undefined;
		const { state } = tape;
		const due = notebookReminderDue({
			contextTokens: tokens,
			watermark: thresholds.soft,
			at: this.deps.config.notebookReminderAt,
			notebookCurrent: state.notebookCurrent,
			reminded: state.reminded,
		});
		if (!due) return undefined;
		return {
			type: "custom_message",
			customType: REMINDER_KIND,
			content: notebookReminder(
				Math.max(0, (tokens >= thresholds.soft ? thresholds.hard : thresholds.soft) - tokens),
				(state.notebook ?? "") === "",
			),
			display: false,
		};
	}

	/** Before a new prompt: use a cache that is lost anyway (expired, or another model), or a finished task, for a cut. */
	async input(event: InputEvent, ctx: ExtensionContext): Promise<{ action: "continue" }> {
		if (event.streamingBehavior !== undefined || !ctx.isIdle()) return { action: "continue" };
		const tape = this.tapeOf(ctx);
		const { state } = tape;
		if (state.endsWithCompaction) return { action: "continue" };
		const tokens = ctx.getContextUsage()?.tokens ?? undefined;
		const { soft, hard } = this.thresholds(ctx);
		const prompt = promptCut({
			contextTokens: tokens,
			now: this.deps.now(),
			lastCacheTouch: state.lastCacheTouch,
			ttlMs: cacheTtlMs(this.deps.config, ctx.model, this.deps.tier()),
			modelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			lastModelKey: state.lastModelKey,
			minTokens: this.deps.config.coldCutMinTokens,
			soft,
		});
		const task = this.taskCut(tokens);
		const reason = prompt ?? (task ? "task" : undefined);
		if (!reason) return { action: "continue" };
		const limit = reason === "watermark" ? soft : tokens;
		if (this.decide(ctx, tape, reason, tokens, limit, hard).cut.kind !== "ready") return { action: "continue" };
		this.promptReason = reason;
		await new Promise<void>((resolve) => {
			ctx.compact({
				onComplete: () => resolve(),
				onError: () => {
					this.promptReason = undefined;
					resolve();
				},
			});
		});
		return { action: "continue" };
	}

	/**
	 * Every compaction pi starts (threshold, overflow, /compact, or ours before a prompt) becomes our cut, instantly,
	 * when it frees headroom below pi's own compaction. Otherwise, and for a cut the last request refuted, we return
	 * nothing, never an empty result: another handler's result or pi's native compaction stays in effect.
	 */
	beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
		const position: CutPosition = event.reason === "manual" && this.promptReason ? "prompt" : "pi";
		const reason = event.reason === "manual" ? (this.promptReason ?? "manual") : event.reason;
		this.promptReason = undefined;
		this.proposal = undefined;
		const tokens = event.preparation.tokensBefore;
		const { hard } = this.thresholds(ctx);
		const tape = SessionTape.read(event.branchEntries, this.deps.project, this.deps.config);
		const decided = this.decide(ctx, tape, reason, tokens, undefined, hard);
		const decision = decided.cut;
		if (decision.kind !== "ready") return undefined;
		this.commit(decision, reason, position, tokens, undefined, hard);
		// A compaction handler returns a result, not drafts: the record is appended beside it, before the compaction entry.
		// No promotion here: the request after this cut caches the prefix it leaves, and a note stays true without one.
		const record = this.capRecord(decided, reason, 0);
		if (record?.type === "custom") this.deps.pi.appendEntry(record.customType, record.data);
		this.proposal = reason;
		const { plan } = decision;
		return {
			compaction: {
				summary: plan.text,
				firstKeptEntryId: plan.firstKeptEntryId,
				tokensBefore: tokens,
				details: { [CUT_DETAILS_KEY]: plan.details },
			},
		};
	}

	compactFailed(): void {
		this.pendingCut = undefined;
		this.pendingPosition = undefined;
		this.promptReason = undefined;
		this.expectation = undefined;
		this.proposal = undefined;
	}
}
