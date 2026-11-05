import { DUPLICATE_KIND } from "./kinds.ts";
import { textOf } from "./messages.ts";
import { digestOf } from "./serialize.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Identical reads kept once. When the agent reads the same file again with the same arguments and gets exactly the
 * same text, the model already holds that text further up. The newer result, which no request has carried yet, is
 * replaced by a short note that points at the earlier one; the older result is never touched, so the prompt cache of
 * everything sent so far stays valid. The raw result survives in the log: a replacement is an append-only context edit.
 *
 * Only top-level text reads count. An error, an image, a different range, changed content, a result another extension
 * edited, and a read made inside another tool (codemode) are left as they are. A note never points at another note: the
 * earlier read is whole in the model's context when the note is made. A note stays true after a cut takes that earlier
 * read away, since it names the entry history_read opens; no request ever needs it repaired, and a repair after a request
 * would break the cached prefix a second time. Our own cut at a turn boundary breaks the prefix anyway, so there a kept
 * note whose text the context no longer holds gets that text back (a promotion), one note per text, when the cut still
 * frees enough with it.
 *
 * Pure: the pi session reader turns the branch into {@link ReadObservation}s; the cut controller turns the answers into
 * context edits and ownership records.
 */

/** Smallest saving, in estimated tokens, that is worth an edit; a short file costs about as much as its note. */
export const MIN_DUPLICATE_TOKENS = 150;

/** Where a read result stands in the model's context. */
export type ReadState =
	/** As the tool wrote it. */
	| "full"
	/** Our note, still the latest word on the entry. */
	| "alias"
	/** Edited by someone else. */
	| "foreign";

/** One top-level read result in the model's context, oldest first. */
export interface ReadObservation {
	readonly id: string;
	readonly toolCallId: string;
	/** The call's arguments in a canonical form: the same read has the same string. */
	readonly call: string;
	/**
	 * Digest of the result's whole content as written; undefined when it is not plain successful text or another
	 * extension edited it. A note of ours keeps the digest of the read it stands for.
	 */
	readonly content: string | undefined;
	/** Estimated tokens of the result as the model sees it now. */
	readonly tokens: number;
	readonly path: string;
	readonly state: ReadState;
	/** The content as the tool wrote it, for a promotion. */
	readonly original: unknown;
}

/** What we stored when we replaced a read: no content, only where it points and what the replacement was. */
export interface DuplicateRecord {
	/** The entry whose result we replaced. */
	readonly alias: string;
	/** The earlier read it points at. */
	readonly of: string;
	/** Estimated tokens the replacement saves. */
	readonly tokens: number;
	/** Digest of the replacement content: the record owns the edit only while that edit is the latest on the alias. */
	readonly digest: string;
}

export interface DuplicateCollapse {
	readonly targetId: string;
	readonly replacement: { readonly content: unknown };
	readonly record: DuplicateRecord;
}

/** The context edits and their ownership records for one boundary, in the order they are appended. */
export type OwnedDuplicateEdits = readonly DuplicateCollapse[];

export interface DuplicateFrame {
	readonly reads: readonly ReadObservation[];
	/** Tool call ids of the results no request has carried yet: only these may be replaced. */
	readonly fresh: ReadonlySet<string>;
	/** Entries a cut at this boundary takes out of the model's context; no note is made of or for them. */
	readonly archived?: ReadonlySet<string>;
}

/** A call's arguments with sorted keys and without empty values, so the same read compares equal however it was written. */
export function canonicalCall(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const entries = Object.entries(args as Record<string, unknown>)
		.filter(([, value]) => value !== undefined && value !== null)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(entries);
}

