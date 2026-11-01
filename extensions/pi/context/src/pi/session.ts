import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { openArchive } from "../core/archive.ts";
import { logEntry, pathOf, textOf, thinkingOf, toolCallsOf } from "../core/messages.ts";
import { AttemptFold, type AttemptsState } from "../core/attempts.ts";
import {
	canonicalCall,
	type DuplicateRecord,
	liveAliases,
	type ReadObservation,
	textDigest,
} from "../core/duplicates.ts";
import { decodeContextRecord } from "../core/records.ts";
import { entryDigest, digestOf } from "../core/serialize.ts";
import { archivedReads } from "../core/signals.ts";
import {
	idsBetween,
	offBranchAnchor,
	type SourceStretch,
	type SummaryState,
	summaryTokens,
	type UnsummarizedStretch,
	withoutCiting,
} from "../core/summary.ts";
import type { ContextConfig } from "../core/config.ts";
import { estimateBudget, estimateTokens } from "../core/tokens.ts";
import { checkNotebook } from "../core/tools.ts";
import { withoutPings } from "./keep-warm.ts";
import type {
	ArchivedCompaction,
	ArchivedEntry,
	ArchiveItem,
	ArchiveReader,
	ArchiveStatus,
	Checkpoint,
	EffectiveHistory,
	ForeignCheckpoint,
	LogEntry,
	ModelView,
	SummaryEligibility,
	ToolCallRef,
} from "../core/types.ts";

/** Pi's projector, \`buildSessionProjection\`: the one place that applies context_edit and compaction. */
export type SessionProjector = (entries: SessionEntry[], leafId?: string | null) => SessionProjection;

export type ProjectedMessage = SessionProjection["messages"][number];

/** What the extension reads from the branch besides the three views. */
export interface TapeState {
	readonly notebook: string | undefined;
	/** The notebook was written after the latest compaction, or at all when there was none. */
	readonly notebookCurrent: boolean;
	/** A notebook reminder was appended after the latest compaction. */
	readonly reminded: boolean;
	/** \`provider/model\` of the last response, the model whose cache holds the prefix. */
	readonly lastModelKey: string | undefined;
	/** Last time the provider cache was used: a response or a cache refresh. */
	readonly lastCacheTouch: number | undefined;
	readonly endsWithCompaction: boolean;
	/** Compactions on this branch that came from this extension. */
	readonly cuts: number;
	/** A finished task was reported and neither a prompt nor a cut followed: the next cut chance is still its. */
	readonly taskCutPending: boolean;
	/** The historian's unfinished work by work key: the attempts recorded on this branch. */
	readonly attempts: AttemptsState;
	/** The branch's last entry: a summary of the history read now records it as `projectedThroughId`. */
	readonly leafId: string | undefined;
}

type LooseMessage = Record<string, unknown> & { readonly role?: unknown };
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type ContextEditEntry = Extract<SessionEntry, { type: "context_edit" }>;

/**
 * One context entry as the engine reads it. \`message\` is the projected message when pi projected the entry, so an
 * edit's replacement is what the engine reads; without it the entry is read as it was written.
 */
function readEntry(
	entry: SessionEntry,
	calls: Map<string, ToolCallRef>,
	message: LooseMessage | undefined,
): LogEntry | undefined {
	switch (entry.type) {
		case "message": {
			const written = entry.message as unknown as LooseMessage;
			const content = (message ?? written).content;
			const time = typeof written.timestamp === "number" ? written.timestamp : Date.parse(entry.timestamp);
			switch (written.role) {
				case "user":
					return logEntry(entry.id, "user", time, textOf(content));
				case "assistant": {
					const toolCalls = toolCallsOf(content);
					for (const call of toolCalls) if (call.id !== "") calls.set(call.id, call);
					return logEntry(entry.id, "assistant", time, textOf(content), { toolCalls, thinking: thinkingOf(content) });
				}
				case "toolResult": {
					const call = typeof written.toolCallId === "string" ? calls.get(written.toolCallId) : undefined;
					return logEntry(entry.id, "tool", time, textOf(content), {
						toolName: typeof written.toolName === "string" ? written.toolName : "tool",
						isError: written.isError === true,
						...(call ? { call } : {}),
					});
				}
				case "bashExecution": {
					if (written.excludeFromContext === true) return undefined;
					const command = typeof written.command === "string" ? written.command : "";
					const output = typeof written.output === "string" ? written.output : "";
					return logEntry(entry.id, "custom", time, "$ " + command + "\n" + output);
				}
				case "custom":
					return logEntry(entry.id, "custom", time, textOf(content));
				default:
					return undefined;
			}
		}
		case "custom_message":
			return logEntry(entry.id, "custom", Date.parse(entry.timestamp), textOf((message ?? entry).content));
		case "branch_summary":
			return logEntry(entry.id, "custom", Date.parse(entry.timestamp), entry.summary);
		default:
			return undefined;
	}
}

/**
 * The projected entries, read in order: what an edit replaced reads as replaced, what it omitted is absent. The
 * extension's context hook takes answered keep-warm pings out of every request, so they leave the messages and count
 * as omitted too.
 */
