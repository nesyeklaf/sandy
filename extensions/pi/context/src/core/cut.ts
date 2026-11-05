import type { ContextConfig } from "./config.ts";
import { type CutEnvelope, cutFrees, expectedTokens, nativeLimit } from "./policy.ts";
import { CUT_TAG_NAME } from "./kinds.ts";
import { type CapRemoval, capRemoval } from "./kept-cap.ts";
import { pathOf } from "./messages.ts";
import { clip, formatTime, renderMasked } from "./serialize.ts";
import { SkillsFold, withoutSkillBodies } from "./skills.ts";
import { renderSummary, type SummaryState } from "./summary.ts";
import { estimateBudget, estimateTokens } from "./tokens.ts";
import type { ForeignCheckpoint, LogEntry } from "./types.ts";

/**
 * A cut moves older history out of the model context in one step, at a moment the prompt
 * cache is lost anyway or at the planned watermark. It is computed from the log alone and
 * needs no model call, so it never makes the user wait.
 *
 * After a cut the model sees, in this order: its notebook, the skills it loaded in the archived
 * history, earlier user messages verbatim, the summary of another compaction verbatim, the anchored summary, the files it
 * touched, a masked transcript of the most recent
 * archived turns, and then the newest history unchanged.
 */
export interface CutFoldInput {
	readonly config: ContextConfig;
	/** Why the cut happens: a lowercase word, written in the opening tag. */
	readonly reason: string;
	/**
	 * Entry the kept history starts at, chosen by the caller. Without it the fold chooses: about
	 * keepRecentTokens of the newest history, starting at a message, never before the latest compaction.
	 */
	readonly keptFromId?: string;
	/** Entry the model sees verbatim first now. Keeping from it or from an older entry archives nothing new. */
	readonly visibleFromId?: string;
	/** The latest summary; the fold masks and reports a gap only for history newer than its anchor. */
	readonly summary?: SummaryState;
	/** The latest notebook, carried verbatim. */
	readonly notebook?: string;
	/**
	 * The summary of a compaction that is not ours, carried verbatim: the model sees only the newest compaction, so a
	 * cut that left it out would drop it.
	 */
	readonly checkpoint?: ForeignCheckpoint;
	/** Our summary covers everything the stale `checkpoint` summarized and stands in for it (see EffectiveHistory). */
	readonly checkpointSuperseded?: boolean;
	/** Another extension also compacts the session: its checkpoint is carried, never replaced. */
	readonly competing?: boolean;
}

/** A cut planned from the whole log at once, as an adapter that holds it in memory does. */
export interface CutInput extends Omit<CutFoldInput, "visibleFromId"> {
	readonly entries: readonly LogEntry[];
	/** Lowest index the kept range may start at: the first entry after the latest compaction. */
	readonly minKeptIndex: number;
	/** Index where the history currently visible verbatim starts. */
	readonly visibleFromIndex: number;
}

export interface CutDetails {
	readonly version: 1;
	readonly reason: string;
	readonly keptFromId: string;
	readonly maskedFromId?: string;
	readonly summaryThroughId?: string;
	readonly unsummarized?: { readonly fromId: string; readonly toId: string; readonly entries: number };
	readonly archivedEntries: number;
	readonly blockTokens: number;
}

export interface CutPlan {
	readonly firstKeptEntryId: string;
	readonly text: string;
	readonly details: CutDetails;
}

export interface FileLists {
	readonly modified: string[];
	readonly read: string[];
}

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PINNED_MESSAGE_CHARS = 1_500;
/** A cut reason, a lowercase word; it is read back from the cut's tag by `cutReason` in records.ts. */
export const REASON_WORD = "[a-z][a-z-]{0,31}";
const REASON = new RegExp(`^${REASON_WORD}$`);

const INTRO = [
	"This session keeps going indefinitely. Older history has left your context, but the session log keeps all of it, unchanged and searchable: history_search finds entries by keywords (identifiers, paths and error text work best), history_read returns one entry in full.",
	"Below is what you carry forward. When you need a detail that is not here, search for it instead of guessing.",
].join("\n");

