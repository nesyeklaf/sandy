/**
 * What a session cost, read from its pi session log: the numbers that tell whether cutting per task
 * saves tokens. Pure: the caller reads the files.
 */
import { accountingEvents, type AccountingEvent, type CostReport, formatCostReport, reduceAccounting } from "./accounting.ts";
import { type CapShadowReport, formatCapShadowReport, reduceCapShadow } from "./kept-cap.ts";
import { cutReason } from "./records.ts";
import { combineRetrieval, formatRetrievalReport, reduceRetrieval, type RetrievalEvent, type RetrievalReport, retrievalEvents } from "./retrieval.ts";
import { mergeEntries, parseEntries, type RawEntry } from "./session-entries.ts";

/**
 * The main model's answers only, a series older than the cost report: no historian, warming, compaction or tool
 * usage, and no cost. The cost is the cost report's.
 */
export interface SessionMeasure {
	requests: number;
	/** Every token sent as prompt: uncached input, cache reads and cache writes. */
	promptTokens: number;
	cacheRead: number;
	/** Cuts by the reason in their summary head (watermark, cold, task, …); foreign compactions count as "other". */
	cuts: Record<string, number>;
	/** Prompt tokens spent between two task cuts, one entry per finished task. Empty until a task cut happens. */
	taskSpans: number[];
}

