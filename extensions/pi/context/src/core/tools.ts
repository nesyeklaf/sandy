/**
 * The agent's three tools over the session log: history_search, history_read and notebook.
 *
 * Their names, texts and bounds are defined here once; an adapter declares the parameter schemas
 * (`src/tools/schemas.ts`), reads the log and stores a notebook write. Everything below is a
 * function of what the adapter hands over, so no adapter copies the tools.
 */
import { inverseDocumentFrequency, type SearchHit, snippet, termScore, tokenize, TopHits } from "./search.ts";
import { formatTime, label, oneLine, renderFull, renderMasked, searchableText } from "./serialize.ts";
import type { LogEntry } from "./types.ts";

/** Results a search returns unless asked for fewer or more. */
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 30;
/** Entries one search scans, newest first; a longer history answers with a cursor to the older ones. */
export const SEARCH_SCAN_LIMIT = 2_000;
/** Entries per page a scan reads, from a log in memory or from storage. */
export const SCAN_PAGE = 256;
export const READ_AROUND_MAX = 10;
export const READ_CHARS = { min: 500, max: 60_000, default: 12_000 } as const;

export const TOOLS = {
	historySearch: {
		name: "history_search",
		label: "History search",
		description: `Search this session's complete history, including everything that has left your context: user messages, your messages and tool calls, and tool output. Keyword search (BM25): exact identifiers, file paths and error text work best. A #id in the query finds that entry directly. Returns entry ids with snippets; read an entry in full with history_read.`,
		promptSnippet: "Search the complete session history, including what has left your context",
		parameters: {
			query: "Keywords to look for",
			limit: `Maximum results, default ${SEARCH_LIMIT_DEFAULT}, at most ${SEARCH_LIMIT_MAX}`,
			includeVisible:
				"Also search history that is still in your context. Default: archived history only, once anything is archived.",
			cursor: "Entry id from an earlier answer: search only older entries",
		},
	},
	historyRead: {
		name: "history_read",
		label: "History read",
		description:
			"Read one entry of this session's history in full by its id (from history_search or a #id reference in your context), optionally with neighboring entries.",
		promptSnippet: "Read an entry of the session history in full by its #id",
		parameters: {
			id: "Entry id, with or without the leading #",
			around: "Also list this many entries before and after, compactly. Default 0",
			offset: "Character offset into a long entry",
			maxChars: `Characters to return, default ${READ_CHARS.default}`,
		},
	},
	notebook: {
		name: "notebook",
		label: "Notebook",
		description:
			"Your notebook: working state that must survive when older history leaves your context, such as the goal, constraints the user set, decisions, the plan and where you are in it. It is carried verbatim into your context at every cut. Call without text to read it, with text to replace it completely; an empty string clears it. Keep it short and current.",
		promptSnippet: "Keep working state that must survive context cuts",
		parameters: { text: "New notebook content; replaces the old content" },
	},
} as const;

const OWN_TOOLS: ReadonlySet<string> = new Set([TOOLS.historySearch.name, TOOLS.historyRead.name]);

/** What the search sees of an entry: the history tools' own calls and answers would only find themselves again. */
export function historyText(entry: LogEntry): string {
	if (entry.kind === "tool" && OWN_TOOLS.has(entry.toolName ?? "")) return "";
	return searchableText({ ...entry, toolCalls: entry.toolCalls.filter((call) => !OWN_TOOLS.has(call.name)) });
}

/** The error for an ID the history does not hold. */
export function noEntry(id: string): Error {
	return new Error(`No entry #${id} on the current branch of this session.`);
}

/** The log read newest first in pages of `size`, from the entry before `beforeId` when it is given. */
export function newestFirstPages(
	entries: readonly LogEntry[],
	size = SCAN_PAGE,
	beforeId?: string,
): Iterable<readonly LogEntry[]> {
	const end = beforeId === undefined ? entries.length : entries.findIndex((entry) => entry.id === beforeId);
	if (end < 0) throw noEntry(beforeId ?? "");
	return pagesBelow(entries, end, size);
}