/** Folds a cut from the whole log: the log fed to a {@link CutFold} newest first. Whether to make it is {@link planCut}'s call. */
export function foldCut(input: CutInput): CutPlan | undefined {
	const { entries, minKeptIndex } = input;
	const fold = new CutFold({ ...input, visibleFromId: entries[input.visibleFromIndex]?.id });
	fold.add(entries.slice(minKeptIndex).reverse());
	if (minKeptIndex > 0) {
		fold.compaction();
		fold.add(entries.slice(0, minKeptIndex).reverse());
	}
	return fold.finish();
}

/** A cut asked for at one boundary: the log, what the provider last counted, and the limit the cut must reach. */
export interface CutFrame extends CutInput {
	/** The prompt as the provider last counted it; undefined before the first answer or right after a compaction. */
	readonly contextTokens: number | undefined;
	/** Estimated tokens of what the prompt holds from the log. */
	readonly visibleTokens: number;
	/** The prompt the cut must get below; undefined when only the headroom below pi's own compaction counts. */
	readonly limit: number | undefined;
	/** From here a cut that misses the limit is still made when it frees a quarter of the prompt. */
	readonly hard: number;
	/** Key of a cut whose expectation the next request already refuted; the identical cut is not made again. */
	readonly failedKey?: string;
	/**
	 * Estimated tokens the boundary adds to entries with the cut, by entry id: repeated-read notes made whole again.
	 * The cut is planned on the history as it is after those edits; what the prompt holds now stays as counted.
	 */
	readonly promoted?: ReadonlyMap<string, number>;
}

/** The frame's entries from index `from` on, as they are once the boundary's promotions are made. */
function promotedEntries(frame: CutFrame, from = 0): readonly LogEntry[] {
	const { promoted } = frame;
	if (!promoted || promoted.size === 0) return from === 0 ? frame.entries : frame.entries.slice(from);
	return frame.entries.slice(from).map((entry) => {
		const extra = promoted.get(entry.id);
		return extra ? { ...entry, tokens: entry.tokens + extra } : entry;
	});
}

/**
 * Whether to cut. `ready` carries the plan. `defer` waits for a later boundary: the cut misses its limit (`short`), or
 * it is the cut that already failed (`repeat`). `disabled` leaves the prompt to pi: there is nothing to archive
 * (`empty`), or what the cut keeps, with system prompt, tools and pi's reserve, does not fit below pi's own compaction
 * (`no-room`), as with a foreign checkpoint larger than the headroom. `expected` is an estimate, never a provider count.
 */
export type CutDecision =
	| { readonly kind: "ready"; readonly plan: CutPlan; readonly expected: number; readonly key: string }
	| {
			readonly kind: "defer";
			readonly why: "short" | "repeat";
			readonly plan: CutPlan;
			readonly expected: number;
			readonly key: string;
	  }
	| { readonly kind: "disabled"; readonly why: "empty" | "no-room"; readonly expected?: number };

/** Identifies a cut by what it keeps and carries: the same key is the same cut with the same expectation. */
export function cutKey(plan: CutPlan): string {
	return `${plan.firstKeptEntryId}:${plan.details.blockTokens}`;
}

/** Decides a cut from the log alone, without a model call, in the envelope the next request carries. */
export function planCut(frame: CutFrame, envelope: CutEnvelope): CutDecision {
	const promoted = promotedEntries(frame);
	const plan = foldCut({ ...frame, entries: promoted });
	if (!plan) return { kind: "disabled", why: "empty" };
	const { entries, visibleFromIndex } = frame;
	const keptIndex = entries.findIndex((entry) => entry.id === plan.firstKeptEntryId);
	const sum = (from: number, to?: number) => entries.slice(from, to).reduce((total, entry) => total + entry.tokens, 0);
	// What the promotions add to the history the cut keeps: the prompt does not hold it yet, so it counts as carried.
	const restored = keptIndex < 0 ? 0 : promoted.slice(keptIndex).reduce((total, entry, i) => total + entry.tokens - (entries[keptIndex + i] as LogEntry).tokens, 0);
	const expected = expectedTokens(
		{
			contextTokens: frame.contextTokens,
			visibleTokens: frame.visibleTokens,
			archivedTokens: keptIndex < 0 ? 0 : sum(visibleFromIndex, keptIndex),
			blockTokens: plan.details.blockTokens + restored,
			keptTokens: keptIndex < 0 ? 0 : sum(keptIndex),
		},
		envelope,
	);
	if (expected >= nativeLimit(envelope)) return { kind: "disabled", why: "no-room", expected };
	const key = cutKey(plan);
	if (key === frame.failedKey) return { kind: "defer", why: "repeat", plan, expected, key };
	const tokens = frame.contextTokens;
	const frees =
		tokens === undefined || cutFrees(expected, tokens, frame.limit ?? tokens, frame.limit === undefined ? Number.POSITIVE_INFINITY : frame.hard);
	return frees ? { kind: "ready", plan, expected, key } : { kind: "defer", why: "short", plan, expected, key };
}

