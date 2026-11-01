import type { ContextConfig } from "./config.ts";
import { digestOf, entryDigest, renderChunks } from "./serialize.ts";
import {
	type CondenseSelection,
	citedIds,
	mergeSummary,
	parseSummaryDelta,
	type PartialEntry,
	renderSummary,
	SECTIONS,
	type SourceStretch,
	type SummaryDelta,
	type SummaryState,
	type UnsummarizedStretch,
} from "./summary.ts";
import { estimateBudget } from "./tokens.ts";
import type { EffectiveHistory, LogEntry } from "./types.ts";

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
- End every bullet with the ids of the entries it comes from, like (#1a2b3c4d). Cite only ids that appear in the transcript or in the existing summary.
- An entry may be shown in part ("characters 0-8000 of 20000"); record what you see and leave the rest to the next stretch.
- Answer in the sections above as text. Do not call tools.
- Keep exact identifiers, paths, numbers and error messages.
- Record user instructions and constraints exactly as stated.
- Say why: record the purpose of actions and the hypothesis behind experiments, not only what was done.
- Do not repeat what the existing summary already says.
- Leave out sections with nothing new. No preamble, no closing remarks.`;

declare const HISTORIAN_WORK: unique symbol;

/** A piece of one entry's rendering the historian is shown: characters `from` to `to` of `total`. */
export interface EvidenceSpan {
	readonly entryId: string;
	readonly from: number;
	readonly to: number;
	readonly total: number;
	readonly text: string;
	/** How the whole entry reads, to tell at commit time whether it was edited meanwhile. */
	readonly digest: string;
}

/** What the next summary covers once the historian's answer is accepted. */
export interface Coverage {
	/** The last entry complete after the work; empty when none is. */
	readonly throughId: string;
	/** The entry the work ends inside, when it does not end at an entry's end. */
	readonly partial: PartialEntry | undefined;
	/** The entries the work completes and a hash of how they read; undefined when it completes none. */
	readonly stretch: SourceStretch | undefined;
	/**
	 * Work on a stretch behind the coverage that is to be summarized again, or that a stale foreign checkpoint summarized
	 * and no summary of ours covers: the unsummarized stretch it works on, when one was recorded, and what of it is left.
	 */
	readonly gap?: { readonly replaces: UnsummarizedStretch | undefined; readonly rest: UnsummarizedStretch | undefined };
}

/**
 * The next stretch to summarize, read from an {@link EffectiveHistory}: the summary it extends, the spans of entries the
 * model is shown, and what the summary covers once the answer is accepted. Only {@link selectEvidence} makes one.
 */
export interface HistorianWork {
	readonly [HISTORIAN_WORK]: true;
	readonly previous: SummaryState | undefined;
	readonly spans: readonly EvidenceSpan[];
	readonly coverage: Coverage;
	/** The branch entry the history was read at; the stored summary keeps it. */
	readonly readAt: string | undefined;
	/** The stale foreign checkpoint this work summarizes the sources of. */
	readonly supersedes: string | undefined;
	/** Ids an answer may cite: the entries shown and those the existing summary already cites. */
	readonly known: ReadonlySet<string>;
	/** Estimated tokens the spans take. */
	readonly tokens: number;
	/** The history's order of entries, to read the ranges items cite. */
	readonly order: ReadonlyMap<string, number>;
}

export interface EvidenceBudget {
	/** Less than this is not worth a call. */
	readonly minTokens: number;
	readonly maxTokens: number;
	/** The newest history this many estimated tokens stays raw or masked after the next cut; it is summarized later. */
	readonly reserveTokens: number;
	/** Another extension also compacts: a stale checkpoint of it is not summarized away. */
	readonly competing: boolean;
}

export function evidenceBudget(config: ContextConfig, competing: boolean): EvidenceBudget {
	return {
		minTokens: config.historian.chunkMinTokens,
		maxTokens: config.historian.chunkMaxTokens,
		reserveTokens: estimateBudget(config.keepRecentTokens + config.maskedTokens),
		competing,
	};
}

/** The entries a summary can be made from, oldest first: what a stale foreign checkpoint summarized, then the history. */
export function summarizable(history: EffectiveHistory, competing: boolean): readonly LogEntry[] {
	return history.checkpoint?.status === "stale" && !competing
		? [...history.checkpointSources, ...history.entries]
		: history.entries;
}

/** Characters of the entry's rendering from `from`, at most `maxChars`, and the length of the whole rendering. */
function renderSlice(entry: LogEntry, from: number, maxChars: number): { text: string; to: number; total: number } {
	let text: string | undefined;
	let end = from;
	for (const chunk of renderChunks(entry, Math.max(2, maxChars), from)) {
		text ??= chunk.text;
		end = chunk.offset + chunk.text.length;
	}
	const first = text ?? "";
	return { text: first, to: from + first.length, total: end };
}

const CHARS_PER_TOKEN = 4;

/** Spans of `entries` from `offset` into the first, up to `maxTokens`; the entry the spans end inside is `unfinished`. */
function takeSpans(entries: readonly LogEntry[], offset: number, maxTokens: number) {
	const spans: EvidenceSpan[] = [];
	let left = maxTokens;
	let tokens = 0;
	let unfinished: EvidenceSpan | undefined;
	let next = 0;
	for (; next < entries.length && left > 0; next++) {
		const entry = entries[next] as LogEntry;
		const slice = renderSlice(entry, offset, left * CHARS_PER_TOKEN);
		if (slice.text === "" && offset >= slice.total) {
			// An edit shortened the entry below what was summarized: it is complete.
			offset = 0;
			continue;
		}
		const span: EvidenceSpan = { entryId: entry.id, from: offset, to: slice.to, total: slice.total, text: slice.text, digest: entryDigest(entry) };
		spans.push(span);
		const cost = Math.ceil(slice.text.length / CHARS_PER_TOKEN);
		left -= cost;
		tokens += cost;
		offset = 0;
		if (slice.to < slice.total) {
			unfinished = span;
			next++;
			break;
		}
	}
	const complete = spans.filter((span) => span !== unfinished);
	const stretch: SourceStretch | undefined =
		complete.length > 0
			? { fromId: complete[0]?.entryId as string, throughId: complete.at(-1)?.entryId as string, digest: digestOf(...complete.map((span) => span.digest)) }
			: undefined;
	return { spans, tokens, unfinished, stretch, next };
}

/** A stretch behind the coverage still to summarize: its entries as they read now, and where in the first to start. */
interface Gap {
	readonly replaces: UnsummarizedStretch | undefined;
	readonly throughId: string;
	readonly entries: readonly LogEntry[];
	readonly offset: number;
}

/**
 * The oldest stretch behind the coverage that the summary does not account for: one recorded as to be summarized
 * again, or, unless another extension compacts too, entries a stale foreign checkpoint summarized that no stretch of
 * the summary covers and that the summary has moved past.
 */
function nextGap(history: EffectiveHistory, entries: readonly LogEntry[], competing: boolean): Gap | undefined {
	const previous = history.summary;
	if (!previous) return undefined;
	const order = history.order;
	const inRange = (range: { fromId: string; throughId: string }) => {
		const from = order.get(range.fromId) ?? Infinity;
		const through = order.get(range.throughId) ?? -Infinity;
		return (entry: LogEntry) => {
			const at = order.get(entry.id) ?? -1;
			return at >= from && at <= through;
		};
	};
	for (const gap of previous.unsummarized ?? []) {
		const members = entries.filter(inRange(gap));
		if (members.length === 0) continue;
		const offset = gap.offset !== undefined && members[0]?.id === gap.fromId ? gap.offset : 0;
		return { replaces: gap, throughId: gap.throughId, entries: members, offset };
	}
	if (competing || history.checkpoint?.status !== "stale") return undefined;
	const anchor = previous.coveredThroughId === "" ? -1 : entries.findIndex((entry) => entry.id === previous.coveredThroughId);
	const sources = new Set(history.checkpointSources.map((entry) => entry.id));
	const covered = [...(previous.sources ?? []), ...(previous.unsummarized ?? [])].map(inRange);
	const run: LogEntry[] = [];
	for (const entry of entries.slice(0, anchor + 1)) {
		const open = sources.has(entry.id) && !covered.some((inside) => inside(entry));
		if (open) run.push(entry);
		else if (run.length > 0) break;
	}
	const last = run.at(-1);
	return last ? { replaces: undefined, throughId: last.id, entries: run, offset: 0 } : undefined;
}

/**
 * The next stretch worth summarizing, or undefined when too little has accumulated. A stretch behind the coverage that
 * the summary does not account for comes first, however small. Otherwise only history the next cut archives is
 * eligible: the newest `reserveTokens` stay raw or masked and are summarized later. The stretch starts where the
 * summary stopped, inside an entry when the summary holds only a part of it, and takes up to `maxTokens`. An entry that
 * does not fit is shown in explicit spans, never clipped: the part not shown stays to be summarized.
 */
export function selectEvidence(history: EffectiveHistory, budget: EvidenceBudget, readAt?: string): HistorianWork | undefined {
	const entries = summarizable(history, budget.competing);
	const previous = history.summary;
	const sourceIds = entries.length > history.entries.length ? new Set(history.checkpointSources.map((entry) => entry.id)) : undefined;
	const work = (spans: readonly EvidenceSpan[], tokens: number, coverage: Coverage): HistorianWork => {
		const supersedes = sourceIds && spans.some((span) => sourceIds.has(span.entryId)) ? history.checkpoint?.id : undefined;
		const known = new Set([...spans.map((span) => span.entryId), ...(previous ? SECTIONS.flatMap(({ key }) => previous.sections[key].flatMap((item) => citedIds(item))) : [])]);
		return { previous, spans, coverage, readAt, supersedes, known, tokens, order: history.order } as unknown as HistorianWork;
	};
	const covered = previous?.coveredThroughId ?? "";

	const gap = nextGap(history, entries, budget.competing);
	if (gap) {
		const taken = takeSpans(gap.entries, gap.offset, budget.maxTokens);
		const { unfinished } = taken;
		const following = gap.entries[taken.next];
		const rest: UnsummarizedStretch | undefined = unfinished
			? { fromId: unfinished.entryId, throughId: gap.throughId, offset: unfinished.to, digest: unfinished.digest }
			: following
				? { fromId: following.id, throughId: gap.throughId }
				: undefined;
		if (taken.spans.length > 0) {
			return work(taken.spans, taken.tokens, {
				throughId: covered,
				partial: previous?.partial,
				stretch: taken.stretch,
				gap: { replaces: gap.replaces, rest },
			});
		}
	}

	let eligible = entries.length;
	for (let tail = 0; eligible > 0 && tail < budget.reserveTokens; ) tail += entries[--eligible]?.tokens ?? 0;

	const anchor = covered === "" ? -1 : entries.findIndex((entry) => entry.id === covered);
	const index = anchor + 1;
	let offset = 0;
	const partial = previous?.partial;
	if (partial && entries[index]?.id === partial.entryId) offset = partial.offset;

	const taken = takeSpans(entries.slice(index, Math.max(index, eligible)), offset, budget.maxTokens);
	if (taken.spans.length === 0 || taken.tokens < budget.minTokens) return undefined;
	const { unfinished } = taken;
	return work(taken.spans, taken.tokens, {
		throughId: taken.stretch?.throughId ?? covered,
		partial: unfinished && { entryId: unfinished.entryId, offset: unfinished.to, digest: unfinished.digest },
		stretch: taken.stretch,
	});
}

/** An answer of the historian's model as a host hands it over. */
export interface HistorianAnswer {
	readonly text: string;
	/** How the model ended; anything but `stop` is an answer cut short. */
	readonly stopReason?: string;
	/** Tool calls the model made instead of, or besides, answering. */
	readonly toolCalls?: number;
}

export type RejectionReason = "incomplete" | "tool-call" | "no-sections" | "unknown-reference" | "unsourced";

export interface Rejection {
	readonly ok: false;
	readonly reason: RejectionReason;
	readonly detail: string;
}

/** An answer that may become a summary: the sections it wrote. */
export interface ValidSummary {
	readonly ok: true;
	readonly delta: SummaryDelta;
}

/**
 * Whether the answer is a complete, sourced account of the work: it ended on its own, made no tool call, wrote at least
 * one section, cites only entries it could see, and every item but the topic cites one. Anything else is no summary; coverage never
 * advances on it.
 */
export function validateCompletion(answer: HistorianAnswer, work: HistorianWork): ValidSummary | Rejection {
	const reject = (reason: RejectionReason, detail: string): Rejection => ({ ok: false, reason, detail });
	if (answer.stopReason !== undefined && answer.stopReason !== "stop") {
		return reject("incomplete", `the answer ended with "${answer.stopReason}"`);
	}
	if (answer.text.trim() === "") return reject("incomplete", "the answer was empty");
	if ((answer.toolCalls ?? 0) > 0) return reject("tool-call", "the model called a tool instead of writing the summary");
	const delta = parseSummaryDelta(answer.text);
	const items = SECTIONS.flatMap(({ key }) => delta[key] ?? []);
	if (Object.keys(delta).length === 0) return reject("no-sections", "the answer has none of the summary sections");
	const cited = items.flatMap((item) => citedIds(item));
	const unknown = cited.filter((id) => !work.known.has(id));
	if (unknown.length > 0) return reject("unknown-reference", `cites entries that were not shown: ${[...new Set(unknown)].join(", ")}`);
	// Every item says where it comes from, or an edit of its source could never take it out. The topic is exempt: its
	// chapter gets the work's entries.
	const unsourced = SECTIONS.filter(({ key }) => key !== "chapters").flatMap(({ key }) => (delta[key] ?? []).filter((item) => citedIds(item).length === 0));
	if (unsourced.length > 0) return reject("unsourced", `cites no entry: ${unsourced.slice(0, 3).join(" | ")}`);
	if (cited.length === 0) return reject("unsourced", "no item cites an entry");
	return { ok: true, delta };
}

/**
 * The summary after an accepted answer: the previous one with the answer merged in, and the work's coverage. The
 * topic becomes one chapter naming the entries the work completed, computed here rather than trusted to the model; an
 * answer without a topic adds no chapter.
 */
export function completeSummary(work: HistorianWork, valid: ValidSummary): SummaryState {
	const delta: SummaryDelta = { ...valid.delta };
	const first = work.spans[0]?.entryId;
	const topic = delta.chapters?.[0]?.replace(/\s*\(#[^)]*\)[.,;:]?\s*$/, "").trim();
	const through = work.coverage.stretch?.throughId ?? work.spans.at(-1)?.entryId;
	if (topic && first && through) delta.chapters = [`${topic} (#${first} … #${through})`];
	else delete delta.chapters;
	const { gap } = work.coverage;
	if (gap) {
		// A stretch behind the coverage does not say where the work stands now.
		delete delta.state;
		delete delta.next;
	}
	const merged = mergeSummary(work.previous, delta, work.coverage.throughId);
	const sources = [...(work.previous?.sources ?? []), ...(work.coverage.stretch ? [work.coverage.stretch] : [])];
	const before = work.previous?.unsummarized ?? [];
	const unsummarized = gap
		? [...before.filter((one) => one !== gap.replaces), ...(gap.rest ? [gap.rest] : [])].sort(
				(a, b) => (work.order.get(a.fromId) ?? 0) - (work.order.get(b.fromId) ?? 0),
			)
		: before;
	return {
		...merged,
		...(sources.length > 0 ? { sources } : {}),
		...(work.coverage.partial ? { partial: work.coverage.partial } : {}),
		...(unsummarized.length > 0 ? { unsummarized } : {}),
		...(work.supersedes !== undefined ? { supersedes: work.supersedes } : work.previous?.supersedes !== undefined ? { supersedes: work.previous.supersedes } : {}),
	};
}

/** The summary as it is stored: with the history it was read at, and the usage and model behind it. */
export type StoredSummary = SummaryState & {
	readonly projectedThroughId?: string;
	readonly usage?: unknown;
	readonly model?: string;
	readonly condenseUsage?: unknown;
};

export type CommitResult =
	| { readonly status: "stored" }
	| { readonly status: "stale"; readonly why: "summary-changed" | "source-edited" | "branch-lost" | "mismatch" };

/** A digest of everything a summary holds: two summaries with the same coverage but other items differ. */
export function summaryDigest(summary: SummaryState | undefined): string {
	return summary === undefined ? "" : digestOf(canonical(summary));
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const fields = Object.entries(value as Record<string, unknown>).filter(([, one]) => one !== undefined);
		return `{${fields
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, one]) => `${JSON.stringify(key)}:${canonical(one)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const samePrevious = (a: SummaryState | undefined, b: SummaryState | undefined): boolean => summaryDigest(a) === summaryDigest(b);

/**
 * Whether `summary`, made from `work`, may be stored on the branch as it reads now. It is stale when another summary
 * was stored meanwhile, when an entry it was made from reads differently or is gone, or when it does not carry the
 * coverage the work promised. Entries appended since do not matter.
 */
export function commitSummary(expected: { readonly work: HistorianWork; readonly history: EffectiveHistory; readonly competing?: boolean }, summary: SummaryState): CommitResult {
	const { work, history } = expected;
	if (!samePrevious(history.summary, work.previous)) return { status: "stale", why: "summary-changed" };
	const now = new Map(summarizable(history, expected.competing === true).map((entry) => [entry.id, entry]));
	for (const span of work.spans) {
		const entry = now.get(span.entryId);
		if (!entry) return { status: "stale", why: "branch-lost" };
		if (entryDigest(entry) !== span.digest) return { status: "stale", why: "source-edited" };
	}
	const { coverage } = work;
	if (
		summary.coveredThroughId !== coverage.throughId ||
		summary.partial?.entryId !== coverage.partial?.entryId ||
		summary.partial?.offset !== coverage.partial?.offset ||
		summary.sources?.at(-1)?.digest !== (coverage.stretch?.digest ?? work.previous?.sources?.at(-1)?.digest)
	) {
		return { status: "stale", why: "mismatch" };
	}
	return { status: "stored" };
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

export function historianPrompt(work: HistorianWork): string {
	const existing = work.previous ? renderSummary(work.previous.sections) : "";
	return [
		"<existing-summary>",
		existing === "" ? "(none yet)" : existing,
		"</existing-summary>",
		"",
		"<transcript>",
		...work.spans.map(
			(span) => `<entry id="${span.entryId}" characters="${span.from}-${span.to}" of="${span.total}">\n${span.text}\n</entry>`,
		),
		"</transcript>",
		"",
		"Record this stretch of the transcript.",
	].join("\n");
}