/** The log read newest first in pages of `size`, from the entry `id` itself; nothing when the log does not hold it. */
export function newestFirstPagesFrom(
	entries: readonly LogEntry[],
	id: string,
	size = SCAN_PAGE,
): Iterable<readonly LogEntry[]> {
	return pagesBelow(entries, entries.findIndex((entry) => entry.id === id) + 1, size);
}

function* pagesBelow(entries: readonly LogEntry[], end: number, size: number): Iterable<readonly LogEntry[]> {
	for (let to = end; to > 0; to -= size) yield entries.slice(Math.max(0, to - size), to).reverse();
}

export interface HistoryQuery {
	readonly query: string;
	/** Hits to return, at most `SEARCH_LIMIT_MAX`; default `SEARCH_LIMIT_DEFAULT`. */
	readonly limit?: number;
	/** Entries to scan, default `SEARCH_SCAN_LIMIT`. */
	readonly scanLimit?: number;
	/** Restrict hits, for example to entries that left the model context. Entries it refuses still count in the ranking. */
	readonly accept?: (id: string) => boolean;
}

export interface HistoryHits {
	/** Entries named by `#id` in the query first, with an infinite score, then the ranked ones. */
	readonly hits: SearchHit[];
	readonly scanned: number;
	/** The oldest entry scanned, when older ones remain: search again from the entries before it. */
	readonly cursor?: string;
}

/** The distinct `#id` references of a query, in order; an entry decides whether one is an id. */
function referencedIds(query: string): string[] {
	const ids = [...query.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1] ?? "");
	return [...new Set(ids)].slice(0, SEARCH_LIMIT_MAX);
}