/** The digest of content, or undefined unless it is a list of text blocks only (an image or an unknown block is not compared). */
export function textDigest(content: unknown): string | undefined {
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const plain = content.every(
		(block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
	);
	return plain ? replacementDigest(content) : undefined;
}

export const replacementDigest = (content: unknown): string => digestOf(JSON.stringify(content) ?? "");

/**
 * The note that stands in for a repeated read. It names the earlier result by entry id, which history_read opens, so it
 * stays true after a cut archives that result. Equal output does not prove the file is unchanged (a truncated read
 * shows only part of it), so the note claims only the same text.
 */
export function aliasText(path: string, of: string): string {
	return `[Same as the earlier read of ${path} with the same arguments: it returned the same text, which is not repeated here. That text is further up; once it has left your context, history_read #${of} returns it.]`;
}

export const aliasContent = (path: string, of: string): { type: "text"; text: string }[] => [{ type: "text", text: aliasText(path, of) }];

/**
 * Which fresh reads to replace. The representative of a read is the earliest read still whole with the same call and
 * the same content; a fresh read after it is replaced, a note never stands for a note.
 */
export function duplicateReadEdits(frame: DuplicateFrame, minTokens = MIN_DUPLICATE_TOKENS): OwnedDuplicateEdits {
	const first = new Map<string, ReadObservation>();
	const collapses: DuplicateCollapse[] = [];
	for (const read of frame.reads) {
		if (read.state !== "full" || read.content === undefined) continue;
		const key = read.call + "\u0000" + read.content;
		const representative = first.get(key);
		if (!representative) {
			first.set(key, read);
			continue;
		}
		if (!frame.fresh.has(read.toolCallId)) continue;
		if (frame.archived?.has(read.id) || frame.archived?.has(representative.id)) continue;
		const content = aliasContent(read.path, representative.id);
		const saved = read.tokens - estimateTokens(content[0]!.text);
		if (saved < minTokens) continue;
		collapses.push({
			targetId: read.id,
			replacement: { content },
			record: { alias: read.id, of: representative.id, tokens: saved, digest: replacementDigest(content) },
		});
	}
	return collapses;
}

/** A note turned back into the read it stands for, and the estimated tokens that puts back into the context. */
export interface DuplicatePromotion {
	readonly targetId: string;
	readonly replacement: { readonly content: unknown };
	readonly tokens: number;
}

/**
 * The notes a cut turns back into the full read: a note the cut keeps whose text no read the cut keeps holds whole, the
 * earliest one per text. Its earlier read is gone, and so is every other whole copy; a later note of the same text
 * stays a note, since the promoted one holds the text again further up. `archived` are the entries the cut takes out.
 */
export function duplicatePromotions(
	reads: readonly ReadObservation[],
	aliases: ReadonlyMap<string, DuplicateRecord>,
	archived: ReadonlySet<string>,
): DuplicatePromotion[] {
	const textKey = (read: ReadObservation) => (read.content === undefined ? undefined : read.call + "\u0000" + read.content);
	const wholeIds = new Set<string>();
	const held = new Set<string>();
	for (const read of reads) {
		if (read.state !== "full" || archived.has(read.id)) continue;
		wholeIds.add(read.id);
		const key = textKey(read);
		if (key !== undefined) held.add(key);
	}
	const promotions: DuplicatePromotion[] = [];
	for (const read of reads) {
		const record = read.state === "alias" && !archived.has(read.id) ? aliases.get(read.id) : undefined;
		if (!record || wholeIds.has(record.of)) continue;
		const key = textKey(read);
		if (key !== undefined && held.has(key)) continue;
		if (key !== undefined) held.add(key);
		const tokens = Math.max(0, estimateTokens(textOf(read.original)) - read.tokens);
		promotions.push({ targetId: read.id, replacement: { content: read.original }, tokens });
	}
	return promotions;
}

/**
 * {@link duplicatePromotions} for a cut that keeps from the entry after which `inKept` is false: the same notes, found
 * from the reads the cut keeps alone. The reads come in branch order, so the kept ones are the tail of the list; it is
 * read from the end and stops at the first read the cut archives, so the work is the size of what the cut keeps and
 * not of the history. Used for the cap, whose plan is made at every cut.
 */
export function promotionsFromKept(
	reads: readonly ReadObservation[],
	aliases: ReadonlyMap<string, DuplicateRecord>,
	inKept: (id: string) => boolean,
): DuplicatePromotion[] {
	let from = reads.length;
	while (from > 0 && inKept((reads[from - 1] as ReadObservation).id)) from--;
	return duplicatePromotions(reads.slice(from), aliases, new Set());
}

/** The record an entry's data holds, or undefined when it is not one. */
export function readDuplicateRecord(data: unknown): DuplicateRecord | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	const { alias, of, tokens, digest } = record;
	if (typeof alias !== "string" || typeof of !== "string" || typeof digest !== "string") return undefined;
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
	return { alias, of, tokens, digest };
}

/** A session entry as pi stores it; the fields the ownership reading needs. */
type Raw = { readonly type: string } & Readonly<Record<string, unknown>>;

/**
 * The notes of ours that are still the latest word on their entry, by entry id. A note is ours while the latest context
 * edit of its entry is the one the record describes; any later edit, another extension's or our promotion, ends it.
 */
export function liveAliases(raw: readonly { readonly type: string }[]): Map<string, DuplicateRecord> {
	const latest = new Map<string, string>();
	const live = new Map<string, DuplicateRecord>();
	for (const entry of raw as readonly Raw[]) {
		if (entry.type === "context_edit" && typeof entry.targetId === "string") {
			const replacement = entry.replacement as { content?: unknown } | null | undefined;
			latest.set(entry.targetId, replacement ? replacementDigest(replacement.content) : "omitted");
			live.delete(entry.targetId);
		} else if (entry.type === "custom" && entry.customType === DUPLICATE_KIND) {
			const record = readDuplicateRecord(entry.data);
			if (record && latest.get(record.alias) === record.digest) live.set(record.alias, record);
		}
	}
	return live;
}