/**
 * The cut with the kept-history cap, beside the cut without it. `candidate` keeps from the capped start; `decision`
 * is {@link planCut} of the frame with that start, judged against the same limit, so it can be ready where the
 * baseline defers. `deferral` leaves the baseline: the kept range fits the cap (`within-cap`), its newest round is
 * larger than the cap and cannot be cut inside (`atomic-tail`), or the baseline makes no cut to cap (`no-cut`).
 * The baseline is always what {@link planCut} says for the frame; the cap never hides it and never turns a cut that
 * the baseline refuses into one (an overflow included).
 */
export type CappedPlan =
	| {
			readonly kind: "candidate";
			/** The cut from the capped start; absent when the caller asked for the removal only (shadow). */
			readonly decision?: Exclude<CutDecision, { readonly kind: "disabled" }>;
			readonly removal: Extract<CapRemoval, { readonly kind: "remove" }>;
			readonly baseline: CutDecision;
	  }
	| { readonly kind: "deferral"; readonly why: "within-cap" | "atomic-tail" | "no-cut"; readonly baseline: CutDecision };

/**
 * Plans the cut with the kept range capped at `cap` estimated tokens. `baseline` is {@link planCut} of this same frame
 * when the caller has it already, and is planned here otherwise. Reads the log only as far as the baseline keeps: the
 * start of the kept range is looked for from the newest entry back, and the promotions the frame names are applied to
 * that range alone. The cut from the capped start is a second {@link planCut} over the whole history; it is made only
 * when `decide` is true (mode "on" with evidence), since a shadow only records the removal.
 */
export function cappedPlan(frame: CutFrame, envelope: CutEnvelope, cap: number, options: { readonly baseline?: CutDecision; readonly decide?: boolean } = {}): CappedPlan {
	const baseline = options.baseline ?? planCut(frame, envelope);
	const decide = options.decide ?? true;
	if (baseline.kind === "disabled") return { kind: "deferral", why: "no-cut", baseline };
	let keptIndex = frame.entries.length - 1;
	while (keptIndex >= 0 && (frame.entries[keptIndex] as LogEntry).id !== baseline.plan.firstKeptEntryId) keptIndex--;
	if (keptIndex < 0) return { kind: "deferral", why: "no-cut", baseline };
	const removal = capRemoval(promotedEntries(frame, keptIndex), 0, cap);
	if (removal.kind === "defer") return { kind: "deferral", why: removal.why, baseline };
	if (!decide) return { kind: "candidate", removal, baseline };
	const decision = planCut({ ...frame, keptFromId: removal.cappedFromId }, envelope);
	if (decision.kind === "disabled") return { kind: "deferral", why: "no-cut", baseline };
	return { kind: "candidate", decision, removal, baseline };
}

/** An entry with its position in reading order, 0 for the newest. */
interface Read {
	readonly entry: LogEntry;
	readonly at: number;
}

/**
 * Where the kept history starts, decided while reading newest first. `tail` gathers keepRecentTokens,
 * `tools` steps past tool results to the message before them, `turn` looks up to half of
 * keepRecentTokens further for the user message that opened the turn.
 */
type Boundary =
	| { readonly phase: "given" }
	| { readonly phase: "tail"; tail: number }
	| { readonly phase: "tools" }
	| { readonly phase: "turn"; readonly candidate: Read; extra: number }
	| { readonly phase: "settled"; readonly kept: Read }
	| { readonly phase: "none" };

/**
 * A cut planned from pages of the log read newest first. It holds only what the cut carries, each
 * part under its budget, and counters, so the memory it needs does not grow with the history.
 * Entries whose side of the boundary is still open wait in a buffer of one tool round, or of at
 * most half of keepRecentTokens while the fold looks for the start of a turn.
 */
