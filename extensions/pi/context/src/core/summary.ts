import { estimateTokens } from "./tokens.ts";

/**
 * The anchored summary. The historian only ever summarizes the new stretch; its items merge
 * into fixed sections by rule, so an older detail is never paraphrased away by a rewrite
 * (the failure ACE calls context collapse, arXiv 2510.04618). State sections replace,
 * record sections append. When the summary outgrows its budget its oldest records are
 * condensed into fewer items that keep their entry ids (see condenseSelection); only if that
 * fails are they dropped. Either way they stay in the log.
 */
export const SECTIONS = [
	{ key: "goal", title: "Goal and how it changed", mode: "append" },
	{ key: "state", title: "Current state", mode: "replace" },
	{ key: "chapters", title: "Chapters", mode: "append" },
	{ key: "decisions", title: "Decisions", mode: "append" },
	{ key: "facts", title: "Facts and findings", mode: "append" },
	{ key: "errors", title: "Errors and fixes", mode: "append" },
	{ key: "next", title: "Open threads", mode: "replace" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];
export type SummarySections = Readonly<Record<SectionKey, readonly string[]>>;
export type SummaryDelta = Partial<Record<SectionKey, string[]>>;

/** A stretch of entries a summary describes, and a hash of how they read when it was written. */
export interface SourceStretch {
	readonly fromId: string;
	readonly throughId: string;
	readonly digest: string;
}

/** An entry summarized only up to `offset` characters of its rendering; the rest is still to do. */
export interface PartialEntry {
	readonly entryId: string;
	readonly offset: number;
	readonly digest: string;
}

export interface SummaryState {
	readonly version: 1;
	/** Last log entry the summary covers completely; empty when none is complete yet. */
	readonly coveredThroughId: string;
	readonly sections: SummarySections;
	/** The stretches described and their digests. A summary without them is trusted only by the edit rule of the session reader. */
	readonly sources?: readonly SourceStretch[];
	/** The entry after `coveredThroughId` that is summarized in part. */
	readonly partial?: PartialEntry;
	/** The foreign checkpoint this summary stands in for once it covers everything the checkpoint summarized. */
	readonly supersedes?: string;
	/**
	 * Stretches the coverage passed whose items were dropped because an entry in them was edited or omitted: they are
	 * summarized again from the history as it reads now, oldest first, and a cut archives them without summary until then.
	 */
	readonly unsummarized?: readonly UnsummarizedStretch[];
}

/** A stretch to summarize again, from `fromId` through `throughId` in branch order; `offset` and `digest` mark how far into `fromId` it was summarized. */
export interface UnsummarizedStretch {
	readonly fromId: string;
	readonly throughId: string;
	readonly offset?: number;
	readonly digest?: string;
}

/** The parenthesis that ends an item and cites its sources, optionally followed by one closing mark of its sentence. */
const CITATION = /\(([^()]*#[^()]*)\)[.,;:]?\s*$/;

/**
 * The entry ids an item cites: the ones in the parenthesis that ends it, like `(#1a2b3c4d)` or
 * `(#1a2b3c4d, #9f8e7d6c)` or `(#1a2b3c4d … #9f8e7d6c)`, also before a closing `.`, `,`, `;` or `:`. These are what
 * the item depends on.
 */
export function citedIds(item: string, order?: ReadonlyMap<string, number>): string[] {
	const tail = CITATION.exec(item);
	if (!tail) return [];
	const text = tail[1] ?? "";
	const ids = [...text.matchAll(/#([A-Za-z0-9][\w-]*)/g)].map((match) => match[1] as string);
	if (!order) return ids;
	// A range `#a … #b` stands for every entry between its ends in the history's order.
	const all = new Set(ids);
	for (const [, from, through] of text.matchAll(/#([A-Za-z0-9][\w-]*)\s*(?:…|\.\.\.)\s*#([A-Za-z0-9][\w-]*)/g)) {
		const start = order.get(from as string);
		const end = order.get(through as string);
		if (start === undefined || end === undefined) continue;
		for (const [id, at] of order) if (at >= start && at <= end) all.add(id);
	}
	return [...all];
}

/**
 * The ids from `fromId` through `throughId` in `order`, oldest first; undefined when either end is not in it or the
 * ends are reversed.
 */
export function idsBetween(order: ReadonlyMap<string, number>, fromId: string, throughId: string): string[] | undefined {
	const start = order.get(fromId);
	const end = order.get(throughId);
	if (start === undefined || end === undefined || start > end) return undefined;
	const { ids, index } = sequenceOf(order);
	return ids.slice(index.get(fromId), (index.get(throughId) as number) + 1);
}

/** An order's ids sorted by place, with each id's index in them; built once per order, so a stretch costs its length. */
const sequences = new WeakMap<ReadonlyMap<string, number>, { ids: string[]; index: Map<string, number> }>();
function sequenceOf(order: ReadonlyMap<string, number>): { ids: string[]; index: Map<string, number> } {
	let sequence = sequences.get(order);
	if (sequence?.ids.length !== order.size) {
		const ids = [...order.keys()].sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
		sequence = { ids, index: new Map(ids.map((id, at) => [id, at])) };
		sequences.set(order, sequence);
	}
	return sequence;
}

/** The summary without the items that cite one of `ids`: what they say came from entries that read differently now. */
export function withoutCiting(
	summary: SummaryState,
	ids: ReadonlySet<string>,
	order?: ReadonlyMap<string, number>,
): SummaryState {
	const sections = emptySections();
	for (const { key } of SECTIONS) {
		sections[key] = summary.sections[key].filter((item) => !citedIds(item, order).some((id) => ids.has(id)));
	}
	return { ...summary, sections };
}

const ALIASES: Readonly<Record<string, SectionKey>> = {
	goal: "goal",
	goals: "goal",
	goalandhowitchanged: "goal",
	currentstate: "state",
	state: "state",
	status: "state",
	decisions: "decisions",
	factsandfindings: "facts",
	facts: "facts",
	findings: "facts",
	errorsandfixes: "errors",
	errors: "errors",
	openthreads: "next",
	openthreadsandnextsteps: "next",
	nextsteps: "next",
	next: "next",
	chapters: "chapters",
	chapter: "chapters",
	topic: "chapters",
};

const EMPTY_ITEMS = new Set(["none", "n/a", "na", "nothing", "nothing new", "-"]);

export function emptySections(): Record<SectionKey, string[]> {
	return { goal: [], state: [], chapters: [], decisions: [], facts: [], errors: [], next: [] };
}

/** Read the historian's markdown: known headings, bullet items, continuation lines. Unknown sections are ignored. */
export function parseSummaryDelta(text: string): SummaryDelta {
	const delta: SummaryDelta = {};
	let current: string[] | undefined;
	for (const line of text.split(/\r?\n/)) {
		const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			const key = ALIASES[(heading[1] ?? "").toLowerCase().replace(/[^a-z]/g, "")];
			current = key ? (delta[key] ??= []) : undefined;
			continue;
		}
		if (!current) continue;
		const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
		const content = (bullet ? (bullet[1] ?? "") : line).trim();
		if (content === "") continue;
		if (bullet || current.length === 0) current.push(content);
		else current[current.length - 1] += ` ${content}`;
	}
	// A section written as "none" stays in the delta, empty, so a replaced section clears; one left blank says nothing.
	for (const key of Object.keys(delta) as SectionKey[]) {
		const items = delta[key] ?? [];
		if (items.length === 0) delete delta[key];
		else delta[key] = items.filter((item) => !EMPTY_ITEMS.has(item.toLowerCase().replace(/[.!]$/, "")));
	}
	return delta;
}

/** Merge a historian delta. The result may exceed the budget; condense or fit it afterwards. */
export function mergeSummary(
	previous: SummaryState | undefined,
	delta: SummaryDelta,
	coveredThroughId: string,
): SummaryState {
	const sections = emptySections();
	for (const { key, mode } of SECTIONS) {
		const before = previous?.sections[key] ?? [];
		const added = delta[key] ?? [];
		if (mode === "replace") {
			sections[key] = key in delta ? [...added] : [...before];
		} else {
			const seen = new Set(before);
			sections[key] = [...before, ...added.filter((item) => !seen.has(item))];
		}
	}
	return { version: 1, coveredThroughId, sections };
}

const keysOf = (mode: "append" | "replace"): readonly SectionKey[] =>
	SECTIONS.filter((section) => section.mode === mode).map((section) => section.key);
const APPEND_KEYS = keysOf("append");
const REPLACE_KEYS = keysOf("replace");

/** Condensing aims below the budget so that it does not run again after every historian pass. */
export const CONDENSE_TARGET = 0.6;

export function summaryTokens(summary: SummaryState): number {
	return estimateTokens(renderSummary(summary.sections));
}

/** The oldest records of each record section, chosen to be condensed together. */
export type CondenseSelection = Partial<Record<SectionKey, readonly string[]>>;

/**
 * Which records to condense when the summary is over budget, or undefined when it fits or
 * nothing can be condensed. Takes the oldest items of the section with the most tokens until
 * the summary would drop to CONDENSE_TARGET of the budget. A section contributes at least two
 * items, since condensing one item into one saves nothing.
 */
export function condenseSelection(summary: SummaryState, budgetTokens: number): CondenseSelection | undefined {
	const total = summaryTokens(summary);
	if (total <= budgetTokens) return undefined;
	let excess = total - Math.floor(budgetTokens * CONDENSE_TARGET);
	const taken: Partial<Record<SectionKey, number>> = {};
	const remaining = (key: SectionKey) =>
		summary.sections[key].slice(taken[key] ?? 0).reduce((sum, item) => sum + estimateTokens(item), 0);
	while (excess > 0) {
		let largest: SectionKey | undefined;
		for (const key of APPEND_KEYS) {
			const left = summary.sections[key].length - (taken[key] ?? 0);
			if (left < ((taken[key] ?? 0) === 0 ? 2 : 1)) continue;
			if (!largest || remaining(key) > remaining(largest)) largest = key;
		}
		if (!largest) break;
		const count = (taken[largest] ?? 0) === 0 ? 2 : 1;
		const start = taken[largest] ?? 0;
		for (const item of summary.sections[largest].slice(start, start + count)) excess -= estimateTokens(item) + 1;
		taken[largest] = start + count;
	}
	const selection: CondenseSelection = {};
	for (const key of APPEND_KEYS) {
		const count = taken[key] ?? 0;
		if (count > 0) selection[key] = summary.sections[key].slice(0, count);
	}
	return Object.keys(selection).length > 0 ? selection : undefined;
}

/**
 * Replace each selected group with its condensed items, which take the group's place at the
 * front of the section. A group the condenser left out or did not shorten stays unchanged.
 * `order` is the history's order of entries: a range, in the group or in its replacement, stands for every entry
 * between its ends. It is required: the order the group happens to cite its entries in says nothing about what lies
 * between a range's ends.
 */
export function applyCondensed(
	summary: SummaryState,
	selection: CondenseSelection,
	condensed: SummaryDelta,
	order: ReadonlyMap<string, number>,
): SummaryState {
	const sections = emptySections();
	for (const { key } of SECTIONS) {
		const current = summary.sections[key];
		const group = selection[key] ?? [];
		const replacement = condensed[key] ?? [];
		// The condensed items must cite everything the group cited, or an edit of a source would no longer find them.
		const depends = new Set(group.flatMap((item) => citedIds(item, order)));
		const cited = new Set(replacement.flatMap((item) => citedIds(item, order)));
		const keepsSources = [...depends].every((id) => cited.has(id));
		const shorter =
			replacement.length > 0 &&
			keepsSources &&
			replacement.reduce((sum, item) => sum + estimateTokens(item), 0) <
				group.reduce((sum, item) => sum + estimateTokens(item), 0);
		sections[key] = group.length > 0 && shorter ? [...replacement, ...current.slice(group.length)] : [...current];
	}
	return { ...summary, sections };
}

/**
 * Last resort when condensing failed or was not enough, and the guarantee every stored summary fits `budgetTokens`:
 * drop the oldest records of the largest record section, or, while the state sections alone outgrow the budget, the
 * newest items of the largest of those.
 */
export function fitToBudget(summary: SummaryState, budgetTokens: number): SummaryState {
	const sections = emptySections();
	for (const { key } of SECTIONS) sections[key] = [...summary.sections[key]];
	trimToBudget(sections, budgetTokens);
	return { ...summary, sections };
}

function trimToBudget(sections: Record<SectionKey, string[]>, budgetTokens: number): void {
	const fits = (kept: SummarySections) => estimateTokens(renderSummary(kept)) <= budgetTokens;
	const state = emptySections();
	while (!fits(sections)) {
		for (const key of REPLACE_KEYS) state[key] = sections[key];
		const stateFits = fits(state);
		const keys = stateFits ? APPEND_KEYS : REPLACE_KEYS;
		let largest: SectionKey | undefined;
		for (const key of keys) {
			if (sections[key].length > 0 && (!largest || sections[key].length > sections[largest].length)) largest = key;
		}
		if (!largest) return;
		if (stateFits) sections[largest].shift();
		else sections[largest].pop();
	}
}

export function renderSummary(sections: SummarySections): string {
	const parts: string[] = [];
	for (const { key, title } of SECTIONS) {
		const items = sections[key];
		if (items.length > 0) parts.push(`### ${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
	}
	return parts.join("\n\n");
}

/**
 * Read a summary back from storage; anything malformed is ignored rather than trusted.
 * A section missing from an older summary reads as empty.
 */
export function readSummaryState(value: unknown): SummaryState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { version?: unknown; coveredThroughId?: unknown; sections?: unknown };
	if (candidate.version !== 1 || typeof candidate.coveredThroughId !== "string") return undefined;
	if (typeof candidate.sections !== "object" || candidate.sections === null) return undefined;
	const stored = candidate.sections as Record<string, unknown>;
	const sections = emptySections();
	for (const { key } of SECTIONS) {
		const items = stored[key] ?? [];
		if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) return undefined;
		sections[key] = [...items];
	}
	const extras = readExtras(value as Record<string, unknown>);
	if (extras === undefined) return undefined;
	return { version: 1, coveredThroughId: candidate.coveredThroughId, sections, ...extras };
}

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * Why a stored summary cannot belong to the branch it is read on, or undefined when it can. Every entry it names
 * stands on the branch before the record, and every stretch runs forwards: a summary written on another branch, or
 * for entries that were never there, would hand its sections to the next historian answer, which keeps them under a
 * valid anchor. `place` gives the place of an entry that stands before the record, an entry behind a compaction
 * included; undefined for any other. The empty coverage of a summary that covers no entry completely names none.
 */
export function offBranchAnchor(
	state: SummaryState,
	projectedThroughId: string | undefined,
	place: (id: string) => number | undefined,
): string | undefined {
	const missing = (id: string) => place(id) === undefined;
	if (state.coveredThroughId !== "" && missing(state.coveredThroughId)) return `its coverage #${state.coveredThroughId}`;
	if (projectedThroughId !== undefined && missing(projectedThroughId)) return `its projection mark #${projectedThroughId}`;
	if (state.partial && missing(state.partial.entryId)) return `its partial entry #${state.partial.entryId}`;
	if (state.supersedes !== undefined && missing(state.supersedes)) return `the checkpoint #${state.supersedes} it supersedes`;
	for (const stretch of [...(state.sources ?? []), ...(state.unsummarized ?? [])]) {
		const from = place(stretch.fromId);
		const through = place(stretch.throughId);
		if (from === undefined || through === undefined || from > through) return `its stretch #${stretch.fromId}..#${stretch.throughId}`;
	}
	return undefined;
}

/** The optional fields of a stored summary; undefined when one is present and malformed. */
function readExtras(
	stored: Record<string, unknown>,
): Pick<SummaryState, "sources" | "partial" | "supersedes" | "unsummarized"> | undefined {
	const extras: { sources?: SourceStretch[]; partial?: PartialEntry; supersedes?: string; unsummarized?: UnsummarizedStretch[] } = {};
	if (stored.sources !== undefined) {
		if (!Array.isArray(stored.sources)) return undefined;
		const sources: SourceStretch[] = [];
		for (const one of stored.sources as Record<string, unknown>[]) {
			if (typeof one !== "object" || one === null) return undefined;
			if (!isText(one.fromId) || !isText(one.throughId) || !isText(one.digest)) return undefined;
			sources.push({ fromId: one.fromId, throughId: one.throughId, digest: one.digest });
		}
		extras.sources = sources;
	}
	if (stored.partial !== undefined) {
		const one = stored.partial as Record<string, unknown> | null;
		if (typeof one !== "object" || one === null) return undefined;
		if (!isText(one.entryId) || !isText(one.digest) || typeof one.offset !== "number" || !(one.offset > 0)) return undefined;
		extras.partial = { entryId: one.entryId, offset: one.offset, digest: one.digest };
	}
	if (stored.supersedes !== undefined) {
		if (!isText(stored.supersedes)) return undefined;
		extras.supersedes = stored.supersedes;
	}
	if (stored.unsummarized !== undefined) {
		if (!Array.isArray(stored.unsummarized)) return undefined;
		const gaps: UnsummarizedStretch[] = [];
		for (const one of stored.unsummarized as Record<string, unknown>[]) {
			if (typeof one !== "object" || one === null || !isText(one.fromId) || !isText(one.throughId)) return undefined;
			const started = one.offset !== undefined || one.digest !== undefined;
			if (started && (typeof one.offset !== "number" || !(one.offset > 0) || !isText(one.digest))) return undefined;
			gaps.push({ fromId: one.fromId, throughId: one.throughId, ...(started ? { offset: one.offset as number, digest: one.digest as string } : {}) });
		}
		extras.unsummarized = gaps;
	}
	return extras;
}
