/**
 * Prompt cache continuity, measured on the request payload the provider receives.
 *
 * A request continues the previous one when its header (system prompt, tools, settings) is
 * unchanged and the previous message list is a prefix of the new one. Cache breakpoint
 * markers move every turn by design, so they are ignored. A shape keeps one 53-bit hash per
 * payload item and one for the header, never the content.
 */

const MESSAGE_ARRAYS = ["messages", "input", "contents"] as const;
const VOLATILE_KEYS = new Set(["stream", "max_tokens", "max_output_tokens", "max_completion_tokens"]);
const CACHE_MARKERS = new Set(["cache_control", "cachePoint"]);

export interface RequestShape {
	readonly head: number;
	readonly items: readonly number[];
}

export type Continuity =
	| { readonly kind: "first" }
	| { readonly kind: "continued" }
	| { readonly kind: "broken"; readonly at: "head" | number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON with sorted keys and without cache markers. A string `content` reads as one text block: the provider treats
 * them alike, and pi-ai sends the message that carries the cache marker as a block and the same message later as a
 * string.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (CACHE_MARKERS.has(key)) continue;
		const field = value[key];
		out[key] = key === "content" && typeof field === "string" ? [{ text: field, type: "text" }] : normalize(field);
	}
	return out;
}

/**
 * A 53-bit hash of a string (cyrb53): pure, and exact as a JavaScript number. A changed item keeps its hash, and so
 * hides its change, with odds of about one in 2^53.
 */
export function hash53(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The hash of a value's {@link stableStringify}. */
export function hashValue(value: unknown): number {
	return hash53(stableStringify(value));
}

/** Shape of a provider payload, or undefined when it has no recognizable message list. */
export function requestShape(payload: unknown): RequestShape | undefined {
	if (!isRecord(payload)) return undefined;
	const key = MESSAGE_ARRAYS.find((name) => Array.isArray(payload[name]));
	if (!key) return undefined;
	const head: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(payload)) {
		if (name !== key && !VOLATILE_KEYS.has(name)) head[name] = value;
	}
	return { head: hashValue(head), items: (payload[key] as unknown[]).map(hashValue) };
}

export function headParts(payload: unknown): Record<string, number> {
	if (!isRecord(payload)) return {};
	const key = MESSAGE_ARRAYS.find((name) => Array.isArray(payload[name]));
	const names = Object.keys(payload).filter((name) => name !== key && !VOLATILE_KEYS.has(name));
	return Object.fromEntries(names.sort().map((name) => [name, hashValue(payload[name])]));
}

/**
 * The head's share of a request in characters: everything but the message list. Times the prompt tokens the provider
 * counted for that request it gives the size of the system prompt and tools, which no cut shrinks.
 */
export function headShare(payload: unknown): number | undefined {
	if (!isRecord(payload)) return undefined;
	const key = MESSAGE_ARRAYS.find((name) => Array.isArray(payload[name]));
	if (!key) return undefined;
	let head = 0;
	for (const [name, value] of Object.entries(payload)) {
		if (name !== key && !VOLATILE_KEYS.has(name)) head += stableStringify(value).length;
	}
	return head / (head + stableStringify(payload[key]).length);
}

export function compareShapes(previous: RequestShape | undefined, next: RequestShape): Continuity {
	if (!previous) return { kind: "first" };
	if (previous.head !== next.head) return { kind: "broken", at: "head" };
	const shared = Math.min(previous.items.length, next.items.length);
	for (let index = 0; index < shared; index++) {
		if (previous.items[index] !== next.items[index]) return { kind: "broken", at: index };
	}
	if (next.items.length < previous.items.length) return { kind: "broken", at: next.items.length };
	return { kind: "continued" };
}

export interface ItemPrint {
	readonly hash: number;
	readonly length: number;
	readonly start: string;
	readonly end: string;
}

export interface ShapeSnapshot {
	readonly head: Record<string, number>;
	readonly items: readonly ItemPrint[];
	/** The head in the provider's tokens, measured on this request; a restarted process starts from it. */
	readonly headTokens?: number;
}

export interface ResumeDiff {
	readonly at: "continued" | "head" | number;
	readonly headKeys: readonly string[];
	readonly previousItems: number;
	readonly before?: ItemPrint;
	readonly after?: ItemPrint;
}

function printOf(value: unknown): ItemPrint {
	const text = stableStringify(value);
	return { hash: hash53(text), length: text.length, start: text.slice(0, 240), end: text.slice(-160) };
}

export function snapshotOf(payload: unknown): ShapeSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const key = MESSAGE_ARRAYS.find((name) => Array.isArray(payload[name]));
	if (!key) return undefined;
	return { head: headParts(payload), items: (payload[key] as unknown[]).map(printOf) };
}

export function diffSnapshots(previous: ShapeSnapshot, next: ShapeSnapshot): ResumeDiff {
	const names = [...new Set([...Object.keys(previous.head), ...Object.keys(next.head)])].sort();
	const headKeys = names.filter((name) => previous.head[name] !== next.head[name]);
	const base = { headKeys, previousItems: previous.items.length };
	if (headKeys.length > 0) return { at: "head", ...base };
	const shared = Math.min(previous.items.length, next.items.length);
	for (let index = 0; index < shared; index++) {
		if (previous.items[index]?.hash !== next.items[index]?.hash) {
			return { at: index, ...base, before: previous.items[index], after: next.items[index] };
		}
	}
	if (next.items.length < previous.items.length) return { at: next.items.length, ...base, before: previous.items[next.items.length] };
	return { at: "continued", ...base };
}