function readProjection(projection: SessionProjection): {
	messages: ProjectedMessage[];
	entries: LogEntry[];
	edited: Map<string, ArchiveStatus>;
} {
	// The context hook sees the messages without pi's system messages; strip pings from the same list.
	const sent = projection.entries.flatMap(({ sourceEntry, messages }) =>
		messages.filter((message) => message.role !== "system").map((message) => ({ sourceEntry, message })),
	);
	const kept = new Set(withoutPings(sent, (one) => one.message as LooseMessage as { role: string; customType?: string }));
	const pings = sent.filter((one) => !kept.has(one));
	const pingMessages = new Set<unknown>(pings.map((one) => one.message));
	const pingEntries = new Set(pings.map((one) => one.sourceEntry.id));
	const calls = new Map<string, ToolCallRef>();
	const entries: LogEntry[] = [];
	const edited = new Map<string, ArchiveStatus>();
	for (const { sourceEntry, messages } of projection.entries) {
		if (sourceEntry.type === "compaction") continue;
		if (pingEntries.has(sourceEntry.id)) {
			edited.set(sourceEntry.id, "omitted");
			continue;
		}
		const written = readEntry(sourceEntry, new Map(calls), undefined);
		if (!written) continue;
		const projected = messages.find((message) => {
			const role = (message as LooseMessage).role;
			return role !== "compactionSummary" && role !== "system";
		}) as LooseMessage | undefined;
		if (!projected) {
			edited.set(sourceEntry.id, "omitted");
			continue;
		}
		const entry = readEntry(sourceEntry, calls, projected);
		if (!entry) continue;
		// Text and tokens are lossy (a tool call's arguments, thinking of the same size): compare the whole content.
		const writtenContent = ((sourceEntry.type === "message" ? sourceEntry.message : sourceEntry) as LooseMessage).content;
		if (JSON.stringify(projected.content) !== JSON.stringify(writtenContent) || entry.text !== written.text) {
			edited.set(sourceEntry.id, "replaced");
		}
		entries.push(entry);
	}
	return { messages: projection.messages.filter((message) => !pingMessages.has(message)), entries, edited };
}

function isOwnCut(entry: SessionEntry): boolean {
	return entry.type === "compaction" && decodeContextRecord(entry).kind === "cut";
}

/** Where a tape reads the session from; pi's SessionManager answers all three. */
export interface BranchSource {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	/** The branch ending at `fromId` (the leaf without it), root first. */
	getBranch(fromId?: string): SessionEntry[];
}

/** What reading the tape has cost so far, for tests and diagnosis. */
export interface TapeStats {
	/** The branch was read whole: the first read, an edit, a cut or a change of branch. */
	readonly rebuilds: number;
	/** Entries taken in from the tail of the branch without reading the rest. */
	readonly appended: number;
	/** Times the history and the archive were built from the branch (the model view with them, unless it was already). */
	readonly viewBuilds: number;
	/** Times the model view was projected from the branch: once per revision at most. */
	readonly modelBuilds: number;
}

/** Entry types that only add to the branch: appending one leaves everything before it as it was. */
const APPENDABLE_TYPES = new Set<SessionEntry["type"]>([
	"message",
	"custom_message",
	"custom",
	"branch_summary",
	"usage",
	"label",
	"model_change",
	"thinking_level_change",
	"session_info",
]);

/**
 * Whether a keep-warm ping still waits after `entry`. Pi's projection drops a ping and its answers once the next
 * entry that is not an answer reaches the model, so such an entry changes what stands before it. An entry that never
 * reaches the model (an omitted one, a system message) leaves the wait as it was. A compaction does not end the wait
 * here: reading it as pending only costs a rebuild, never a wrong view.
 */
function pingPendingAfter(pending: boolean, entry: SessionEntry, omitted: ReadonlySet<string>): boolean {
	if (omitted.has(entry.id)) return pending;
	switch (entry.type) {
		case "custom_message":
			return decodeContextRecord(entry).kind === "keep-warm";
		case "message": {
			const role = (entry.message as unknown as LooseMessage).role;
			if (role === "system") return pending;
			return pending && (role === "assistant" || role === "toolResult");
		}
		case "branch_summary":
			return false;
		default:
			return pending;
	}
}

/** The ids of the entries on `path` that their latest edit omits. */
function omittedIds(path: readonly SessionEntry[]): ReadonlySet<string> {
	const latest = new Map<string, boolean>();
	for (const entry of path) {
		if (entry.type === "context_edit") latest.set(entry.targetId, entry.replacement === null);
	}
	return new Set([...latest].filter(([, omitted]) => omitted).map(([id]) => id));
}

/**
 * The limits a stored notebook and summary must keep to be read: the active config's, not the ones they were written
 * under, so a record over a lowered limit is skipped and the earlier one stays, for cuts and the historian alike.
 */
export type StoredLimits = Pick<ContextConfig, "notebookMaxBytes" | "summaryTokens">;

/** What the extension keeps outside the views, folded over the branch's entries as they were written, root first. */
class StateFold {
	summary: SummaryState | undefined;
	summaryProjectedThrough: string | undefined;
	notebook: string | undefined;
	notebookCurrent = false;
	reminded = false;
	lastModelKey: string | undefined;
	lastCacheTouch: number | undefined;
	cuts = 0;
	taskCutPending = false;
	readonly attempts = new AttemptFold();
	/** A keep-warm ping stands at the end of the branch with nothing but answers after it. */
	pingPending = false;
	/** The place of every entry folded so far: what a record may name stands before it. */
	readonly #placed = new Map<string, number>();

