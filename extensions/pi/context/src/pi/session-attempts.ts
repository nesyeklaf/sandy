/**
 * The historian's receipts as one ordered stream. pi reads a session file once, when it opens it; another process on
 * the same file (two terminals resuming one session) appends records this one never loads, and a process that opened
 * the file early appends its records under the leaf it read, beside everyone else's. The count and the wait of a
 * piece of work have to include all of them, or each process pays its own three requests for the same work.
 *
 * Scope: every attempt record of the session, whichever process or branch wrote it. The file's records come first,
 * in file order, then this process's records the file does not hold yet (pi writes a new session only once it has an
 * answer, and an in-memory session has no file), each record id once. Branches share the count because a work key
 * names the work by its whole input (see `workKey`): a branch that reads the same stretch with the same summary would
 * send the same paid request again. Work that differs on a branch has another key and a count of its own. Retry
 * markers and endings apply in stream order, so a retry clears every attempt before it, wherever it was written.
 *
 * The file is read by {@link SessionFileTail}, which the keep-warm records and the reports read their entries with too.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { AttemptFold, type AttemptEntry, type AttemptsState, readAttemptEntry } from "../core/attempts.ts";
import { ATTEMPT_KIND } from "../core/kinds.ts";

/** A session entry as the manager holds it; only custom attempt records are read. */
export interface ReceiptSource {
	readonly type: string;
	readonly id: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/** What the session's receipts say: the unfinished work by key, and the work whose summary was stored. */
export interface Receipts {
	readonly unfinished: AttemptsState;
	readonly stored: ReadonlySet<string>;
}

/** How many bytes before the read offset prove that the file only grew since the last read. */
const CONTINUITY_BYTES = 4096;

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A session file line as JSON: the entry fields every reader checks. */
export interface SessionLine {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
}

/**
 * Reads the entries of a session file as it grows: each read takes only what was appended, while the file only grew,
 * and keeps what `take` makes of each entry. A line that does not contain `marker` is skipped unparsed, so a reader
 * of one record kind does not parse the transcript. A file that was replaced, truncated or rewritten is read again.
 */
export class SessionFileTail<T> {
	readonly #file: string | undefined;
	readonly #take: (entry: SessionLine) => T | undefined;
	readonly #marker: string | undefined;
	#offset = 0;
	#partial = "";
	/** Which file was read: its identity and a digest of the bytes just before `#offset`. */
	#identity: { readonly dev: number; readonly ino: number; readonly tail: string } | undefined;
	#records: T[] = [];

	constructor(file: string | undefined, take: (entry: SessionLine) => T | undefined, marker?: string) {
		this.#file = file;
		this.#take = take;
		this.#marker = marker;
	}

	/** Every record of the file so far, in file order; none for a session without a file or one not written yet. */
	read(): readonly T[] {
		this.#scan();
		return this.#records;
	}

	#reset(): void {
		this.#offset = 0;
		this.#partial = "";
		this.#identity = undefined;
		this.#records = [];
	}

	/** Whether the open file is the one read so far and still holds the same bytes before the read offset. */
	#continues(fd: number, stat: { dev: number; ino: number; size: number }): boolean {
		const identity = this.#identity;
		if (!identity) return this.#offset === 0;
		if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size < this.#offset) return false;
		return this.#tail(fd) === identity.tail;
	}

	/** A digest of the bytes just before `#offset`. */
	#tail(fd: number): string {
		const length = Math.min(this.#offset, CONTINUITY_BYTES);
		const bytes = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const read = readSync(fd, bytes, filled, length - filled, this.#offset - length + filled);
			if (read === 0) break;
			filled += read;
		}
		return digest(bytes.subarray(0, filled));
	}

	#scan(): void {
		if (this.#file === undefined) return;
		let fd: number;
		try {
			fd = openSync(this.#file, "r");
		} catch {
			// Not written yet: pi stores a session once it has an answer.
			if (this.#offset > 0) this.#reset();
			return;
		}
		try {
			const stat = fstatSync(fd);
			// Replaced, truncated or rewritten: what was read cannot be proven to still be there, so read it all again.
			if (!this.#continues(fd, stat)) this.#reset();
			const chunks: Buffer[] = [];
			while (this.#offset < stat.size) {
				const chunk = Buffer.alloc(Math.min(stat.size - this.#offset, 1 << 20));
				const read = readSync(fd, chunk, 0, chunk.length, this.#offset);
				if (read === 0) break;
				chunks.push(chunk.subarray(0, read));
				this.#offset += read;
			}
			this.#identity = { dev: stat.dev, ino: stat.ino, tail: this.#tail(fd) };
			if (chunks.length === 0) return;
			const lines = (this.#partial + Buffer.concat(chunks).toString("utf8")).split("\n");
			// The last piece is a line still being written, or empty after a complete one.
			this.#partial = lines.pop() ?? "";
			for (const line of lines) this.#line(line);
		} finally {
			closeSync(fd);
		}
	}

	#line(line: string): void {
		if (this.#marker !== undefined ? !line.includes(this.#marker) : line.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const record = this.#take(value as SessionLine);
		if (record !== undefined) this.#records.push(record);
	}
}

/** The custom records of one kind in a session file, read by `read` from each entry's data. */
export function customRecords<T>(file: string | undefined, kind: string, read: (data: unknown) => T | undefined): SessionFileTail<T> {
	return new SessionFileTail(file, (entry) => (entry.type === "custom" && entry.customType === kind ? read(entry.data) : undefined), kind);
}

/** Reads a session file's receipts as it grows. */
export class SessionReceipts {
	readonly #tail: SessionFileTail<{ readonly entryId: string; readonly entry: AttemptEntry }>;

	constructor(file: string | undefined) {
		this.#tail = new SessionFileTail(
			file,
			(line) => {
				if (line.type !== "custom" || line.customType !== ATTEMPT_KIND || typeof line.id !== "string") return undefined;
				const entry = readAttemptEntry(line.data);
				return entry ? { entryId: line.id, entry } : undefined;
			},
			ATTEMPT_KIND,
		);
	}

	/** The receipts of the file, then those of `local` (this process's session entries) the file does not hold. */
	read(local: Iterable<ReceiptSource>): Receipts {
		const seen = new Set<string>();
		const fold = new AttemptFold();
		const stored = new Set<string>();
		const add = (entryId: string, entry: AttemptEntry) => {
			if (seen.has(entryId)) return;
			seen.add(entryId);
			fold.add(entry);
			if (entry.type === "end" && entry.outcome === "stored") stored.add(entry.key);
		};
		for (const record of this.#tail.read()) add(record.entryId, record.entry);
		for (const source of local) {
			if (source.type !== "custom" || source.customType !== ATTEMPT_KIND) continue;
			const entry = readAttemptEntry(source.data);
			if (entry) add(source.id, entry);
		}
		return { unfinished: fold.snapshot(), stored };
	}
}