export class CutFold {
	private readonly config: ContextConfig;
	/** The config's budgets in estimated tokens, the unit the fold counts in. */
	private readonly keepRecent: number;
	private readonly maskedBudget: number;
	private readonly pinnedBudget: number;
	private readonly reason: string;
	private readonly keptFromId: string | undefined;
	private readonly visibleFromId: string | undefined;
	private readonly summary: SummaryState | undefined;
	private readonly notebook: string;
	private readonly checkpoint: ForeignCheckpoint | undefined;
	private readonly files: FilesFold;
	private readonly skills = new SkillsFold();
	private boundary: Boundary;
	private read = 0;
	private visibleAt: number | undefined;
	/** The oldest message read so far: the boundary a compaction forces while tool results are still being stepped past. */
	private lastMessage: Read | undefined;
	private pending: Read[] = [];
	private archived = 0;
	private covered = false;
	private masking = true;
	private maskedUsed = 0;
	private readonly masked: string[] = [];
	private maskedFrom: LogEntry | undefined;
	private gap: { from: LogEntry; to: LogEntry; entries: number } | undefined;
	/** The summary's stretches to summarize again: their items are gone, so what of them is archived goes without summary. */
	private readonly redo: { readonly fromId: string; readonly throughId: string; from?: LogEntry; to?: LogEntry; entries: number }[];
	private redoOpen: number | undefined;
	private readonly redoOf = new Map<string, number>();
	private readonly pins: string[] = [];
	private pinsUsed = 0;
	private pinsFull = false;
	private pinsOmitted = 0;

	constructor(input: CutFoldInput) {
		if (!REASON.test(input.reason)) {
			throw new Error(`context: a cut reason is a lowercase word, got ${JSON.stringify(input.reason)}`);
		}
		this.config = input.config;
		this.keepRecent = estimateBudget(input.config.keepRecentTokens);
		this.maskedBudget = estimateBudget(input.config.maskedTokens);
		this.pinnedBudget = estimateBudget(input.config.pinnedUserTokens);
		this.reason = input.reason;
		this.keptFromId = input.keptFromId;
		this.visibleFromId = input.visibleFromId;
		this.summary = input.summary;
		this.redo = (input.summary?.unsummarized ?? []).map((gap) => ({ fromId: gap.fromId, throughId: gap.throughId, entries: 0 }));
		this.notebook = input.notebook?.trim() ?? "";
		// The model sees the newest compaction only, so the cut carries the checkpoint unless a summary of the edited
		// sources replaces a stale one and nobody else is compacting.
		const replaced = input.checkpoint?.status === "stale" && input.checkpointSuperseded === true && input.competing !== true;
		this.checkpoint = replaced ? undefined : input.checkpoint;
		this.files = new FilesFold(input.config.filesListed);
		this.boundary = input.keptFromId === undefined ? { phase: "tail", tail: 0 } : { phase: "given" };
	}

	/** The next page of the log, newest entry first, older than every entry added before. */
	add(page: readonly LogEntry[]): void {
		this.files.add(page);
		for (const entry of page) {
			const item = { entry, at: this.read++ };
			if (entry.id === this.visibleFromId) this.visibleAt = item.at;
			this.noteRedo(entry);
			this.skills.add(entry, item.at);
			this.step(item);
		}
	}

	/** The latest compaction lies between the entries added so far and the next ones; the kept range starts after it. */
	compaction(): void {
		const boundary = this.boundary;
		if (boundary.phase === "tail" || boundary.phase === "tools") this.settle(this.lastMessage);
		else if (boundary.phase === "turn") this.settle(boundary.candidate);
	}

