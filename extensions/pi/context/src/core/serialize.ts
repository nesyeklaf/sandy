import { createHash } from "node:crypto";
import { withoutSkillBodies } from "./skills.ts";
import type { LogEntry, ToolCallRef } from "./types.ts";

/** Keep head and tail of a long text and mark the omitted middle. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(text.length - tail)}`;
}

/** Collapse whitespace and cut to one bounded line. */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function formatArgs(args: unknown, max: number): string {
	let json: string;
	try {
		json = JSON.stringify(args) ?? "";
	} catch {
		json = String(args);
	}
	return oneLine(json, max);
}

export function ref(entry: LogEntry): string {
	return `#${entry.id}`;
}

export function label(entry: LogEntry): string {
	switch (entry.kind) {
		case "tool":
			return `tool ${entry.toolName ?? ""}${entry.isError ? " (error)" : ""}`.trim();
		case "custom":
			return "note";
		default:
			return entry.kind;
	}
}

export function formatTime(timestamp: number): string {
	return Number.isFinite(timestamp) && timestamp > 0
		? new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")
		: "unknown time";
}

/** `read({"path":"a.ts"})`: how a call is shown wherever it needs to be recognizable. */
export function formatCall(call: ToolCallRef, max: number): string {
	return `${call.name}(${formatArgs(call.args, max)})`;
}

/** Name of a tool result with the call it answers, e.g. `read({"path":"a.ts"}) error`. */
function toolTitle(entry: LogEntry, max: number): string {
	const name = entry.call ? formatCall(entry.call, max) : (entry.toolName ?? "tool");
	return `${name}${entry.isError ? " error" : ""}`;
}

/** A short stable hash of text parts, to tell whether something a summary was made from still reads the same. */
export function digestOf(...parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

const json = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
};

/** What an entry says to the model, hashed: an edit that changes its text or calls changes the digest. */
export function entryDigest(entry: LogEntry): string {
	return digestOf(entry.id, entry.kind, entry.text, json(entry.toolCalls), json(entry.call ?? null), entry.toolName ?? "");
}

/** Compact rendering for the masked tier: reasoning and actions stay, tool output becomes a reference. */
export function renderMasked(entry: LogEntry): string {
	switch (entry.kind) {
		case "user":
			return `[${ref(entry)} user] ${oneLine(withoutSkillBodies(entry.text), 600)}`;
		case "assistant": {
			const calls = entry.toolCalls.map((call) => `${call.name}(${formatArgs(call.args, 160)})`);
			const parts = [oneLine(entry.text, 400), calls.length > 0 ? `→ ${calls.join("; ")}` : ""];
			return `[${ref(entry)} assistant] ${parts.filter((part) => part !== "").join(" ")}`;
		}
		case "tool": {
			const first = entry.text.split("\n").find((line) => line.trim() !== "") ?? "";
			return `[${ref(entry)} ← ${toolTitle(entry, 160)}] ${entry.tokens} tokens archived: ${oneLine(first, 100)}`;
		}
		case "custom":
			return `[${ref(entry)} note] ${oneLine(entry.text, 300)}`;
	}
}

/** Characters of one slice of a long string; the work of pulling a piece is bounded by it. */
const PIECE_CHARS = 4_096;

/** Keys of an object passed over, without a piece to show for them, between two empty pieces that let an abort in. */
const SKIPS_PER_BEAT = 256;

/** Keys from which an object's key list is kept between pages instead of being listed again. */
const WIDE_KEYS = 1_024;

/**
 * The own keys of an object, in the order a resumed place counts them. The list of a wide object has one owner,
 * this map, and lives as long as the object: the entries of a session do not change, so the list stays true.
 */
const wideKeys = new WeakMap<object, readonly (string | symbol)[]>();