interface Usage {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export const measureSession = (lines: readonly string[]): SessionMeasure => measureEntries(parseEntries(lines));

export function measureEntries(entries: readonly RawEntry[]): SessionMeasure {
	const m: SessionMeasure = { requests: 0, promptTokens: 0, cacheRead: 0, cuts: {}, taskSpans: [] };
	let sinceTaskCut = 0;
	for (const entry of entries as readonly { type?: string; summary?: string; message?: { role?: string; usage?: Usage } }[]) {
		if (entry.type === "compaction") {
			const reason = cutReason(entry.summary?.split("\n", 1)[0] ?? "") ?? "other";
			m.cuts[reason] = (m.cuts[reason] ?? 0) + 1;
			if (reason === "task") {
				m.taskSpans.push(sinceTaskCut);
				sinceTaskCut = 0;
			}
			continue;
		}
		const usage = entry.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;
		if (!usage) continue;
		const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		m.requests++;
		m.promptTokens += prompt;
		m.cacheRead += usage.cacheRead ?? 0;
		sinceTaskCut += prompt;
	}
	return m;
}

/** Sums sessions; cache hit is cache reads over prompt tokens. */
export function totals(sessions: readonly SessionMeasure[]) {
	const t = { sessions: sessions.length, requests: 0, promptTokens: 0, cacheRead: 0, cuts: {} as Record<string, number>, taskSpans: [] as number[] };
	for (const s of sessions) {
		t.requests += s.requests;
		t.promptTokens += s.promptTokens;
		t.cacheRead += s.cacheRead;
		for (const [k, v] of Object.entries(s.cuts)) t.cuts[k] = (t.cuts[k] ?? 0) + v;
		t.taskSpans.push(...s.taskSpans);
	}
	return { ...t, cacheHit: t.promptTokens === 0 ? 0 : t.cacheRead / t.promptTokens, promptPerRequest: t.requests === 0 ? 0 : t.promptTokens / t.requests };
}

/**
 * One session log for the report: its lines, its path (to find the session a fork came from), and the ids of the
 * entries a fixture's agent needed, when the fixture says.
 */
export interface SessionSource {
	readonly lines: readonly string[];
	readonly path?: string;
	readonly needed?: readonly string[];
}

/**
 * The one report over sessions: what they cost, with the charges nobody recorded, the three retrieval measures,
 * kept apart by basis: fixture sessions labelled with what was needed, live sessions by the proxy. Never mixed, and
 * the kept-history cap's shadow counters over all of them.
 */
export interface SessionsReport {
	readonly cost: CostReport;
	readonly retrieval: { readonly labelled?: RetrievalReport; readonly proxy?: RetrievalReport };
	/** The main model's answers, the older series (see {@link SessionMeasure}); each request once, as in the cost. */
	readonly main: ReturnType<typeof totals>;
	readonly cap: CapShadowReport;
}

/** The session file a fork was made from, as its header names it. */
function parentOf(entries: readonly RawEntry[]): string | undefined {
	const header = entries.find((entry) => entry.type === "session") as { parentSession?: unknown } | undefined;
	return typeof header?.parentSession === "string" ? header.parentSession : undefined;
}

const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

/**
 * A session family: every entry once (for what each request cost), and the same entries again for each retrieval
 * context, as a label belongs to its own session and never to a fork or sibling that has none.
 */
interface Family {
	readonly entries: RawEntry[];
	readonly contexts: { readonly entries: RawEntry[]; readonly needed?: Set<string> }[];
}

/**
 * The sessions grouped into families: a fork (`createBranchedSession`) copies its ancestors into a new file under the
 * same entry ids, so a fork and the session it came from tell of the same requests. Each family is read as one
 * session, the session first and its forks after; each request in it counts once.
 */
function families(sessions: readonly SessionSource[]): Family[] {
	const parsed = sessions.map((session) => ({ session, entries: parseEntries(session.lines) }));
	const byPath = new Map<string, number>();
	parsed.forEach(({ session }, index) => {
		if (session.path === undefined) return;
		byPath.set(session.path, index);
		if (!byPath.has(fileName(session.path))) byPath.set(fileName(session.path), index);
	});
	/** Without a path to match, a fork's parent is the session that holds the first entry the fork copied. */
	const idOf = (entry: RawEntry): string | undefined => {
		const id = (entry as { id?: unknown }).id;
		return entry.type !== "session" && typeof id === "string" ? id : undefined;
	};
	const holder = new Map<string, number[]>();
	parsed.forEach(({ entries }, index) => {
		for (const entry of entries) {
			const id = idOf(entry);
			if (id !== undefined) holder.set(id, [...(holder.get(id) ?? []), index]);
		}
	});
	const parentIndex = parsed.map(({ entries }, index) => {
		const parent = parentOf(entries);
		if (parent === undefined) return undefined;
		const found = byPath.get(parent) ?? byPath.get(fileName(parent));
		if (found !== undefined) return found === index ? undefined : found;
		const first = entries.map(idOf).find((id) => id !== undefined);
		return first === undefined ? undefined : holder.get(first)?.find((other) => other !== index);
	});
	/** One family per set of sessions linked by a parent, whichever way the links run. */
	const link = parsed.map((_, index) => index);
	const find = (index: number): number => {
		let at = index;
		while (link[at] !== at) at = link[at] as number;
		return at;
	};
	parentIndex.forEach((parent, index) => {
		if (parent !== undefined) link[find(index)] = find(parent);
	});
	const depthOf = (index: number): number => {
		let depth = 0;
		const seen = new Set<number>([index]);
		for (let parent = parentIndex[index]; parent !== undefined && !seen.has(parent); parent = parentIndex[parent]) {
			seen.add(parent);
			depth++;
		}
		return depth;
	};
	const groups = new Map<number, number[]>();
	parsed.forEach((_, index) => {
		const root = find(index);
		groups.set(root, [...(groups.get(root) ?? []), index]);
	});
	return [...groups.values()].map((members) => {
		const ordered = [...members].sort((a, b) => depthOf(a) - depthOf(b) || a - b);
		const entriesOf = (indexes: readonly number[]) => mergeEntries(indexes.map((index) => parsed[index]?.entries ?? []));
		/** Members with the same labels (or none) read as one: a copied ancestor counts once there. */
		const byContext = new Map<string, number[]>();
		for (const index of ordered) {
			const needed = parsed[index]?.session.needed;
			const key = needed === undefined ? "" : JSON.stringify([...new Set(needed)].sort());
			byContext.set(key, [...(byContext.get(key) ?? []), index]);
		}
		return {
			entries: entriesOf(ordered),
			contexts: [...byContext.values()].map((indexes) => {
				const needed = parsed[indexes[0] as number]?.session.needed;
				return { entries: entriesOf(indexes), ...(needed !== undefined ? { needed: new Set(needed) } : {}) };
			}),
		};
	});
}

/**
 * The cost and retrieval report of session logs, the same reducers `/context` runs on the live session. A session and
 * its forks are one family and count each request once; families are read apart, so a cut or a read in one never
 * reaches into the next, and a label counts only in the sessions that have it: retrieval is reduced once per label
 * context of a family, so an unlabelled fork of a labelled session stays a proxy session. Labelled sessions and proxy sessions
 * are reported apart.
 */
export function reportSessions(sessions: readonly SessionSource[]): SessionsReport {
	const accounting: AccountingEvent[] = [];
	const labelled: RetrievalReport[] = [];
	const proxy: RetrievalReport[] = [];
	const main: SessionMeasure[] = [];
	const capEvents: RetrievalEvent[] = [];
	for (const family of families(sessions)) {
		accounting.push(...accountingEvents(family.entries));
		for (const event of retrievalEvents(family.entries)) capEvents.push(event);
		for (const context of family.contexts) {
			const events = retrievalEvents(context.entries);
			if (context.needed) labelled.push(reduceRetrieval(events, { needed: context.needed }));
			else proxy.push(reduceRetrieval(events));
		}
		main.push(measureEntries(family.entries));
	}
	return {
		cost: reduceAccounting(accounting),
		retrieval: {
			...(labelled.length > 0 ? { labelled: combineRetrieval(labelled) } : {}),
			...(proxy.length > 0 ? { proxy: combineRetrieval(proxy) } : {}),
		},
		main: totals(main),
		cap: reduceCapShadow(capEvents),
	};
}

export function formatSessionsReport(report: SessionsReport): string[] {
	const { labelled, proxy } = report.retrieval;
	const retrieval = [labelled, proxy].filter((part): part is RetrievalReport => part !== undefined);
	return [...formatCostReport(report.cost), ...(retrieval.length > 0 ? retrieval : [reduceRetrieval([])]).flatMap(formatRetrievalReport), ...formatCapShadowReport(report.cap)];
}