	/** The entries of the branch an edit omits, known when the branch is read whole; appended entries have none. */
	readonly omitted: ReadonlySet<string>;

	readonly #limits: StoredLimits;

	constructor(limits: StoredLimits, omitted: ReadonlySet<string> = new Set()) {
		this.#limits = limits;
		this.omitted = omitted;
	}

	private touch(time: number): void {
		if (Number.isFinite(time)) this.lastCacheTouch = Math.max(this.lastCacheTouch ?? time, time);
	}

	add(entry: SessionEntry): void {
		const record = decodeContextRecord(entry);
		this.pingPending = pingPendingAfter(this.pingPending, entry, this.omitted);
		if (record.kind === "notebook" && checkNotebook(record.text, this.#limits.notebookMaxBytes).ok) {
			this.notebook = record.text;
			this.notebookCurrent = true;
		}
		switch (entry.type) {
			case "message": {
				const message = entry.message as unknown as LooseMessage;
				if (message.role === "user") this.taskCutPending = false;
				if (message.role === "assistant") {
					if (typeof message.provider === "string" && typeof message.model === "string") {
						this.lastModelKey = message.provider + "/" + message.model;
					}
					// The entry is written when the response ends, so this overestimates how warm the cache
					// is. That can only skip a free cut; it never adds a cache break.
					this.touch(Date.parse(entry.timestamp));
				}
				break;
			}
			case "custom_message":
				if (record.kind === "reminder") this.reminded = true;
				break;
			case "compaction":
				this.taskCutPending = false;
				this.notebookCurrent = false;
				this.reminded = false;
				if (record.kind === "cut") this.cuts++;
				break;
			case "custom":
				// A summary over the budget or naming an entry off this branch is skipped; the one before it stays.
				if (
					record.kind === "summary" &&
					summaryTokens(record.state) <= estimateBudget(this.#limits.summaryTokens) &&
					offBranchAnchor(record.state, record.projectedThroughId, (id) => this.#placed.get(id)) === undefined
				) {
					this.summary = record.state;
					this.summaryProjectedThrough = record.projectedThroughId;
				}
				if (record.kind === "task-done") this.taskCutPending = true;
				if (record.kind === "attempt") this.attempts.add(record.entry);
				// A side request that read the cache renewed it from its start, as an answer would.
				if (record.kind === "warm-request" && record.warm.type === "end" && record.warm.outcome === "warmed") this.touch(record.warm.at);
				break;
			case "usage":
				if (entry.kind === "cache_warm") this.touch(Date.parse(entry.timestamp));
				break;
			default:
				break;
		}
		this.#placed.set(entry.id, this.#placed.size);
	}
}

/** What the repeated-read rules read from the branch: the top-level reads the model holds, and the notes that are ours. */
export interface DuplicateIndex {
	readonly reads: readonly ReadObservation[];
	readonly aliases: ReadonlyMap<string, DuplicateRecord>;
}

/**
 * The top-level read results of the model view, oldest first, with where each stands: as written, our note, or edited by
 * someone else. A read inside another tool (codemode) is no entry of its own and does not appear. The content is compared
 * whole, as the projector applied the edits to it; the entry's text and tokens are lossy. A result is a read when the
 * call the model sees names it; a note of ours stays one even when another extension edited that call away, so a cut
 * can still give it its text back, and its call is then taken as written.
 */
function readObservations(projection: SessionProjection, aliases: ReadonlyMap<string, DuplicateRecord>): ReadObservation[] {
	type Call = { name: string; args: unknown };
	const calls = new Map<string, Call>();
	const writtenCalls = new Map<string, Call>();
	const reads: ReadObservation[] = [];
	for (const { sourceEntry, messages } of projection.entries) {
		if (sourceEntry.type !== "message") continue;
		const written = sourceEntry.message as unknown as LooseMessage;
		const shown = messages.find((message) => (message as LooseMessage).role === written.role) as LooseMessage | undefined;
		if (written.role === "assistant") {
			for (const call of toolCallsOf(written.content)) if (call.id !== "") writtenCalls.set(call.id, { name: call.name, args: call.args });
			for (const call of toolCallsOf(shown?.content)) if (call.id !== "") calls.set(call.id, { name: call.name, args: call.args });
			continue;
		}
		if (!shown || written.role !== "toolResult" || written.toolName !== "read" || written.isError === true) continue;
		const toolCallId = typeof written.toolCallId === "string" ? written.toolCallId : "";
		const edited = JSON.stringify(shown.content) !== JSON.stringify(written.content);
		const owned = edited && aliases.has(sourceEntry.id);
		const call = calls.get(toolCallId) ?? (owned ? writtenCalls.get(toolCallId) : undefined);
		const key = call?.name === "read" ? canonicalCall(call.args) : undefined;
		const path = call ? pathOf(call.args) : undefined;
		if (!owned && (key === undefined || path === undefined)) continue;
		reads.push({
			id: sourceEntry.id,
			toolCallId,
			// A note whose call cannot be read at all compares equal to no other read.
			call: key ?? "#" + sourceEntry.id,
			content: edited && !owned ? undefined : textDigest(written.content),
			tokens: estimateTokens(textOf(shown.content)),
			path: path ?? "",
			state: !edited ? "full" : owned ? "alias" : "foreign",
			original: written.content,
		});
	}
	return reads;
}

/** The model view and what is read from the same projection; a turn without a cut needs nothing else. */
interface ModelPart {
	readonly modelView: ModelView<ProjectedMessage>;
	readonly duplicates: DuplicateIndex;
	readonly view: ReturnType<typeof readProjection>;
}

interface Views {
	readonly modelView: ModelView<ProjectedMessage>;
	readonly duplicates: DuplicateIndex;
	readonly history: EffectiveHistory;
	readonly archive: ArchiveReader;
}

/** Places on the branch, and the checkpoint a compaction makes with whether a later edit made it stale. */
function branchPlaces(path: readonly SessionEntry[], position: ReadonlyMap<string, number>) {
	const at = (id: string | null | undefined) => (id == null ? undefined : position.get(id));
	const edits = path.filter((entry): entry is ContextEditEntry => entry.type === "context_edit");
	/** An edit appended after \`after\` touches an entry at or before \`through\`. */
	const editedAfter = (after: number, through: number) =>
		edits.some((edit) => (at(edit.id) ?? -1) > after && (at(edit.targetId) ?? Infinity) <= through);
	const checkpointOf = (compaction: CompactionEntry | undefined): Checkpoint | undefined => {
		if (!compaction) return undefined;
		const own = at(compaction.id) ?? 0;
		const kept = at(compaction.firstKeptEntryId) ?? own;
		return {
			id: compaction.id,
			owner: isOwnCut(compaction) ? "own" : "foreign",
			text: compaction.summary,
			status: editedAfter(own, kept - 1) ? "stale" : "current",
		};
	};
	return { at, editedAfter, checkpointOf };
}

/**
 * The session as the extension reads it, built from the active branch and pi's projector. It hands out three views and
 * nothing else reads session entries:
 * - {@link modelView}: exactly what the provider gets, every edit applied;
 * - {@link history}: the same edits, with our own cuts see-through so the work behind them stays reachable;
 * - {@link archive}: every entry as it was written, with where it stands with the model.
 *
 * A tape that follows a session ({@link follow}) takes new entries in from the tail on {@link refresh} and builds the
 * views only when asked. Only a pure append is taken in that way: an edit, a compaction, a change of branch or an
 * entry that changes what stands before it reads the branch again through the projector, so what pi applies is never
 * reimplemented here.
 */
export class SessionTape {
	readonly #source: BranchSource;
	readonly #project: SessionProjector;
	#path: SessionEntry[] = [];
	#position = new Map<string, number>();
	readonly #limits: StoredLimits;
	#fold: StateFold;
	#revision = 0;
	#model: ModelPart | undefined;
	#views: Views | undefined;
	#archivedReads: ReadonlySet<string> | undefined;
	/** What the stale foreign checkpoint summarized; a pure append changes neither the checkpoint nor that. */
	#staleSources: { readonly id: string; readonly entries: readonly LogEntry[] } | undefined;
	/** The latest summary as judged against its sources; only an edit, which reads the branch again, changes the verdict. */
	#judged: { readonly summary: SummaryState; readonly eligibility: SummaryEligibility } | undefined;
	#stats = { rebuilds: 0, appended: 0, viewBuilds: 0, modelBuilds: 0 };

	private constructor(source: BranchSource, project: SessionProjector, limits: StoredLimits) {
		this.#source = source;
		this.#project = project;
		this.#limits = limits;
		this.#fold = new StateFold(limits);
	}

	/** Read the active branch, root first, as `SessionManager.getBranch()` returns it. */
	static read(branch: readonly SessionEntry[], project: SessionProjector, limits: StoredLimits): SessionTape {
		const path = [...branch];
		const byId = new Map(path.map((entry) => [entry.id, entry]));
		return SessionTape.follow(
			{ getLeafId: () => path.at(-1)?.id ?? null, getEntry: (id) => byId.get(id), getBranch: () => path },
			project,
			limits,
		);
	}

	/** A tape on a session that keeps growing; {@link refresh} brings it up to the source's leaf. */
	static follow(source: BranchSource, project: SessionProjector, limits: StoredLimits): SessionTape {
		const tape = new SessionTape(source, project, limits);
		tape.refresh();
		return tape;
	}

	/**
	 * Bring the tape to `leaf` (the source's leaf by default) and return its revision, which grows with every change.
	 * Entries added behind the leaf the tape knows are read from that tail alone.
	 */
	refresh(leaf: string | null = this.#source.getLeafId()): number {
		const current = this.#path.at(-1)?.id ?? null;
		if (leaf === current) return this.#revision;
		const tail = current === null || leaf === null ? undefined : this.#tailTo(leaf, current);
		if (tail && this.#appendable(tail)) this.#append(tail);
		else this.#rebuild(leaf);
		return ++this.#revision;
	}

	/** What reading has cost so far. */
	get stats(): TapeStats {
		return { ...this.#stats };
	}

	/** The entries from `leaf` back to the branch's current end, root first; undefined when `leaf` is not behind it. */
	#tailTo(leaf: string, current: string): SessionEntry[] | undefined {
		const tail: SessionEntry[] = [];
		const seen = new Set<string>();
		let id: string | null = leaf;
		while (id !== current) {
			if (id === null || seen.has(id) || this.#position.has(id)) return undefined;
			seen.add(id);
			const entry = this.#source.getEntry(id);
			if (!entry) return undefined;
			tail.push(entry);
			id = entry.parentId;
		}
		return tail.reverse();
	}

	/** Whether appending `tail` leaves everything before it as the projector read it. */
	#appendable(tail: readonly SessionEntry[]): boolean {
		let pending = this.#fold.pingPending;
		for (const entry of tail) {
			if (!APPENDABLE_TYPES.has(entry.type)) return false;
			const after = pingPendingAfter(pending, entry, this.#fold.omitted);
			if (pending && !after) return false;
			pending = after;
		}
		return true;
	}

	#append(tail: readonly SessionEntry[]): void {
		for (const entry of tail) {
			this.#position.set(entry.id, this.#path.length);
			this.#path.push(entry);
			this.#fold.add(entry);
		}
		this.#stats.appended += tail.length;
		this.#model = undefined;
		this.#views = undefined;
	}

	#rebuild(leaf: string | null): void {
		this.#path = leaf === null ? [] : [...this.#source.getBranch(leaf)];
		this.#position = new Map(this.#path.map((entry, index) => [entry.id, index]));
		this.#fold = new StateFold(this.#limits, omittedIds(this.#path));
		for (const entry of this.#path) this.#fold.add(entry);
		this.#stats.rebuilds++;
		this.#model = undefined;
		this.#views = undefined;
		this.#archivedReads = undefined;
		this.#staleSources = undefined;
		this.#judged = undefined;
	}

	#checkpointSources(seeThrough: readonly SessionEntry[], foreign: ForeignCheckpoint | undefined, shown: readonly LogEntry[]): readonly LogEntry[] {
		if (foreign?.status !== "stale") return [];
		if (this.#staleSources?.id !== foreign.id) {
			this.#staleSources = { id: foreign.id, entries: staleCheckpointSources(seeThrough, foreign, shown, this.#project) };
		}
		return this.#staleSources.entries;
	}

	/** The extension's state at the branch's last entry. */
	get state(): TapeState {
		const fold = this.#fold;
		const last = this.#path.at(-1);
		return {
			notebook: fold.notebook,
			notebookCurrent: fold.notebookCurrent,
			reminded: fold.reminded,
			lastModelKey: fold.lastModelKey,
			lastCacheTouch: fold.lastCacheTouch,
			endsWithCompaction: last?.type === "compaction",
			cuts: fold.cuts,
			taskCutPending: fold.taskCutPending,
			attempts: fold.attempts.snapshot(),
			leafId: last?.id,
		};
	}

	/**
	 * The files read in the archived part of the history. A pure append never changes it, so it is computed from the
	 * history once per rebuild.
	 */
	archivedReads(): ReadonlySet<string> {
		if (!this.#archivedReads) {
			const history = this.history();
			this.#archivedReads = archivedReads(history.entries, history.visibleFromIndex);
		}
		return this.#archivedReads;
	}

	/** Exactly what the provider gets: the latest checkpoint and the entries after it, every edit applied. */
	modelView(): ModelView<ProjectedMessage> {
		return this.#modelNow().modelView;
	}

	/** The top-level reads the model holds now and our notes among them, for the repeated-read rules. */
	duplicates(): DuplicateIndex {
		return this.#modelNow().duplicates;
	}

	/** The history cuts and the historian plan from: every edit applied, our own cuts see-through. */
	history(): EffectiveHistory {
		return this.#viewsNow().history;
	}

	/** Every context entry of the branch as it was written, for search and read. */
	archive(): ArchiveReader {
		return this.#viewsNow().archive;
	}

	#modelNow(): ModelPart {
		if (!this.#model) {
			this.#model = this.#buildModel();
			this.#stats.modelBuilds++;
		}
		return this.#model;
	}

	#viewsNow(): Views {
		if (!this.#views) {
			this.#views = this.#build();
			this.#stats.viewBuilds++;
		}
		return this.#views;
	}

	/** The model view: pi's projection of the branch as it is. */
	#buildModel(): ModelPart {
		const path = this.#path;
		const { checkpointOf } = branchPlaces(path, this.#position);
		const projection = this.#project(path, path.at(-1)?.id ?? null);
		const head = projection.entries[0]?.sourceEntry;
		const viewCheckpoint = checkpointOf(head?.type === "compaction" ? head : undefined);
		const view = readProjection(projection);
		const aliases = liveAliases(path);
		const duplicates = { reads: readObservations(projection, aliases), aliases };
		const modelView = {
			messages: view.messages,
			checkpoint: viewCheckpoint,
			entries: view.entries,
			tokens: view.entries.reduce((sum, entry) => sum + entry.tokens, viewCheckpoint ? estimateTokens(viewCheckpoint.text) : 0),
		} as unknown as ModelView<ProjectedMessage>;
		return { modelView, duplicates, view };
	}

	#build(): Views {
		const path = this.#path;
		const project = this.#project;
		const { at, editedAfter, checkpointOf } = branchPlaces(path, this.#position);
		const { modelView, duplicates, view } = this.#modelNow();

		// The history: the same projection with our own cuts taken out of the path, so pi applies every edit behind them.
		const seeThrough: SessionEntry[] = [];
		for (const entry of path) {
			if (isOwnCut(entry)) continue;
			seeThrough.push({ ...entry, parentId: seeThrough.at(-1)?.id ?? null } as SessionEntry);
		}
		const historyProjection = project(seeThrough, seeThrough.at(-1)?.id ?? null);
		const historyHead = historyProjection.entries[0]?.sourceEntry;
		const foreign = checkpointOf(historyHead?.type === "compaction" ? historyHead : undefined) as ForeignCheckpoint | undefined;
		const history = readProjection(historyProjection);

		// Positions on the branch decide what the next cut may archive and what the model sees verbatim now.
		const latest = path.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
		const latestAt = at(latest?.id) ?? -1;
		const firstAfter = (from: number) => {
			const index = history.entries.findIndex((entry) => (at(entry.id) ?? -1) >= from);
			return index < 0 ? history.entries.length : index;
		};
		const minKeptIndex = latest ? firstAfter(latestAt + 1) : 0;
		const keptAt = at(latest?.firstKeptEntryId);
		const visibleFromIndex = !latest ? 0 : keptAt === undefined ? minKeptIndex : firstAfter(keptAt);

		const { summary, summaryProjectedThrough, notebook, omitted } = this.#fold;

		// The archive: every entry as written; an edit's status comes from the projection that applied it. An entry a
		// foreign checkpoint hides is in neither projection: its status comes from its latest edit, and the text after a
		// replacing edit from a projection of the entries behind the checkpoint, made only when that entry is rendered.
		const visible = new Set(view.entries.map((entry) => entry.id));
		const projected = new Set([...visible, ...history.entries.map((entry) => entry.id), ...history.edited.keys()]);
		const latestEdit = new Map<string, ArchiveStatus>();
		for (const entry of path) if (entry.type === "context_edit") latestEdit.set(entry.targetId, entry.replacement === null ? "omitted" : "replaced");
		let behindById: Map<string, LogEntry> | undefined;
		const behind = (id: string): string | undefined => {
			behindById ??= new Map(
				(foreign?.status === "stale" ? checkpointSources() : entriesBehind(seeThrough, history.entries, project)).map((one) => [one.id, one]),
			);
			return behindById.get(id)?.text;
		};
		const calls = new Map<string, ToolCallRef>();
		const placed: { item: ArchiveItem; at: number }[] = [];
		let projectedById: Map<string, LogEntry> | undefined;
		for (const entry of path) {
			if (entry.type === "compaction") continue;
			const written = readEntry(entry, calls, undefined);
			if (!written) continue;
			const hidden = !projected.has(entry.id);
			const status: ArchiveStatus =
				view.edited.get(entry.id) ??
				history.edited.get(entry.id) ??
				(hidden ? latestEdit.get(entry.id) : undefined) ??
				(visible.has(entry.id) ? "visible" : "archived");
			let kept: ArchivedEntry = { ...written, status };
			if (status === "replaced" && hidden) {
				const { id } = entry;
				kept = { ...kept, get replacement() { return behind(id); } };
			} else if (status === "replaced") {
				projectedById ??= new Map([...view.entries, ...history.entries].map((one) => [one.id, one]));
				const replacement = projectedById.get(entry.id)?.text;
				if (replacement !== undefined) kept = { ...kept, replacement };
			}
			placed.push({ item: { kind: "entry", entry: kept }, at: at(entry.id) ?? 0 });
		}
		// Every context entry's place on the branch, omitted and hidden ones included: the order a range is read in.
		const order = new Map(placed.map((one) => [(one.item as { entry: ArchivedEntry }).entry.id, one.at]));

		// What a stale foreign checkpoint summarized is read only when asked for, once per reading of the branch.
		const checkpointSources = () => this.#checkpointSources(seeThrough, foreign, history.entries);

		// A summary records no digests of its sources. One marked with `projectedThroughId` was made from the history with
		// every edit up to that entry applied, so only a later edit to what it covers can sit wrongly in its text. One
		// without the marker may have been made from the entries as written: any edit to an entry it covers, older or
		// newer than the summary, may sit in its text. Every entry a summary names is on this branch: the fold skipped
		// any other.
		let summaryEligibility: SummaryEligibility | undefined;
		if (summary) {
			const judged = this.#judged;
			if (judged?.summary === summary) summaryEligibility = judged.eligibility;
			else {
				const covered = at(summary.coveredThroughId);
				const projectedAt = at(summaryProjectedThrough) ?? -1;
				summaryEligibility =
					covered !== undefined && editedAfter(projectedAt, covered)
						? { eligible: false, state: summary, reason: "source-edited" }
						: { eligible: true, state: summary };
				// A summary with digests of its sources is judged by them: the items that depend on an edited or omitted
				// entry go, and their stretch is summarized again.
				if (summary.sources) {
					summaryEligibility = judgeBySources(summary, {
						entries: history.entries,
						hidden: checkpointSources,
						order,
						omitted,
						skipped: (id) => history.edited.get(id) === "omitted",
						editedSince: (through) => {
							const place = at(through);
							return place !== undefined && editedAfter(projectedAt, place);
						},
					});
				}
				this.#judged = { summary, eligibility: summaryEligibility };
			}
		}
		const trusted = summaryEligibility?.eligible ? summaryEligibility.state : undefined;

		let superseded: boolean | undefined;
		const effective = {
			entries: history.entries,
			checkpoint: foreign,
			get checkpointSources() {
				return checkpointSources();
			},
			get checkpointSuperseded() {
				// Only a trusted summary that names this stale checkpoint can replace it: the sources are read for that one.
				const named = trusted?.supersedes !== undefined && trusted.supersedes === foreign?.id && foreign.status === "stale";
				superseded ??= named && supersedesCheckpoint(trusted, foreign, checkpointSources(), order);
				return superseded;
			},
			order,
			minKeptIndex,
			visibleFromIndex,
			summary: trusted,
			summaryEligibility,
			notebook,
		} as unknown as EffectiveHistory;

		// A compaction covers the entries newly summarized: those from the previous compaction's kept range up to its own.
		let previous: CompactionEntry | undefined;
		for (const entry of path) {
			if (entry.type !== "compaction") continue;
			const from = previous ? (at(previous.firstKeptEntryId) ?? at(previous.id) ?? 0) : 0;
			const through = at(entry.firstKeptEntryId) ?? at(entry.id) ?? 0;
			const covered = placed.filter((one) => one.item.kind === "entry" && one.at >= from && one.at < through);
			const first = covered[0]?.item;
			const last = covered.at(-1)?.item;
			const compaction: ArchivedCompaction = {
				id: entry.id,
				owner: isOwnCut(entry) ? "own" : "foreign",
				timestamp: Date.parse(entry.timestamp),
				summary: entry.summary,
				covers:
					first?.kind === "entry" && last?.kind === "entry"
						? { from: first.entry.id, through: last.entry.id, count: covered.length }
						: undefined,
				buildsOn: previous?.id,
			};
			placed.push({ item: { kind: "compaction", compaction }, at: at(entry.id) ?? 0 });
			previous = entry;
		}
		const items = placed.sort((a, b) => a.at - b.at).map((one) => one.item);

		return { modelView, duplicates, history: effective, archive: openArchive(items) };
	}

	/**
	 * Read the active branch as pi will commit it at a boundary: the persisted entries, then the context edits and our
	 * ownership records that boundary handlers drafted before us, in draft order. They get ids of their own that no pi
	 * entry has; nothing the engine plans names one. Other drafts are not read: pi gives them ids only when it commits
	 * them, after every persisted entry.
	 */
	static readAtBoundary(
		branch: readonly SessionEntry[],
		drafts: readonly BoundaryDraft[],
		project: SessionProjector,
		limits: StoredLimits,
	): SessionTape {
		const path = [...branch];
		const timestamp = path.at(-1)?.timestamp ?? new Date(0).toISOString();
		for (const [index, draft] of drafts.entries()) {
			const base = { id: `boundary-draft-${index}`, parentId: path.at(-1)?.id ?? null, timestamp };
			path.push(
				draft.type === "context_edit"
					? { ...base, type: "context_edit", targetId: draft.targetId, replacement: draft.replacement }
					: { ...base, type: "custom", customType: draft.customType, data: draft.data },
			);
		}
		return SessionTape.read(path, project, limits);
	}
}

/** A draft the tape reads at a boundary: a context edit or a custom record. */
export type BoundaryDraft =
	| ({ readonly type: "context_edit" } & Pick<ContextEditEntry, "targetId" | "replacement">)
	| { readonly type: "custom"; readonly customType: string; readonly data?: unknown };

/**
 * The entries a stale foreign checkpoint summarized, edits applied: the path without any foreign compaction shows
 * them again, those an earlier foreign compaction had summarized for it included. Empty when the checkpoint is current
 * or there is none.
 */
function staleCheckpointSources(
	seeThrough: readonly SessionEntry[],
	foreign: ForeignCheckpoint | undefined,
	shown: readonly LogEntry[],
	project: SessionProjector,
): LogEntry[] {
	return foreign?.status === "stale" ? entriesBehind(seeThrough, shown, project) : [];
}

/** The entries the history's checkpoint hides, every edit applied: the branch projected without its compactions. */
function entriesBehind(seeThrough: readonly SessionEntry[], shown: readonly LogEntry[], project: SessionProjector): LogEntry[] {
	const open: SessionEntry[] = [];
	for (const entry of seeThrough) {
		if (entry.type === "compaction") continue;
		open.push({ ...entry, parentId: open.at(-1)?.id ?? null } as SessionEntry);
	}
	const visible = new Set(shown.map((entry) => entry.id));
	return readProjection(project(open, open.at(-1)?.id ?? null)).entries.filter((entry) => !visible.has(entry.id));
}

interface SourceReading {
	/** The history's entries, every edit applied. */
	readonly entries: readonly LogEntry[];
	/** The entries a stale foreign checkpoint hides; read only when a stretch reaches behind it. */
	readonly hidden: () => readonly LogEntry[];
	/** Every context entry's place on the branch. */
	readonly order: ReadonlyMap<string, number>;
	/** The entries an edit omits. */
	readonly omitted: ReadonlySet<string>;
	/** Entries the history leaves out that no summary was made from, like keep-warm pings. */
	readonly skipped: (id: string) => boolean;
	/** The edit rule of a summary without digests, for a stretch whose entries cannot be read. */
	readonly editedSince: (throughId: string) => boolean;
}

/**
 * Judge a summary that carries digests of its sources against the entries as they read now. A stretch is every
 * context entry between its ends on the branch, and its digest covers the ones no edit omits. When the digest changed,
 * because an edit replaced or omitted one of them after the summary, the items depending on any of its entries leave the summary, and so does the stretch: it becomes unsummarized and is
 * summarized again from the history as it reads now. A stretch that cannot be read because a compaction hides its
 * entries falls back to the edit rule of a summary without digests, `editedSince`.
 */
function judgeBySources(summary: SummaryState, reading: SourceReading): SummaryEligibility {
	const { order, omitted } = reading;
	const byId = new Map(reading.entries.map((entry) => [entry.id, entry]));
	let hiddenRead = false;
	const lookup = (id: string): LogEntry | undefined => {
		if (!byId.has(id) && !hiddenRead) {
			hiddenRead = true;
			for (const entry of reading.hidden()) byId.set(entry.id, entry);
		}
		return byId.get(id);
	};
	/** The entries of a stretch as they read now, without the omitted ones; undefined when one cannot be read. */
	const read = (fromId: string, throughId: string): { entries: LogEntry[]; ids: string[] } | undefined => {
		const ids = idsBetween(order, fromId, throughId);
		if (ids === undefined) return undefined;
		const entries: LogEntry[] = [];
		for (const id of ids) {
			if (omitted.has(id) || reading.skipped(id)) continue;
			const entry = lookup(id);
			if (!entry) return undefined;
			entries.push(entry);
		}
		return { entries, ids };
	};

	const edited = new Set<string>();
	const kept: SourceStretch[] = [];
	const gaps: UnsummarizedStretch[] = [];
	for (const stretch of summary.sources ?? []) {
		const now = read(stretch.fromId, stretch.throughId);
		// Its ends stand on this branch in order, the fold skipped any other summary: one that cannot be read whole lies
		// behind a checkpoint.
		if (!now) {
			if (reading.editedSince(stretch.throughId)) return { eligible: false, state: summary, reason: "source-edited" };
			kept.push(stretch);
			continue;
		}
		// The digest covers the entries still there: an omission changes it once, and the stretch summarized again after
		// the omission was hashed without the omitted entry, so it settles.
		if (digestOf(...now.entries.map(entryDigest)) === stretch.digest) {
			kept.push(stretch);
			continue;
		}
		for (const id of now.ids) edited.add(id);
		const first = now.entries[0];
		const last = now.entries.at(-1);
		if (first && last) gaps.push({ fromId: first.id, throughId: last.id });
	}
	let partial = summary.partial;
	if (partial) {
		const now = omitted.has(partial.entryId) ? undefined : lookup(partial.entryId);
		if (omitted.has(partial.entryId) || (now && entryDigest(now) !== partial.digest)) {
			edited.add(partial.entryId);
			partial = undefined;
		}
	}
	// A stretch still to summarize again: gone once an edit omitted all of it; its started entry edited, it starts over.
	let gapsChanged = false;
	for (const gap of summary.unsummarized ?? []) {
		const now = read(gap.fromId, gap.throughId);
		if (now && now.entries.length === 0) {
			gapsChanged = true;
			continue;
		}
		const first = now?.entries[0];
		const last = now?.entries.at(-1);
		if (now && first && last && (first.id !== gap.fromId || last.id !== gap.throughId)) {
			// An edit omitted an end: the stretch now starts or ends at the next entry still there.
			if (gap.offset !== undefined) edited.add(gap.fromId);
			gaps.push({ fromId: first.id, throughId: last.id });
			gapsChanged = true;
			continue;
		}
		if (gap.offset !== undefined && first && entryDigest(first) !== gap.digest) {
			edited.add(gap.fromId);
			gaps.push({ fromId: gap.fromId, throughId: gap.throughId });
			gapsChanged = true;
			continue;
		}
		gaps.push(gap);
	}
	if (edited.size === 0 && !gapsChanged) return { eligible: true, state: summary };
	const { partial: _dropped, unsummarized: _gaps, ...rest } = withoutCiting(summary, edited, order);
	gaps.sort((a, b) => (order.get(a.fromId) ?? 0) - (order.get(b.fromId) ?? 0));
	return {
		eligible: true,
		state: { ...rest, sources: kept, ...(partial ? { partial } : {}), ...(gaps.length > 0 ? { unsummarized: gaps } : {}) },
	};
}

/**
 * Our summary stands in for the stale foreign checkpoint: it names it, and a stretch it still trusts covers every
 * entry the checkpoint summarized, none of them waiting to be summarized again.
 */
function supersedesCheckpoint(
	summary: SummaryState | undefined,
	foreign: ForeignCheckpoint | undefined,
	sources: readonly LogEntry[],
	order: ReadonlyMap<string, number>,
): boolean {
	if (!summary || !foreign || foreign.status !== "stale" || sources.length === 0) return false;
	if (summary.supersedes !== foreign.id) return false;
	const stretches = summary.sources ?? [];
	const gaps = summary.unsummarized ?? [];
	return sources.every((entry) => {
		const at = order.get(entry.id);
		if (at === undefined) return false;
		return within(stretches, at, order) && !within(gaps, at, order);
	});
}

function within(ranges: readonly { fromId: string; throughId: string }[], at: number, order: ReadonlyMap<string, number>): boolean {
	return ranges.some((range) => (order.get(range.fromId) ?? Infinity) <= at && at <= (order.get(range.throughId) ?? -Infinity));
}