/** The hits a search returns for the `limit` it was asked for. */
const hitLimit = (limit: number | undefined) => Math.min(Math.max(1, limit ?? SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX);

type PageSource = AsyncIterable<readonly LogEntry[]> | Iterable<readonly LogEntry[]>;
type Pages = () => PageSource;
/**
 * The pages of a log read newest first from the entry `id` itself, on the branch the search reads. They start at an
 * older entry, or yield nothing, when the branch does not hold `id`.
 */
export type PagesFrom = (id: string) => PageSource;

/**
 * Rank the pages of a log, given newest first, by BM25 as `SearchIndex` would rank the same entries.
 * `pages` is called twice and must yield the same entries both times. The first pass counts the
 * documents, their lengths and the documents holding each query term; the second scores them,
 * keeping the best hits in a heap. Memory is bounded by the page and the hit limit, whatever the
 * length of the history.
 */
export async function searchHistory(pages: Pages, search: HistoryQuery): Promise<HistoryHits> {
	const limit = hitLimit(search.limit);
	const scanLimit = search.scanLimit ?? SEARCH_SCAN_LIMIT;
	const terms = [...new Set(tokenize(search.query))];
	const queryTerms: ReadonlySet<string> = new Set(terms);
	const referenced = referencedIds(search.query);
	const found = new Set<string>();
	const holding = new Map<string, number>();
	let scanned = 0;
	let totalLength = 0;
	let oldest: string | undefined;
	let more = false;

	scan: for await (const page of pages()) {
		for (const entry of page) {
			if (scanned === scanLimit) {
				more = true;
				break scan;
			}
			scanned++;
			oldest = entry.id;
			if (referenced.includes(entry.id)) found.add(entry.id);
			if (terms.length === 0) continue;
			const tokens = tokenize(historyText(entry));
			totalLength += tokens.length;
			for (const term of new Set(tokens)) if (queryTerms.has(term)) holding.set(term, (holding.get(term) ?? 0) + 1);
		}
	}

	const named = referenced.filter((id) => found.has(id)).map((id) => ({ id, score: Number.POSITIVE_INFINITY }));
	const best = new TopHits(limit);
	if (holding.size > 0) {
		const averageLength = totalLength / scanned || 1;
		const weight = new Map([...holding].map(([term, count]) => [term, inverseDocumentFrequency(scanned, count)]));
		let position = 0;
		rank: for await (const page of pages()) {
			for (const entry of page) {
				if (position === scanned) break rank;
				const order = -position++;
				if (search.accept && !search.accept(entry.id)) continue;
				const tokens = tokenize(historyText(entry));
				const frequency = new Map<string, number>();
				for (const token of tokens) if (queryTerms.has(token)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
				if (frequency.size === 0) continue;
				let score = 0;
				for (const term of terms) {
					const count = frequency.get(term);
					if (count) score += termScore(weight.get(term) ?? 0, count, tokens.length, averageLength);
				}
				best.offer({ id: entry.id, score, order });
			}
		}
	}
	const hits = [...named, ...best.sorted().filter((hit) => !found.has(hit.id))].slice(0, limit);
	return { hits, scanned, ...(more && oldest !== undefined ? { cursor: oldest } : {}) };
}

/** A hit with the entry that opened its turn, for the context line. */
export interface FoundEntry {
	readonly entry: LogEntry;
	readonly turn?: LogEntry;
}

/**
 * The entries of hits, each with the user message that opened its turn, from the pages of a log read newest first. The
 * scan stops at the user message before the oldest hit, so it holds no more than the hits.
 */
export async function findEntries(pages: Pages, hits: readonly SearchHit[]): Promise<FoundEntry[]> {
	const wanted = new Set(hits.map((hit) => hit.id));
	const found = new Map<string, LogEntry>();
	const turns = new Map<string, LogEntry>();
	let waiting: string[] = [];
	scan: for await (const page of pages()) {
		for (const entry of page) {
			if (found.size === wanted.size && waiting.length === 0) break scan;
			if (entry.kind === "user") {
				for (const id of waiting) turns.set(id, entry);
				waiting = [];
			}
			if (!wanted.has(entry.id) || found.has(entry.id)) continue;
			found.set(entry.id, entry);
			if (entry.kind !== "user") waiting.push(entry.id);
		}
	}
	return hits.flatMap((hit) => {
		const entry = found.get(hit.id);
		if (!entry) return [];
		const turn = turns.get(hit.id);
		return [turn ? { entry, turn } : { entry }];
	});
}

/** The entry `id` with the user message that opened its turn, read from pages that start at it. */
async function findFrom(from: PagesFrom, id: string): Promise<FoundEntry | undefined> {
	let entry: LogEntry | undefined;
	for await (const page of from(id)) {
		for (const candidate of page) {
			if (entry !== undefined) {
				if (candidate.kind === "user") return { entry, turn: candidate };
			} else if (candidate.id !== id) return undefined;
			else if (candidate.kind === "user") return { entry: candidate };
			else entry = candidate;
		}
	}
	return entry && { entry };
}

export interface SearchReply {
	readonly query: string;
	readonly archivedOnly: boolean;
	readonly found: readonly FoundEntry[];
	readonly scanned: number;
	readonly cursor?: string;
}

/** The text of a search answer and the ids it lists. */
export function renderSearch(reply: SearchReply): { text: string; hits: string[] } {
	const scope = reply.archivedOnly ? "archived history" : "the whole session";
	const more =
		reply.cursor === undefined
			? ""
			: `\n\nOnly the newest ${reply.scanned} entries were searched. For older ones call ${TOOLS.historySearch.name} again with the same query and cursor="${reply.cursor}".`;
	if (reply.found.length === 0) {
		const text = `No matches for "${reply.query}" in ${scope}. Try other keywords: identifiers, file names, error text.${more}`;
		return { text, hits: [] };
	}
	const lines = reply.found.map(({ entry, turn }) => {
		const context = turn ? `\n  in the turn of #${turn.id}: ${oneLine(turn.text, 120)}` : "";
		return `#${entry.id} · ${label(entry)} · ${formatTime(entry.timestamp)}\n  ${snippet(searchableText(entry), reply.query)}${context}`;
	});
	const text = `${lines.length} matches in ${scope} for "${reply.query}":\n\n${lines.join("\n\n")}\n\nRead one in full with ${TOOLS.historyRead.name}.${more}`;
	return { text, hits: reply.found.map(({ entry }) => entry.id) };
}

/** The parameters of one history_search, as the tool receives them. */
export interface SearchParameters {
	readonly query: string;
	readonly limit?: number;
	readonly includeVisible?: boolean;
}

/**
 * One history_search over the pages of a log read newest first: rank, find the hits' entries and render the answer.
 * `archived` tells whether an entry left the model context, undefined while nothing has; the search keeps to those
 * entries unless the agent asks for visible history too. A `#id` the scan did not reach is read through `from`, so an
 * entry is found by its ID whatever the length of the history.
 */
export async function answerSearch(
	pages: Pages,
	from: PagesFrom,
	parameters: SearchParameters,
	archived: ((id: string) => boolean) | undefined,
): Promise<{ text: string; hits: string[] }> {
	const archivedOnly = archived !== undefined && parameters.includeVisible !== true;
	const found = await searchHistory(pages, {
		query: parameters.query,
		...(parameters.limit !== undefined ? { limit: parameters.limit } : {}),
		...(archivedOnly ? { accept: archived } : {}),
	});
	const limit = hitLimit(parameters.limit);
	const listed = new Set(found.hits.map((hit) => hit.id));
	const unreached = referencedIds(parameters.query).filter((id) => !listed.has(id));
	const direct: FoundEntry[] = [];
	for (const id of unreached.slice(0, limit)) {
		const entry = await findFrom(from, id);
		if (entry !== undefined) direct.push(entry);
	}
	return renderSearch({
		query: parameters.query,
		archivedOnly,
		found: [...direct, ...(await findEntries(pages, found.hits))].slice(0, limit),
		scanned: found.scanned,
		...(found.cursor !== undefined ? { cursor: found.cursor } : {}),
	});
}

export interface HistoryRead {
	readonly id: string;
	readonly around?: number;
	readonly offset?: number;
	readonly maxChars?: number;
}

/** One entry in full, from its id or a unique prefix of four characters or more, with compact neighbors. */
export function readHistory(entries: readonly LogEntry[], read: HistoryRead): { id: string; text: string } {
	const wanted = read.id.trim().replace(/^#/, "");
	let at = entries.findIndex((entry) => entry.id === wanted);
	if (at < 0 && wanted.length >= 4) {
		const matches = entries.flatMap((entry, position) => (entry.id.startsWith(wanted) ? [position] : []));
		if (matches.length === 1) at = matches[0] ?? -1;
	}
	const entry = entries[at];
	if (!entry) throw noEntry(wanted);
	const full = renderFull(entry);
	const offset = read.offset ?? 0;
	const body = full.slice(offset, offset + (read.maxChars ?? READ_CHARS.default));
	const rest = full.length - offset - body.length;
	const more =
		rest > 0
			? `\n[${rest} more characters: ${TOOLS.historyRead.name} id=${entry.id} offset=${offset + body.length}]`
			: "";
	const around = read.around ?? 0;
	const before = entries.slice(Math.max(0, at - around), at).map(renderMasked);
	const after = entries.slice(at + 1, at + 1 + around).map(renderMasked);
	const parts = [
		before.length > 0 ? `Before:\n${before.join("\n")}` : "",
		`${body}${more}`,
		after.length > 0 ? `After:\n${after.join("\n")}` : "",
	].filter((part) => part !== "");
	return { id: entry.id, text: parts.join("\n\n") };
}

/** What a read of the notebook shows. */
export function notebookView(current: string): string {
	return current === "" ? "(the notebook is empty)" : current;
}

/**
 * The notebook a stored entry holds, or undefined when its data is not exactly `{ text }` within `maxBytes`: whoever
 * wrote it, the reader trusts no more than the tool would have accepted.
 */
export function readNotebook(data: unknown, maxBytes: number): string | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const { text, ...rest } = data as { text?: unknown };
	if (typeof text !== "string" || Object.keys(rest).length > 0) return undefined;
	return checkNotebook(text, maxBytes).ok ? text : undefined;
}

/** Whether a notebook write fits `maxBytes`, and what to tell the agent. */
export function checkNotebook(text: string, maxBytes: number): { ok: boolean; message: string } {
	const bytes = new TextEncoder().encode(text).length;
	if (bytes > maxBytes) {
		return {
			ok: false,
			message: `Notebook too long: ${bytes} bytes, the limit is ${maxBytes}. Shorten it; details belong in the session log, which stays searchable.`,
		};
	}
	return {
		ok: true,
		message:
			text === ""
				? "Notebook cleared."
				: `Notebook saved (${bytes} bytes). It is carried into your context whenever older history is archived.`,
	};
}
