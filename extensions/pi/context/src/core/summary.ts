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

export interface SummaryState {
	readonly version: 1;
	/** Last log entry the summary covers. */
	readonly coveredThroughId: string;
	readonly sections: SummarySections;
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
 */
export function applyCondensed(
	summary: SummaryState,
	selection: CondenseSelection,
	condensed: SummaryDelta,
): SummaryState {
	const sections = emptySections();
	for (const { key } of SECTIONS) {
		const current = summary.sections[key];
		const group = selection[key] ?? [];
		const replacement = condensed[key] ?? [];
		const shorter =
			replacement.length > 0 &&
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
	return { version: 1, coveredThroughId: candidate.coveredThroughId, sections };
}