function keysOf(value: object): readonly (string | symbol)[] {
	const kept = wideKeys.get(value);
	if (kept) return kept;
	const keys = Reflect.ownKeys(value);
	if (keys.length > WIDE_KEYS) wideKeys.set(value, keys);
	return keys;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * One step into a JSON value on the way to a place in its rendering: the index of an array element, the position of
 * an object key among its own keys, or the offset into a long string. For an element or key, `c` says what is next:
 * 0 the element or key itself, 1 the comma before it, 2 (keys only) the key is written and its value is next. A list
 * of frames from the root names the next piece to render, so rendering resumes there without walking what precedes it.
 */
export type Frame = { readonly a: number; readonly c: 0 | 1 } | { readonly o: number; readonly c: 0 | 1 | 2 } | { readonly s: number };

/** A place in an entry's rendering: the segment it is in and, inside a JSON segment, the frames down to it. */
export interface Mark {
	readonly part: number;
	readonly json: readonly Frame[];
}

/** A piece of a rendering and the place where it begins. */
export interface Piece extends Mark {
	readonly text: string;
}

export interface JsonPiece {
	readonly text: string;
	readonly json: readonly Frame[];
}

const NO_FRAMES: readonly Frame[] = [];

const staleMark = () =>
	new Error("The place this cursor points to is not in the entry any more. Search again without a cursor.");

const isFrame = (value: unknown): value is Frame => {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as Record<string, unknown>;
	const keys = Object.keys(frame);
	const count = (key: string) => Number.isInteger(frame[key]) && (frame[key] as number) >= 0;
	if (keys.length === 1) return keys[0] === "s" && count("s");
	if (keys.length !== 2 || !keys.includes("c")) return false;
	if (keys.includes("a")) return count("a") && (frame.c === 0 || frame.c === 1);
	return keys.includes("o") && count("o") && (frame.c === 0 || frame.c === 1 || frame.c === 2);
};

/**
 * Whether the value is a mark as encoded in a cursor. A mark has one frame per level of JSON the place is nested in, so
 * its depth is not limited here; the caller bounds the size of the cursor it came in, which comes from outside.
 */
export function isMark(value: unknown): value is Mark {
	if (typeof value !== "object" || value === null) return false;
	const { part, json } = value as Record<string, unknown>;
	return Number.isInteger(part) && (part as number) >= 0 && Array.isArray(json) && json.every(isFrame);
}

/**
 * JSON.stringify(value) as a lazy sequence of pieces, none longer than PIECE_CHARS plus its escapes, so a giant
 * argument is never held as one string. It differs from JSON.stringify only where that throws: a bigint is written
 * as its digits and a circular reference as "[Circular]". Each piece names where it begins; passing that list as
 * `resume` renders from that piece on and skips what precedes it, in work proportional to the depth. An object's
 * values are looked at one at a time, so a short read of a wide object does not examine them all. Its key list is
 * taken once for an object wider than WIDE_KEYS and kept (see keysOf), so later pages do not list the keys again.
 */
export function* jsonPieces(value: unknown, resume: readonly Frame[] = NO_FRAMES): Generator<JsonPiece> {
	yield* walk(value, [], [], resume);
}

function* walk(value: unknown, ancestors: readonly unknown[], stack: Frame[], resume: readonly Frame[]): Generator<JsonPiece> {
	const here = (...extra: Frame[]): readonly Frame[] => (extra.length > 0 ? [...stack, ...extra] : stack.slice());
	const depth = stack.length;
	const frame: Frame | undefined = resume[depth];
	if (typeof value === "object" && value !== null && typeof (value as { toJSON?: unknown }).toJSON === "function") {
		value = (value as { toJSON: () => unknown }).toJSON();
	}
	const leaf = (text: string): JsonPiece => {
		if (frame) throw staleMark();
		return { text, json: here() };
	};
	switch (typeof value) {
		case "string": {
			if (value.length <= PIECE_CHARS) {
				yield leaf(JSON.stringify(value));
				return;
			}
			if (frame && !("s" in frame)) throw staleMark();
			let at = frame && "s" in frame ? frame.s : 0;
			if (at > value.length) throw staleMark();
			if (!frame) yield { text: '"', json: here() };
			while (at < value.length) {
				let end = Math.min(at + PIECE_CHARS, value.length);
				if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end--;
				yield { text: JSON.stringify(value.slice(at, end)).slice(1, -1), json: here({ s: at }) };
				at = end;
			}
			yield { text: '"', json: here({ s: value.length }) };
			return;
		}
		case "number":
			yield leaf(Number.isFinite(value) ? String(value) : "null");
			return;
		case "boolean":
		case "bigint":
			yield leaf(String(value));
			return;
		case "object": {
			if (value === null) {
				yield leaf("null");
				return;
			}
			if (ancestors.includes(value)) {
				yield leaf('"[Circular]"');
				return;
			}
			const inside = [...ancestors, value];
			if (Array.isArray(value)) {
				if (frame && !("a" in frame)) throw staleMark();
				const from = frame && "a" in frame ? frame.a : 0;
				if (from > value.length) throw staleMark();
				if (!frame) yield { text: "[", json: here() };
				for (let index = from; index < value.length; index++) {
					const resumed = frame !== undefined && index === from;
					if (index > 0 && (!resumed || frame.c === 1)) {
						stack.push({ a: index, c: 1 });
						yield { text: ",", json: here() };
						stack.pop();
					}
					stack.push({ a: index, c: 0 });
					const item: unknown = value[index];
					if (item === undefined || typeof item === "function" || typeof item === "symbol") yield { text: "null", json: here() };
					else yield* walk(item, inside, stack, resumed ? resume : NO_FRAMES);
					stack.pop();
				}
				yield { text: "]", json: here({ a: value.length, c: 0 }) };
				return;
			}
			if (frame && !("o" in frame)) throw staleMark();
			const keys = keysOf(value);
			const from = frame && "o" in frame ? frame.o : 0;
			if (from > keys.length) throw staleMark();
			let comma: 0 | 1 = frame && "o" in frame && frame.c === 1 ? 1 : 0;
			if (!frame) yield { text: "{", json: here() };
			let skipped = 0;
			for (let at = from; at < keys.length; at++) {
				const key = keys[at] as string | symbol;
				const item: unknown = typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
				if (item === undefined || typeof item === "function" || typeof item === "symbol") {
					if (++skipped % SKIPS_PER_BEAT === 0) yield { text: "", json: here({ o: at + 1, c: comma }) };
					continue;
				}
				const resumed = frame !== undefined && at === from;
				if (!(resumed && "o" in frame && frame.c === 2)) {
					stack.push({ o: at, c: comma });
					yield { text: (comma ? "," : "") + JSON.stringify(key) + ":", json: here() };
					stack.pop();
				}
				stack.push({ o: at, c: 2 });
				yield* walk(item, inside, stack, resumed ? resume : NO_FRAMES);
				stack.pop();
				comma = 1;
			}
			yield { text: "}", json: here({ o: keys.length, c: comma }) };
			return;
		}
		default:
			return;
	}
}

/** The first line of an entry's rendering: its reference, kind and time. */
export function renderHeader(entry: LogEntry): string {
	return ref(entry) + " · " + label(entry) + " · " + formatTime(entry.timestamp);
}

/** The pieces with every non-space character blanked: the same length, so offsets stay valid, but nothing to index. */
export function blankPiece<P extends { readonly text: string }>(piece: P): P {
	return { ...piece, text: piece.text.replace(/\S/g, " ") };
}

type Segment = (resume: readonly Frame[]) => Generator<JsonPiece>;

const plain =
	(text: string): Segment =>
	function* (resume) {
		if (resume.length > 0) throw staleMark();
		yield { text, json: NO_FRAMES };
	};

const argumentsOf =
	(args: unknown): Segment =>
	(resume) =>
		jsonPieces(args, resume);

/** The segments of an entry's rendering, in order; only the JSON ones are long and can be resumed inside. */
const REPLACEMENT_HEADER = "\n[Effective text after the edit; still historical evidence:]\n";

function segmentsOf(entry: LogEntry, hiddenCall?: (toolName: string) => boolean): Segment[] {
	const segments: Segment[] = [plain(renderHeader(entry))];
	const call = (toolCall: ToolCallRef, hidden: boolean) => {
		const parts = [plain(toolCall.name + "("), argumentsOf(toolCall.args), plain(")")];
		return hidden ? parts.map((part): Segment => (resume) => blankAll(part(resume))) : parts;
	};
	if (entry.call) segments.push(plain("\nanswers "), ...call(entry.call, false));
	if (entry.text !== "") segments.push(plain("\n"), plain(entry.text));
	for (const one of entry.toolCalls) {
		const hidden = hiddenCall?.(one.name) ?? false;
		segments.push(hidden ? (resume) => blankAll(plain("\n→ ")(resume)) : plain("\n→ "), ...call(one, hidden));
	}
	// An archived entry an edit replaced also shows how it reads now, so a read or a search finds both.
	const { replacement } = entry as { readonly replacement?: string };
	if (replacement !== undefined) segments.push(plain(REPLACEMENT_HEADER), plain(replacement));
	return segments;
}

function* blankAll(pieces: Iterable<JsonPiece>): Generator<JsonPiece> {
	for (const piece of pieces) yield blankPiece(piece);
}

/**
 * The complete rendering of an entry for history_read as a lazy sequence of pieces: the header, the call a result
 * answers, the text and every call with its whole arguments. Nothing is clipped; a preview is renderMasked. The calls
 * of tools for which hiddenCall holds are blanked: their length stays, so offsets match the unblanked rendering.
 * With `from`, the mark of a piece, the rendering starts at that piece.
 */
export function* renderPieces(entry: LogEntry, hiddenCall?: (toolName: string) => boolean, from?: Mark): Generator<Piece> {
	const segments = segmentsOf(entry, hiddenCall);
	if (from && from.part >= segments.length) throw staleMark();
	for (let part = from?.part ?? 0; part < segments.length; part++) {
		const segment = segments[part] as Segment;
		for (const piece of segment(from && part === from.part ? from.json : NO_FRAMES)) yield { text: piece.text, part, json: piece.json };
	}
}

/** A part of a rendering: offset counts UTF-16 code units from the start of the whole rendering. */
export interface RenderChunk {
	readonly offset: number;
	readonly text: string;
	/** With `back`: the piece holding the place `back` characters before the chunk, to resume rendering from. */
	readonly anchor?: Mark & { readonly offset: number };
}

export interface ChunkOptions {
	/** Offset of the first piece given, when the pieces start at a mark and not at the start of the rendering. */
	readonly base?: number;
	/** Name an anchor this many characters before each chunk. */
	readonly back?: number;
	/** Checked before every piece, so a rendering that yields little for much work can still be stopped. */
	readonly signal?: AbortSignal;
}

/**
 * Cut a lazy sequence of pieces into chunks of at most budget UTF-16 code units, from offset from (an offset in the
 * middle of a surrogate pair moves back to the pair's start). A chunk never ends inside a surrogate pair. Pulling a
 * chunk costs the length skipped to reach from plus the chunk; nothing else is held but one chunk and one piece.
 */
export function* chunkPieces(pieces: Iterable<Piece>, budget: number, from = 0, options: ChunkOptions = {}): Generator<RenderChunk> {
	const size = Math.max(2, Math.floor(budget));
	const { back, signal } = options;
	let position = options.base ?? 0;
	let started = false;
	let start = 0;
	let buffer = "";
	const recent: (Mark & { offset: number })[] = [];
	const anchorFor = (chunkStart: number) => {
		if (back === undefined) return undefined;
		const wanted = Math.max(0, chunkStart - back);
		let found = -1;
		while (found + 1 < recent.length && (recent[found + 1] as { offset: number }).offset <= wanted) found++;
		if (found > 0) recent.splice(0, found);
		return found >= 0 ? { anchor: recent[0] as Mark & { offset: number } } : {};
	};
	for (const piece of pieces) {
		signal?.throwIfAborted();
		const end = position + piece.text.length;
		if (back !== undefined) {
			const place = { offset: position, part: piece.part, json: piece.json };
			if (piece.text === "" && recent.at(-1)?.offset === position) recent[recent.length - 1] = place;
			else recent.push(place);
			if (!started) anchorFor(from);
		}
		let at = 0;
		if (!started) {
			if (end <= from) {
				position = end;
				continue;
			}
			at = Math.max(0, from - position);
			if (at > 0 && isLowSurrogate(piece.text.charCodeAt(at)) && isHighSurrogate(piece.text.charCodeAt(at - 1))) at--;
			started = true;
			start = position + at;
		}
		position = end;
		while (at < piece.text.length) {
			let take = Math.min(size - buffer.length, piece.text.length - at);
			if (take < piece.text.length - at && isHighSurrogate(piece.text.charCodeAt(at + take - 1))) take--;
			if (take > 0) {
				buffer += piece.text.slice(at, at + take);
				at += take;
			}
			if (buffer.length >= size || take === 0) {
				yield { offset: start, text: buffer, ...anchorFor(start) };
				start += buffer.length;
				buffer = "";
			}
		}
	}
	if (buffer !== "") yield { offset: start, text: buffer, ...anchorFor(start) };
}

/** The complete rendering of an entry in bounded chunks; the chunks put together are the whole rendering. */
export function renderChunks(entry: LogEntry, budget: number, from = 0): Generator<RenderChunk> {
	return chunkPieces(renderPieces(entry), budget, from);
}