	/** The cut, or undefined when it would archive nothing new. */
	finish(): CutPlan | undefined {
		if (this.boundary.phase === "turn") this.settle(this.boundary.candidate);
		if (this.boundary.phase !== "settled" || this.archived === 0) return undefined;
		const kept = this.boundary.kept.entry;

		const sections: string[] = [`<${CUT_TAG_NAME} reason="${this.reason}">\n${INTRO}`];
		sections.push(
			`## Your notebook\n${this.notebook === "" ? "(empty: the notebook tool keeps working state that must survive these cuts)" : this.notebook}`,
		);
		const skills = this.skills.section(this.boundary.kept.at);
		if (skills !== "") sections.push(skills);
		if (this.pins.length > 0 || this.pinsOmitted > 0) {
			const omitted =
				this.pinsOmitted > 0 ? `(${this.pinsOmitted} older user messages not shown; search for them)\n` : "";
			sections.push(`## Earlier user messages, verbatim\n${omitted}${this.pins.toReversed().join("\n")}`.trimEnd());
		}
		const checkpoint = this.checkpoint;
		if (checkpoint) {
			const stale =
				checkpoint.status === "stale"
					? "Stale: entries it summarizes were edited after it was written; check the archive before relying on it.\n"
					: "";
			sections.push(`## Earlier summary from another compaction, verbatim (#${checkpoint.id})\n${stale}${checkpoint.text}`);
		}
		const summary = this.covered ? this.summary : undefined;
		if (summary) {
			const rendered = renderSummary(summary.sections);
			if (rendered !== "")
				sections.push(`## Summary of older work (through #${summary.coveredThroughId})\n${rendered}`);
		}
		const files = this.files.result();
		const fileLines = [
			files.modified.length > 0 ? `Modified: ${files.modified.join(", ")}` : "",
			files.read.length > 0 ? `Read: ${files.read.join(", ")}` : "",
		].filter((line) => line !== "");
		if (fileLines.length > 0) sections.push(`## Files\n${fileLines.join("\n")}`);
		const gap = this.gap;
		const unsummarized = [
			...(gap ? [`#${gap.from.id} … #${gap.to.id} (${gap.entries} entries). Search them when they matter.`] : []),
			...(summary ? this.redo : []).flatMap((one) =>
				one.from && one.to
					? [`#${one.from.id} … #${one.to.id} (${one.entries} entries), edited after they were summarized; summarized again soon. Search them when they matter.`]
					: [],
			),
		];
		if (unsummarized.length > 0) sections.push(`## Archived without summary\n${unsummarized.join("\n")}`);
		if (this.masked.length > 0)
			sections.push(`## Recent work, tool output archived\n${this.masked.toReversed().join("\n")}`);
		sections.push(`</${CUT_TAG_NAME}>\nThe conversation continues verbatim from here.`);

		const text = sections.join("\n\n");
		return {
			firstKeptEntryId: kept.id,
			text,
			details: {
				version: 1,
				reason: this.reason,
				keptFromId: kept.id,
				...(this.maskedFrom ? { maskedFromId: this.maskedFrom.id } : {}),
				...(summary ? { summaryThroughId: summary.coveredThroughId } : {}),
				...(gap ? { unsummarized: { fromId: gap.from.id, toId: gap.to.id, entries: gap.entries } } : {}),
				archivedEntries: this.archived,
				blockTokens: estimateTokens(text),
			},
		};
	}

	private step(item: Read): void {
		const boundary = this.boundary;
		const { entry } = item;
		switch (boundary.phase) {
			case "given":
				this.reachAnchor(entry);
				if (entry.id === this.keptFromId) this.settle(item);
				return;
			case "tail":
			case "tools":
				if (boundary.phase === "tail") boundary.tail += entry.tokens;
				if (entry.kind === "tool") this.pending.push(item);
				else {
					for (const waiting of this.pending) this.reachAnchor(waiting.entry);
					this.pending = [];
					this.reachAnchor(entry);
					this.lastMessage = item;
				}
				if (boundary.phase === "tail" && boundary.tail < this.keepRecent) return;
				if (entry.kind === "user") this.settle(item);
				else if (entry.kind === "tool") this.boundary = { phase: "tools" };
				else this.boundary = { phase: "turn", candidate: item, extra: 0 };
				return;
			case "turn":
				boundary.extra += entry.tokens;
				this.pending.push(item);
				if (entry.kind === "user" && boundary.extra <= this.keepRecent / 2) {
					for (const waiting of this.pending) this.reachAnchor(waiting.entry);
					this.pending = [];
					this.settle(item);
				} else if (entry.kind === "user" || boundary.extra > this.keepRecent / 2) {
					this.settle(boundary.candidate);
				}
				return;
			case "settled":
				this.archive(entry);
				return;
			case "none":
				return;
		}
	}

