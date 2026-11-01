import type { ContextConfig } from "./config.ts";
import { renderForHistorian } from "./serialize.ts";
import {
	type CondenseSelection,
	parseSummaryDelta,
	renderSummary,
	SECTIONS,
	type SummaryDelta,
	type SummaryState,
} from "./summary.ts";
import { estimateBudget } from "./tokens.ts";
import type { LogEntry } from "./types.ts";

export const HISTORIAN_SYSTEM_PROMPT = `You are the historian of a long-running coding-agent session. You read one stretch of the transcript and record what the agent must not forget once that stretch leaves its context. The full transcript stays searchable, so record what matters and where it is, not everything.

Write only these sections, each as short bullet points:

## Topic
One line naming what this stretch was about, like a chapter title.
## Goal
The user's goal when it is first stated, and every later change to it: what changed and why. Leave this out when the goal stayed as the existing summary has it.
## Current state
Exactly two bullets on where the work stands at the end of this stretch: "Done:" the last thing finished, and "Next:" the next concrete step, named so the agent can start on it without rereading the stretch (the file, command or question it begins with). When the stretch ends waiting on the user, "Next:" says what for. This section replaces the previous one, so never put results or values here; they go under Facts and findings.
## Decisions
Decisions and their reasons, including rules the user set.
## Facts and findings
Every result and answer produced or given in this stretch, with where it came from (for example: report-4.txt has release code jade-heron-63), plus verified facts, values, names, paths and commands the work depends on. These accumulate over the whole session.
## Errors and fixes
Failures, their causes, and what fixed them.
## Open threads
Every thread still open at the end of this stretch, including open threads from the existing summary that this stretch did not close. This section replaces the previous one, so leave none of them out; when every thread is closed, write the single bullet "none".

Rules:
- End every bullet with the ids of the entries it comes from, like (#1a2b3c4d).
- Keep exact identifiers, paths, numbers and error messages.
- Record user instructions and constraints exactly as stated.
- Say why: record the purpose of actions and the hypothesis behind experiments, not only what was done.
- Do not repeat what the existing summary already says.
- Leave out sections with nothing new. No preamble, no closing remarks.`;

export interface Chunk {
	readonly entries: readonly LogEntry[];
	readonly throughId: string;
	readonly tokens: number;
}

export interface ChunkFoldInput {
	readonly config: ContextConfig;
	/** The latest summary's anchor: it and every older entry are summarized already. */
	readonly afterId?: string;
	/** Entries older than this one are never summarized, for example history archived before the first summary. */
	readonly fromId?: string;
}

/** How many of `entries`, oldest first, one chunk takes, and their tokens: a tool call stays with its results. */
function chunkEnd(entries: readonly LogEntry[], maxTokens: number): { stop: number; tokens: number } {
	let stop = 0;
	let tokens = 0;
	while (stop < entries.length && tokens < maxTokens) tokens += entries[stop++]?.tokens ?? 0;
	while (stop < entries.length && entries[stop]?.kind === "tool") tokens += entries[stop++]?.tokens ?? 0;
	return { stop, tokens };
}

/**
 * The next stretch worth summarizing, chosen from pages of the log read newest first. Only history the next cut
 * archives is eligible: the newest keepRecent + masked tokens stay raw or masked and are summarized later. The stretch
 * starts after the summary's anchor, or at `fromId`, and takes up to `chunkMaxTokens`. The fold holds at most that
 * stretch, so the memory it needs does not grow with the history.
 */
export class ChunkFold {
	readonly #config: ContextConfig;
	readonly #afterId: string | undefined;
	readonly #fromId: string | undefined;
	/** Tokens of the newest history read so far, up to what the next cut keeps. */
	#tail = 0;
	/** Candidates, oldest first, no more than the oldest of them can make one chunk of. */
	#held: LogEntry[] = [];
	#done = false;

	constructor(input: ChunkFoldInput) {
		this.#config = input.config;
		this.#afterId = input.afterId;
		this.#fromId = input.fromId;
	}

