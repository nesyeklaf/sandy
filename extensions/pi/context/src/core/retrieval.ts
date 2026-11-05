/**
 * The retrieval report: how an agent finds again what a cut took out of its prompt. Three measures, each from the
 * session log alone:
 * - re-reads after a cut: reads of a file whose earlier read a cut archived, read before the entry the cut kept from
 *   (as `/context`'s signal counts them). A compat series of an older count (206 of 3,470 reads in 30 days), kept apart.
 * - archive searches that find the entry: a search that returned something, and a search that returned the entry that
 *   was needed. Existence and relevance are separate numbers.
 * - tokens until the first relevant read: the fresh tokens the session spent from a cut to the first read of an
 *   entry that was needed.
 *
 * What counts as needed: a fixture labels its entries (hidden from the agent) and the report is labelled. A live
 * session has no label, so a search hit counts only when the same entry is read within the next two turns, a proxy.
 * Ten search hits that nobody reads are no recovered context.
 *
 * A session is a tree: a branch's search, read and cut count only for the entries after them on that branch, so the
 * reducer walks the tree and keeps each branch's state apart. Each event still counts once, on the one branch it is on.
 * Only a call that succeeded is a read; a failed one is counted apart.
 *
 * Pure: `retrievalEvents` reads session entries as pi stores them, `reduceRetrieval` counts events.
 */
import type { CapShadowRecord } from "./cap-record.ts";
import type { RawEntry } from "./session-entries.ts";
import { TOOLS } from "./tools.ts";
import { decodeContextRecord } from "./records.ts";

/** A hit is live evidence of relevance when its entry is read within this many turns of the search. */
export const PROXY_TURNS = 2;

export type RetrievalEvent =
	/** A new session starts: episodes and remembered reads do not carry over. */
	| { readonly kind: "session" }
	/**
	 * The events after this one happen at session entry `id`, a child of entry `parent`; `null` starts a branch at the
	 * session's root, a missing parent continues after the entry before. Without these events a session is one line.
	 */
	| { readonly kind: "at"; readonly id: string; readonly parent?: string | null }
	/** A cut; `keptFrom` is the first entry it kept, the entries before it on the branch were archived. */
	| { readonly kind: "cut"; readonly keptFrom?: string }
	/** What the kept-history cap would remove at the cut beside it (see reduceCapShadow). */
	| { readonly kind: "shadow"; readonly record: CapShadowRecord }
	/** One model request, with the fresh tokens it took in and put out (cache reads excluded). */
	| { readonly kind: "request"; readonly freshTokens: number }
	| { readonly kind: "search"; readonly call: string; readonly hits: readonly string[]; readonly nested: boolean }
	/** `ok` false: the read failed and found nothing again. */
	| { readonly kind: "read"; readonly call: string; readonly entryId: string; readonly nested: boolean; readonly ok?: boolean }
	| { readonly kind: "file"; readonly call: string; readonly path: string; readonly nested: boolean; readonly ok?: boolean };

export interface Episode {
	/** Searches and reads of entries since the cut, before the next cut, on every branch after the cut. */
	readonly searches: number;
	readonly reads: number;
	readonly relevantRead: boolean;
	/** Fresh tokens from the cut to the first relevant read, on the branch that got there cheapest; undefined when none came. */
	readonly tokensToFirstRelevantRead: number | undefined;
}