	/** Fixes the boundary at `kept`, or at none, and archives the entries older than it read so far. */
	private settle(kept: Read | undefined): void {
		const waiting = this.pending;
		this.pending = [];
		if (!kept || (this.visibleAt !== undefined && this.visibleAt <= kept.at)) {
			this.boundary = { phase: "none" };
			return;
		}
		this.boundary = { phase: "settled", kept };
		for (const item of waiting) this.archive(item.entry);
	}

	/** Notes the summary's anchor: history older than it is summarized, so nothing older is masked or a gap. */
	private reachAnchor(entry: LogEntry): void {
		if (entry.id !== this.summary?.coveredThroughId) return;
		this.covered = true;
		this.masking = false;
	}

	/** Entries arrive newest first: a stretch to summarize again opens at its last entry and closes after its first. */
	private noteRedo(entry: LogEntry): void {
		if (this.redoOpen === undefined) {
			const opens = this.redo.findIndex((one) => one.throughId === entry.id);
			if (opens >= 0) this.redoOpen = opens;
		}
		if (this.redoOpen === undefined) return;
		this.redoOf.set(entry.id, this.redoOpen);
		if (this.redo[this.redoOpen]?.fromId === entry.id) this.redoOpen = undefined;
	}

	private archive(entry: LogEntry): void {
		this.archived++;
		this.reachAnchor(entry);
		const redo = this.redo[this.redoOf.get(entry.id) ?? -1];
		if (redo) {
			redo.from = entry;
			redo.to ??= entry;
			redo.entries++;
		}
		if (this.masking) {
			const line = renderMasked(entry);
			const cost = estimateTokens(line) + 1;
			if (this.maskedUsed + cost <= this.maskedBudget) {
				this.masked.push(line);
				this.maskedUsed += cost;
				this.maskedFrom = entry;
				return;
			}
			this.masking = false;
		}
		if (!this.covered) {
			if (this.gap) {
				this.gap.from = entry;
				this.gap.entries++;
			} else this.gap = { from: entry, to: entry, entries: 1 };
		}
		if (entry.kind === "user") this.pin(entry);
	}

	private pin(entry: LogEntry): void {
		if (this.pinsFull) {
			this.pinsOmitted++;
			return;
		}
		const body = clip(withoutSkillBodies(entry.text).trim(), PINNED_MESSAGE_CHARS).replace(/\n/g, "\n  ");
		const line = `- [#${entry.id} ${formatTime(entry.timestamp)}] ${body}`;
		const cost = estimateTokens(line);
		if (this.pinsUsed + cost > this.pinnedBudget) {
			this.pinsFull = true;
			this.pinsOmitted++;
			return;
		}
		this.pins.push(line);
		this.pinsUsed += cost;
	}
}

/**
 * Files modified and read, newest first, computed from the log rather than summarized: the `limit`
 * paths modified last, and the paths read last that are not among them. Read newest first, it keeps
 * the first `limit` modified paths and the first 2 × `limit` read paths, so it never holds more than
 * 3 × `limit`; a path modified only before the listed ones can therefore be listed as read.
 */
export class FilesFold {
	private readonly modified = new Set<string>();
	private readonly read = new Set<string>();
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	/** Paths held so far. */
	get held(): number {
		return this.modified.size + this.read.size;
	}

	/** The next page of the log, newest entry first. */
	add(page: readonly LogEntry[]): void {
		for (const entry of page) {
			for (const call of entry.toolCalls.toReversed()) {
				const path = pathOf(call.args);
				if (!path) continue;
				if (WRITE_TOOLS.has(call.name) && this.modified.size < this.limit) this.modified.add(path);
				else if (READ_TOOLS.has(call.name) && this.read.size < 2 * this.limit) this.read.add(path);
			}
		}
	}

	result(): FileLists {
		const modified = [...this.modified];
		const read = [...this.read].filter((path) => !this.modified.has(path)).slice(0, this.limit);
		return { modified, read };
	}
}

/** {@link FilesFold} over the whole log. */
export function filesTouched(entries: readonly LogEntry[], limit: number): FileLists {
	const fold = new FilesFold(limit);
	fold.add(entries.toReversed());
	return fold.result();
}
