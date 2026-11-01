import type { ContextConfig } from "./config.ts";
import { pathOf } from "./messages.ts";
import { clip, formatTime, renderMasked } from "./serialize.ts";
import { SkillsFold, withoutSkillBodies } from "./skills.ts";
import { renderSummary, type SummaryState } from "./summary.ts";
import { estimateBudget, estimateTokens } from "./tokens.ts";
import type { LogEntry } from "./types.ts";

/**
 * A cut moves older history out of the model context in one step, at a moment the prompt
 * cache is lost anyway or at the planned watermark. It is computed from the log alone and
 * needs no model call, so it never makes the user wait.
 *
 * After a cut the model sees, in this order: its notebook, the skills it loaded in the archived
 * history, earlier user messages verbatim, the anchored summary, the files it touched, a masked transcript of the most recent
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
const REASON_WORD = "[a-z][a-z-]{0,31}";
const REASON = new RegExp(`^${REASON_WORD}$`);
const CUT_TAG = new RegExp(`<sandy-context reason="(${REASON_WORD})">`);

const INTRO = [
	"This session keeps going indefinitely. Older history has left your context, but the session log keeps all of it, unchanged and searchable: history_search finds entries by keywords (identifiers, paths and error text work best), history_read returns one entry in full.",
	"Below is what you carry forward. When you need a detail that is not here, search for it instead of guessing.",
].join("\n");

/** The reason in a cut's opening tag, or undefined when the text holds no cut. */
export function cutReason(text: string): string | undefined {
	return CUT_TAG.exec(text)?.[1];
}

/** Plans a cut from the whole log: the log fed to a {@link CutFold} newest first. */
export function planCut(input: CutInput): CutPlan | undefined {
	const { entries, minKeptIndex } = input;
	const fold = new CutFold({ ...input, visibleFromId: entries[input.visibleFromIndex]?.id });
	fold.add(entries.slice(minKeptIndex).reverse());
	if (minKeptIndex > 0) {
		fold.compaction();
		fold.add(entries.slice(0, minKeptIndex).reverse());
	}
	return fold.finish();
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
	private readonly pins: string[] = [];
	private pinsUsed = 0;
	private pinsFull = false;
	private pinsOmitted = 0;

	constructor(input: CutFoldInput) {
		if (!REASON.test(input.reason)) {
			throw new Error(`sandy-context: a cut reason is a lowercase word, got ${JSON.stringify(input.reason)}`);
		}
		this.config = input.config;
		this.keepRecent = estimateBudget(input.config.keepRecentTokens);
		this.maskedBudget = estimateBudget(input.config.maskedTokens);
		this.pinnedBudget = estimateBudget(input.config.pinnedUserTokens);
		this.reason = input.reason;
		this.keptFromId = input.keptFromId;
		this.visibleFromId = input.visibleFromId;
		this.summary = input.summary;
		this.notebook = input.notebook?.trim() ?? "";
		this.files = new FilesFold(input.config.filesListed);
		this.boundary = input.keptFromId === undefined ? { phase: "tail", tail: 0 } : { phase: "given" };
	}

	/** The next page of the log, newest entry first, older than every entry added before. */
	add(page: readonly LogEntry[]): void {
		this.files.add(page);
		for (const entry of page) {
			const item = { entry, at: this.read++ };
			if (entry.id === this.visibleFromId) this.visibleAt = item.at;
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

		const sections: string[] = [`<sandy-context reason="${this.reason}">\n${INTRO}`];
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
		if (gap) {
			sections.push(
				`## Archived without summary\n#${gap.from.id} … #${gap.to.id} (${gap.entries} entries). Search them when they matter.`,
			);
		}
		if (this.masked.length > 0)
			sections.push(`## Recent work, tool output archived\n${this.masked.toReversed().join("\n")}`);
		sections.push("</sandy-context>\nThe conversation continues verbatim from here.");

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

	private archive(entry: LogEntry): void {
		this.archived++;
		this.reachAnchor(entry);
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