export interface RetrievalReport {
	/** `labelled` when a fixture says which entries were needed, `proxy` when a live session has to guess. */
	readonly basis: "labelled" | "proxy";
	readonly fileReads: number;
	readonly rereads: number;
	readonly rereadsNested: number;
	readonly entryReads: number;
	readonly entryReadsNested: number;
	/** Reads of entries or files that failed: attempts, not in the counts above. */
	readonly failedReads: number;
	readonly searches: { readonly total: number; readonly withHits: number; readonly relevant: number };
	/** One per cut. */
	readonly episodes: readonly Episode[];
	/** Episodes that ended in a relevant read. */
	readonly recovered: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;

/** The id an entry read names, without the leading `#`. */
const entryId = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value.replace(/^#/, "") : undefined);

/**
 * The retrieval events of one session's entries, oldest first. A call counts once by its id, whether the transcript or
 * a stored record of a nested call tells of it. Calls made by the model come from the transcript; calls made inside
 * another tool come from `RETRIEVAL_KIND` records, which survive a restart. A read counts for the entry the archive
 * resolved, which its result names, not for the prefix the model typed.
 */
export function retrievalEvents(raw: readonly RawEntry[]): RetrievalEvent[] {
	const entries = raw as readonly Readonly<Record<string, unknown>>[];
	const events: RetrievalEvent[] = [{ kind: "session" }];
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const seen = new Set<string>();
	const once = (call: string): boolean => {
		if (seen.has(call)) return false;
		seen.add(call);
		return true;
	};
	const search = (call: string, hits: readonly string[], nested: boolean) => once(call) && events.push({ kind: "search", call, hits, nested });
	const read = (call: string, id: string | undefined, nested: boolean, ok: boolean) => id !== undefined && once(call) && events.push({ kind: "read", call, entryId: id, nested, ok });
	const file = (call: string, path: unknown, nested: boolean, ok: boolean) => typeof path === "string" && path !== "" && once(call) && events.push({ kind: "file", call, path, nested, ok });

	for (const entry of entries) {
		if (typeof entry.id === "string") {
			const parent = typeof entry.parentId === "string" || entry.parentId === null ? entry.parentId : undefined;
			events.push(parent === undefined ? { kind: "at", id: entry.id } : { kind: "at", id: entry.id, parent });
		}
		if (entry.type === "compaction") {
			events.push(typeof entry.firstKeptEntryId === "string" ? { kind: "cut", keptFrom: entry.firstKeptEntryId } : { kind: "cut" });
			continue;
		}
		if (entry.type === "custom") {
			const record = decodeContextRecord(entry);
			if (record.kind === "cap-shadow") events.push({ kind: "shadow", record: record.shadow });
			if (record.kind !== "retrieval") continue;
			const { call, tool, ids, path, failed } = record.retrieval;
			if (tool === TOOLS.historySearch.name) search(call, ids ?? [], true);
			else if (tool === TOOLS.historyRead.name) read(call, ids?.[0], true, failed !== true);
			else file(call, path, true, failed !== true);
			continue;
		}
		if (entry.type !== "message" || !isObject(entry.message)) continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const usage = isObject(message.usage) ? message.usage : {};
			const fresh = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
			events.push({ kind: "request", freshTokens: fresh("input") + fresh("output") + fresh("cacheWrite") });
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (isObject(block) && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
					calls.set(block.id, { name: block.name, args: isObject(block.arguments) ? block.arguments : {} });
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const call = calls.get(message.toolCallId);
			if (!call) continue;
			const ok = message.isError !== true;
			if (call.name === TOOLS.historySearch.name) {
				const hits = isObject(message.details) ? strings(message.details.hits) : undefined;
				search(message.toolCallId, hits ?? [], false);
			} else if (call.name === TOOLS.historyRead.name) {
				const resolved = isObject(message.details) ? entryId(message.details.id) : undefined;
				read(message.toolCallId, resolved ?? entryId(call.args.id), false, ok);
			} else if (call.name === "read") file(message.toolCallId, call.args.path, false, ok);
		}
	}
	return events;
}

/** The events at one entry, and the entries after it on their branches. */
interface Step {
	readonly id: string | undefined;
	readonly events: RetrievalEvent[];
	readonly children: Step[];
}

/**
 * The events as a tree of steps, one per entry. A step whose parent is unknown or unnamed follows the step before, so
 * a session without parent ids is one line; a `session` event starts a new tree.
 */
function stepsOf(events: readonly RetrievalEvent[]): Step[] {
	const roots: Step[] = [];
	let byId = new Map<string, Step>();
	let last: Step | undefined;
	const add = (step: Step, parent: Step | undefined): Step => {
		(parent ? parent.children : roots).push(step);
		if (step.id !== undefined) byId.set(step.id, step);
		last = step;
		return step;
	};
	for (const event of events) {
		if (event.kind === "session") {
			byId = new Map();
			add({ id: undefined, events: [], children: [] }, undefined);
		} else if (event.kind === "at") {
			const parent = event.parent === null ? undefined : event.parent !== undefined && byId.has(event.parent) ? byId.get(event.parent) : last;
			add({ id: event.id, events: [], children: [] }, parent);
		} else {
			(last ?? add({ id: undefined, events: [], children: [] }, undefined)).events.push(event);
		}
	}
	return roots;
}

/**
 * Walks the events along every branch from the root, depth first and without recursion (a long session is a deep tree).
 * `enter` runs when the walk reaches an entry and `visit` for each event at it; whatever they push on `undo` is taken
 * back when the walk leaves that entry, so no branch sees the state of another. Linear in the events.
 */
export function walkBranches(
	events: readonly RetrievalEvent[],
	undo: (() => void)[],
	enter: (id: string | undefined) => void,
	visit: (event: RetrievalEvent) => void,
): void {
	const stack: { step: Step; next: number; mark: number }[] = [];
	const open = (step: Step): void => {
		const mark = undo.length;
		enter(step.id);
		for (const event of step.events) visit(event);
		stack.push({ step, next: 0, mark });
	};
	for (const root of stepsOf(events)) {
		open(root);
		while (stack.length > 0) {
			const top = stack[stack.length - 1] as { step: Step; next: number; mark: number };
			const child = top.step.children[top.next++];
			if (child) {
				open(child);
				continue;
			}
			while (undo.length > top.mark) (undo.pop() as () => void)();
			stack.pop();
		}
	}
}

interface OpenEpisode {
	searches: number;
	reads: number;
	relevantAt: number | undefined;
}

/**
 * Counts the events. `labels.needed` are the ids of the entries a fixture's agent needed; without them the report is a
 * proxy. Walks each branch from the root with its own state (turns, reads, open episode), undone when the walk leaves
 * a branch, so the work is linear in the events and no branch borrows another's search, read or cut.
 */
export function reduceRetrieval(events: readonly RetrievalEvent[], labels?: { readonly needed: ReadonlySet<string> }): RetrievalReport {
	let fileReads = 0;
	let rereads = 0;
	let rereadsNested = 0;
	let entryReads = 0;
	let entryReadsNested = 0;
	let failedReads = 0;
	const searches = { total: 0, withHits: 0, relevant: 0 };
	const episodes: OpenEpisode[] = [];

	// The branch's state; `undo` takes back each change when the walk leaves the step that made it.
	const undo: (() => void)[] = [];
	let turn = 0;
	let depth = 0;
	/** The depth of each entry on the branch, to find where a cut kept from. */
	const depthOf = new Map<string, number>();
	/** Successful file reads on the branch, in order; the first `archivedUpTo` were archived by a cut. */
	const files: { path: string; depth: number }[] = [];
	let archivedUpTo = 0;
	/** How many archived reads of each file the branch holds. */
	const archived = new Map<string, number>();
	/** The branch's open episode, and the fresh tokens it spent; `found` once its first relevant read came. */
	let open: { episode: OpenEpisode; fresh: number; found: boolean } | undefined;
	/** The branch's searches by the ids they hit, in turn order, for the proxy. */
	const hitsOf = new Map<string, { turn: number; search: { found: boolean } }[]>();

	const set = <T>(get: () => T, put: (value: T) => void, value: T): void => {
		const before = get();
		undo.push(() => put(before));
		put(value);
	};
	/** The searches on the branch that hit `id` within the proxy's turns. */
	const recentHits = (id: string): { found: boolean }[] => {
		const list = hitsOf.get(id);
		const found: { found: boolean }[] = [];
		for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
			const hit = list?.[i] as { turn: number; search: { found: boolean } };
			if (turn - hit.turn > PROXY_TURNS) break;
			found.push(hit.search);
		}
		return found;
	};

	const apply = (event: RetrievalEvent): void => {
		switch (event.kind) {
			case "session":
			case "at":
				return;
			case "cut": {
				const kept = event.keptFrom !== undefined ? depthOf.get(event.keptFrom) : undefined;
				// A cut that kept from an entry not on the branch is read as archiving everything before it.
				const limit = kept ?? Number.POSITIVE_INFINITY;
				const from = archivedUpTo;
				let to = from;
				while (to < files.length && (files[to] as { depth: number }).depth < limit) {
					const path = (files[to] as { path: string }).path;
					archived.set(path, (archived.get(path) ?? 0) + 1);
					to++;
				}
				archivedUpTo = to;
				undo.push(() => {
					for (let i = from; i < to; i++) {
						const path = (files[i] as { path: string }).path;
						const count = (archived.get(path) ?? 1) - 1;
						if (count === 0) archived.delete(path);
						else archived.set(path, count);
					}
					archivedUpTo = from;
				});
				const episode: OpenEpisode = { searches: 0, reads: 0, relevantAt: undefined };
				episodes.push(episode);
				set(() => open, (value) => (open = value), { episode, fresh: 0, found: false });
				return;
			}
			case "request":
				set(() => turn, (value) => (turn = value), turn + 1);
				if (open && !open.found) set(() => (open as { fresh: number }).fresh, (value) => ((open as { fresh: number }).fresh = value), open.fresh + event.freshTokens);
				return;
			case "file": {
				if (event.ok === false) {
					failedReads++;
					return;
				}
				fileReads++;
				if (archived.has(event.path)) {
					rereads++;
					if (event.nested) rereadsNested++;
				}
				files.push({ path: event.path, depth });
				undo.push(() => files.pop());
				return;
			}
			case "search": {
				searches.total++;
				if (event.hits.length > 0) searches.withHits++;
				if (labels) {
					if (event.hits.some((id) => labels.needed.has(id))) searches.relevant++;
				} else {
					// A search counts as relevant once, when a later read on its branch takes one of its hits.
					const search = { found: false };
					for (const id of new Set(event.hits)) {
						const list = hitsOf.get(id) ?? [];
						if (list.length === 0) hitsOf.set(id, list);
						list.push({ turn, search });
						undo.push(() => {
							list.pop();
							if (list.length === 0) hitsOf.delete(id);
						});
					}
				}
				if (open) open.episode.searches++;
				return;
			}
			case "read": {
				if (event.ok === false) {
					failedReads++;
					return;
				}
				entryReads++;
				if (event.nested) entryReadsNested++;
				let relevant: boolean;
				if (labels) relevant = labels.needed.has(event.entryId);
				else {
					const hits = recentHits(event.entryId);
					for (const search of hits) {
						if (search.found) continue;
						search.found = true;
						searches.relevant++;
					}
					relevant = hits.length > 0;
				}
				if (open) {
					open.episode.reads++;
					if (!open.found && relevant) {
						const at = open.fresh;
						const episode = open.episode;
						episode.relevantAt = episode.relevantAt === undefined ? at : Math.min(episode.relevantAt, at);
						set(() => (open as { found: boolean }).found, (value) => ((open as { found: boolean }).found = value), true);
					}
				}
				return;
			}
		}
	};

	walkBranches(
		events,
		undo,
		(id) => {
			set(() => depth, (value) => (depth = value), depth + 1);
			if (id !== undefined) {
				const before = depthOf.get(id);
				depthOf.set(id, depth);
				undo.push(() => (before === undefined ? depthOf.delete(id) : depthOf.set(id, before)));
			}
		},
		apply,
	);

	const done = episodes.map((episode) => ({
		searches: episode.searches,
		reads: episode.reads,
		relevantRead: episode.relevantAt !== undefined,
		tokensToFirstRelevantRead: episode.relevantAt,
	}));
	return {
		basis: labels ? "labelled" : "proxy",
		fileReads,
		rereads,
		rereadsNested,
		entryReads,
		entryReadsNested,
		failedReads,
		searches,
		episodes: done,
		recovered: done.filter((episode) => episode.relevantRead).length,
	};
}

/** The sum of reports of separate sessions on the same basis. */
export function combineRetrieval(reports: readonly RetrievalReport[]): RetrievalReport {
	const bases = new Set(reports.map((report) => report.basis));
	if (bases.size > 1) throw new Error("labelled and proxy retrieval reports do not add up");
	const sum = (pick: (report: RetrievalReport) => number) => reports.reduce((total, report) => total + pick(report), 0);
	return {
		basis: reports[0]?.basis ?? "proxy",
		fileReads: sum((r) => r.fileReads),
		rereads: sum((r) => r.rereads),
		rereadsNested: sum((r) => r.rereadsNested),
		entryReads: sum((r) => r.entryReads),
		entryReadsNested: sum((r) => r.entryReadsNested),
		failedReads: sum((r) => r.failedReads),
		searches: { total: sum((r) => r.searches.total), withHits: sum((r) => r.searches.withHits), relevant: sum((r) => r.searches.relevant) },
		episodes: reports.flatMap((r) => r.episodes),
		recovered: sum((r) => r.recovered),
	};
}

const share = (part: number, whole: number) => (whole === 0 ? "0" : `${part} of ${whole}`);

/** The report as lines for `/context` and `npm run measure`. */
export function formatRetrievalReport(report: RetrievalReport): string[] {
	const basis = report.basis === "labelled" ? "labelled: a fixture says which entries were needed" : "proxy: a hit counts when the same entry is read within " + PROXY_TURNS + " turns";
	const tokens = report.episodes.flatMap((episode) => (episode.tokensToFirstRelevantRead === undefined ? [] : [episode.tokensToFirstRelevantRead]));
	const median = tokens.length === 0 ? "none" : `median ${[...tokens].sort((a, b) => a - b)[Math.floor(tokens.length / 2)]?.toLocaleString("en-US")} fresh tokens`;
	return [
		`Re-reads after a cut (compat series): ${share(report.rereads, report.fileReads)} file reads (${report.rereadsNested} inside other tools)`,
		`Archive searches (${basis}): ${report.searches.total} searches, ${report.searches.withHits} found something, ${report.searches.relevant} found the entry that mattered; ${report.entryReads} entry reads (${report.entryReadsNested} inside other tools)${report.failedReads > 0 ? `; ${report.failedReads} failed reads not counted` : ""}`,
		`Recovery after a cut: ${share(report.recovered, report.episodes.length)} cuts ended in a relevant read; tokens until the first one: ${median}`,
	];
}
