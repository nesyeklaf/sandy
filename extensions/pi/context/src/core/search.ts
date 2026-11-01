/**
 * Lexical BM25 search over the session log.
 *
 * The index is derived data: it lives in memory and is rebuilt from the log whenever needed.
 * Lexical search is deliberate. Agents that search their own raw history with plain keyword
 * queries beat graph and embedding memories (ReFind, arXiv 2608.12888), and coding work is
 * full of exact identifiers, paths and error strings.
 */

const K1 = 1.2;
const B = 0.75;
const MIN_TERM = 2;
const MAX_TERM = 64;

/** Lowercased terms; identifiers also contribute their camelCase and snake_case parts. */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	// Compound names like report-4.txt, gpt-6-luna or src/a-b.ts stay findable as a whole and
	// without their extension; their single characters alone would be too short to index.
	for (const word of text.split(/[\s"'`()[\]{}<>,;=|]+/)) {
		const whole = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
		if (!/[-./:]/.test(whole)) continue;
		const pieces = new Set([whole]);
		for (const part of whole.split(/[/:\\]+/)) {
			if (/[-.]/.test(part)) pieces.add(part);
			for (const sub of part.split(".")) if (sub.includes("-")) pieces.add(sub);
		}
		for (const piece of pieces) if (piece.length >= MIN_TERM && piece.length <= MAX_TERM) terms.push(piece);
	}
	for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
		if (raw === "") continue;
		const whole = raw.toLowerCase();
		if (whole.length >= MIN_TERM && whole.length <= MAX_TERM) terms.push(whole);
		const parts = raw.split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u);
		if (parts.length < 2) continue;
		for (const part of parts) {
			const lower = part.toLowerCase();
			if (lower !== whole && lower.length >= MIN_TERM && lower.length <= MAX_TERM) terms.push(lower);
		}
	}
	return terms;
}

/** The weight of a term that `documents` of `count` documents contain. */
export function inverseDocumentFrequency(count: number, documents: number): number {
	return Math.log(1 + (count - documents + 0.5) / (documents + 0.5));
}

/** The BM25 score one term gives a document, which holds it `frequency` times in `length` terms. */
export function termScore(idf: number, frequency: number, length: number, averageLength: number): number {
	const norm = frequency + K1 * (1 - B + (B * length) / averageLength);
	return (idf * frequency * (K1 + 1)) / norm;
}

interface IndexedDoc {
	readonly termFrequency: ReadonlyMap<string, number>;
	readonly length: number;
	readonly order: number;
}

export interface SearchHit {
	readonly id: string;
	readonly score: number;
}

export interface SearchOptions {
	readonly limit: number;
	/** Restrict results, for example to entries that left the model context. */
	readonly accept?: (id: string) => boolean;
}

export class SearchIndex {
	readonly #docs = new Map<string, IndexedDoc>();
	readonly #postings = new Map<string, string[]>();
	#totalLength = 0;

	get size(): number {
		return this.#docs.size;
	}

	has(id: string): boolean {
		return this.#docs.has(id);
	}

	/** Add a document once; later calls with the same id are ignored because log entries never change. */
	add(id: string, text: string): void {
		if (this.#docs.has(id)) return;
		const terms = tokenize(text);
		const termFrequency = new Map<string, number>();
		for (const term of terms) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
		this.#docs.set(id, { termFrequency, length: terms.length, order: this.#docs.size });
		this.#totalLength += terms.length;
		for (const term of termFrequency.keys()) {
			const posting = this.#postings.get(term);
			if (posting) posting.push(id);
			else this.#postings.set(term, [id]);
		}
	}

	/** Rank by BM25; ties go to the newer entry. */
	search(query: string, options: SearchOptions): SearchHit[] {
		const terms = [...new Set(tokenize(query))];
		const count = this.#docs.size;
		if (terms.length === 0 || count === 0 || options.limit <= 0) return [];
		const averageLength = this.#totalLength / count || 1;
		const scores = new Map<string, number>();
		for (const term of terms) {
			const posting = this.#postings.get(term);
			if (!posting) continue;
			const idf = inverseDocumentFrequency(count, posting.length);
			for (const id of posting) {
				if (options.accept && !options.accept(id)) continue;
				const doc = this.#docs.get(id);
				const frequency = doc?.termFrequency.get(term);
				if (!doc || !frequency) continue;
				scores.set(id, (scores.get(id) ?? 0) + termScore(idf, frequency, doc.length, averageLength));
			}
		}
		const order = (id: string) => this.#docs.get(id)?.order ?? 0;
		return [...scores]
			.map(([id, score]) => ({ id, score }))
			.sort((a, b) => b.score - a.score || order(b.id) - order(a.id))
			.slice(0, options.limit);
	}
}

/** A hit with its place in the log: a larger `order` is a newer entry. */
export interface RankedHit extends SearchHit {
	readonly order: number;
}

function worse(a: RankedHit, b: RankedHit): boolean {
	return a.score < b.score || (a.score === b.score && a.order < b.order);
}

/** The best `limit` hits offered, in a heap that holds no more than that: the worst one sits at the root. */
export class TopHits {
	readonly #heap: RankedHit[] = [];
	readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	offer(hit: RankedHit): void {
		const heap = this.#heap;
		if (this.limit <= 0) return;
		if (heap.length < this.limit) {
			heap.push(hit);
			this.#up(heap.length - 1);
		} else if (heap[0] && worse(heap[0], hit)) {
			heap[0] = hit;
			this.#down(0);
		}
	}

	/** Best first; ties go to the newer entry. */
	sorted(): SearchHit[] {
		return [...this.#heap]
			.sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0))
			.map(({ id, score }) => ({ id, score }));
	}

	#swap(a: number, b: number): void {
		const heap = this.#heap;
		[heap[a], heap[b]] = [heap[b] as RankedHit, heap[a] as RankedHit];
	}

	#up(from: number): void {
		const heap = this.#heap;
		for (let at = from; at > 0;) {
			const parent = (at - 1) >> 1;
			if (!worse(heap[at] as RankedHit, heap[parent] as RankedHit)) return;
			this.#swap(at, parent);
			at = parent;
		}
	}

	#down(from: number): void {
		const heap = this.#heap;
		for (let at = from; ;) {
			let worst = at;
			for (const child of [2 * at + 1, 2 * at + 2]) {
				if (child < heap.length && worse(heap[child] as RankedHit, heap[worst] as RankedHit)) worst = child;
			}
			if (worst === at) return;
			this.#swap(at, worst);
			at = worst;
		}
	}
}

/** A short window of the text around the first query term it contains. */
export function snippet(text: string, query: string, width = 280): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const term of new Set(tokenize(query))) {
		const found = lower.indexOf(term);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	const start = Math.max(0, at < 0 ? 0 : at - Math.floor(width / 3));
	const end = Math.min(text.length, start + width);
	const window = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${window}${end < text.length ? "…" : ""}`;
}
