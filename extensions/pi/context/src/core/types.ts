import type { SummaryState } from "./summary.ts";

/** Kinds of context-producing entries in the session log. */
export type EntryKind = "user" | "assistant" | "tool" | "custom";

export interface ToolCallRef {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
}

/**
 * One context-producing entry of the session log, in branch order.
 *
 * The log is append-only. Everything in this package is a pure function of it, so the
 * model view can always be rebuilt and every derived index can be thrown away.
 */
export interface LogEntry {
	readonly id: string;
	readonly kind: EntryKind;
	/** Unix milliseconds. */
	readonly timestamp: number;
	/** Model-visible text: message text, tool output, or custom content. */
	readonly text: string;
	/** Tool calls of an assistant entry; empty otherwise. */
	readonly toolCalls: readonly ToolCallRef[];
	/** Tool name of a tool-result entry. */
	readonly toolName?: string;
	/** The call a tool-result entry answers, so its output can be found by the call's arguments. */
	readonly call?: ToolCallRef;
	readonly isError?: boolean;
	/** Estimated tokens of the entry as the model sees it. */
	readonly tokens: number;
}

declare const MODEL_VIEW: unique symbol;
declare const EFFECTIVE_HISTORY: unique symbol;
declare const ARCHIVE_READER: unique symbol;

/**
 * A compaction summary on the branch. Ours is a cut; any other is foreign, and its text is carried verbatim, never
 * regenerated. `stale` marks a checkpoint whose sources were edited after it was written; it is carried all the same.
 */
export interface Checkpoint {
	/** The compaction entry. */
	readonly id: string;
	readonly owner: "own" | "foreign";
	readonly text: string;
	readonly status: "current" | "stale";
}

export interface ForeignCheckpoint extends Checkpoint {
	readonly owner: "foreign";
}

/**
 * How far a stored summary can be trusted. A summary records no digests of its sources, so it is trusted only while no
 * edit it did not see touches an entry it covers; such an edit may have taken away text the summary still holds. A
 * summary marked with the entry its history was read at saw the edits up to it; an unmarked one saw none.
 */
export type SummaryEligibility =
	| { readonly eligible: true; readonly state: SummaryState }
	| { readonly eligible: false; readonly state: SummaryState; readonly reason: "source-edited" };

/**
 * What the provider gets: the latest checkpoint, ours or foreign, and the entries after it with every edit applied.
 * Only the session reader of a host makes one; for the cut envelope and duplicate reads.
 */
export interface ModelView<Message = unknown> {
	readonly [MODEL_VIEW]: true;
	/** The host's messages in the order the provider gets them. */
	readonly messages: readonly Message[];
	readonly checkpoint: Checkpoint | undefined;
	/** The entries the model sees verbatim, edits applied. */
	readonly entries: readonly LogEntry[];
	/** Estimated tokens of the checkpoint text and the entries. */
	readonly tokens: number;
}

/**
 * The history the engine plans from: every edit applied, our own cuts see-through so earlier work stays reachable. A
 * foreign checkpoint hides what it archived and is carried as it is. For cuts and the historian.
 */
export interface EffectiveHistory {
	readonly [EFFECTIVE_HISTORY]: true;
	readonly entries: readonly LogEntry[];
	readonly checkpoint: ForeignCheckpoint | undefined;
	/**
	 * The entries a stale foreign checkpoint summarized, with every edit applied, oldest first: what a summary can be made
	 * from to replace it. Empty when the checkpoint is current or absent.
	 */
	readonly checkpointSources: readonly LogEntry[];
	/**
	 * Our summary stands in for the stale checkpoint: it names it and a valid stretch of it covers every one of its
	 * sources. A cut may then drop the checkpoint.
	 */
	readonly checkpointSuperseded: boolean;
	/**
	 * Every entry's position on the branch, those an edit omitted or a compaction hides included: the order a range
	 * `#a … #b` is read in.
	 */
	readonly order: ReadonlyMap<string, number>;
	/** First index after the latest compaction; a new cut keeps nothing before it. */
	readonly minKeptIndex: number;
	/** First index the model sees verbatim now. */
	readonly visibleFromIndex: number;
	/** The latest summary, when it can be trusted. */
	readonly summary: SummaryState | undefined;
	readonly summaryEligibility: SummaryEligibility | undefined;
	readonly notebook: string | undefined;
}

/**
 * Where an entry stands with the model: seen as written, replaced or omitted by an edit (the archive keeps the
 * original), or archived by a compaction.
 */
export type ArchiveStatus = "visible" | "replaced" | "omitted" | "archived";

export interface ArchivedEntry extends LogEntry {
	readonly status: ArchiveStatus;
	/** How a replaced entry reads after the edit; behind a foreign checkpoint, read only when the entry is rendered. */
	readonly replacement?: string;
}

/**
 * A compaction on the branch, as the archive keeps it: its summary text and the entries it newly summarized, those
 * after the previous compaction's kept range and before its own.
 */
export interface ArchivedCompaction {
	readonly id: string;
	readonly owner: "own" | "foreign";
	readonly timestamp: number;
	readonly summary: string;
	readonly covers: { readonly from: string; readonly through: string; readonly count: number } | undefined;
	/** The earlier compaction whose summary this one builds on. */
	readonly buildsOn: string | undefined;
}

/** One thing the archive holds, in branch order. */
export type ArchiveItem =
	| { readonly kind: "entry"; readonly entry: ArchivedEntry }
	| { readonly kind: "compaction"; readonly compaction: ArchivedCompaction };

export interface ArchiveReadRequest {
	/** An entry or compaction id, with or without the leading #, or a unique prefix of four characters or more. */
	readonly id: string;
	/** Neighbors listed compactly before and after. */
	readonly around?: number;
	/** UTF-16 code unit offset into the rendering. */
	readonly offset?: number;
	readonly maxChars?: number;
}

export interface ArchiveReadPage {
	readonly id: string;
	readonly text: string;
	/** Where the item stands with the model; a compaction is "compaction". */
	readonly status: ArchiveStatus | "compaction";
	/** Offset of the next page, when the rendering goes on. */
	readonly next?: number;
}

export interface ArchiveSearchRequest {
	readonly query: string;
	readonly limit?: number;
	readonly includeVisible?: boolean;
	/** Continuation of an earlier answer of the same archive's branch. */
	readonly cursor?: string;
}

export interface ArchiveSearchPage {
	readonly text: string;
	readonly hits: readonly string[];
	/** Continuation for the older text that remains, when the scan stopped at its work bound. */
	readonly cursor?: string;
	/** Searchable entries appended since the search began (only counted on a continuation). */
	readonly newer: number;
	/** Entries this page scanned. */
	readonly scanned: number;
}

/**
 * Every context entry and compaction of the branch as it was written, for search and read. Search and read are
 * bounded by work in characters and stop when the signal aborts; a search cursor points into the branch it began on.
 */
export interface ArchiveReader {
	readonly [ARCHIVE_READER]: true;
	readonly entries: readonly ArchivedEntry[];
	readonly items: readonly ArchiveItem[];
	read(request: ArchiveReadRequest, signal?: AbortSignal): Promise<ArchiveReadPage>;
	search(request: ArchiveSearchRequest, signal?: AbortSignal): Promise<ArchiveSearchPage>;
}