	/** Fold the next page, newest first; true once the fold has read where the stretch starts, so the scan can stop. */
	add(page: readonly LogEntry[]): boolean {
		const older: LogEntry[] = [];
		const reserve = estimateBudget(this.#config.keepRecentTokens + this.#config.maskedTokens);
		for (const entry of page) {
			if (this.#done || entry.id === this.#afterId) {
				this.#done = true;
				break;
			}
			if (this.#tail < reserve) this.#tail += entry.tokens;
			else older.push(entry);
			if (entry.id === this.#fromId) this.#done = true;
		}
		// Older entries only move the chunk's end towards the oldest, so what lies past it now never joins it.
		this.#held = [...older.reverse(), ...this.#held];
		this.#held.length = chunkEnd(this.#held, this.#config.historian.chunkMaxTokens).stop;
		return this.#done;
	}

	/** The stretch, or undefined when too little has accumulated. */
	finish(): Chunk | undefined {
		const { stop, tokens } = chunkEnd(this.#held, this.#config.historian.chunkMaxTokens);
		const last = this.#held[stop - 1];
		if (!last || tokens < this.#config.historian.chunkMinTokens) return undefined;
		return { entries: this.#held.slice(0, stop), throughId: last.id, tokens };
	}
}

/** The next stretch worth summarizing in a whole log: the log fed to a {@link ChunkFold} newest first. */
export function selectChunk(
	entries: readonly LogEntry[],
	summary: SummaryState | undefined,
	config: ContextConfig,
	/** Entries before this index are never summarized, for example history archived before this extension ran. */
	floorIndex = 0,
): Chunk | undefined {
	if (floorIndex >= entries.length) return undefined;
	const fold = new ChunkFold({
		config,
		...(summary ? { afterId: summary.coveredThroughId } : {}),
		...(floorIndex > 0 ? { fromId: entries[floorIndex]?.id } : {}),
	});
	fold.add([...entries].reverse());
	return fold.finish();
}

/**
 * The historian's answer as a summary delta. The topic becomes one chapter that names the
 * stretch's entry range, computed here rather than trusted to the model.
 */
export function historianDelta(text: string, chunk: Chunk): SummaryDelta {
	const delta = parseSummaryDelta(text);
	const first = chunk.entries[0]?.id;
	const topic = delta.chapters?.[0]?.replace(/\s*\(#[^)]*\)\s*$/, "") || "Untitled stretch";
	delta.chapters = first ? [`${topic} (#${first} … #${chunk.throughId})`] : [];
	return delta;
}

export const CONDENSER_SYSTEM_PROMPT = `You condense the oldest records of a long coding-agent session's summary so it fits its budget. The full transcript stays searchable by entry id, so a condensed record must still say what happened and where to find it.

Rewrite each section you are given as fewer, shorter bullets, about a third of the original length:
- Merge related items into one bullet. Drop nothing that a later step could need: exact identifiers, paths, values, decisions with their reasons, error causes, user instructions.
- End every bullet with the ids it covers. For more than three ids give the first and last as a range, like (#1a2b3c4d … #9f8e7d6c).
- Keep the section headings exactly as given. No preamble, no closing remarks.`;

export function condensePrompt(selection: CondenseSelection): string {
	const parts: string[] = [];
	for (const { key, title } of SECTIONS) {
		const items = selection[key];
		if (items && items.length > 0) parts.push(`## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
	}
	return ["<records>", parts.join("\n\n"), "</records>", "", "Condense these records."].join("\n");
}

export function historianPrompt(chunk: Chunk, previous: SummaryState | undefined): string {
	const existing = previous ? renderSummary(previous.sections) : "";
	return [
		"<existing-summary>",
		existing === "" ? "(none yet)" : existing,
		"</existing-summary>",
		"",
		"<transcript>",
		...chunk.entries.map(renderForHistorian),
		"</transcript>",
		"",
		"Record this stretch of the transcript.",
	].join("\n");
}
