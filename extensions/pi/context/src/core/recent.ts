/** A map of at most `limit` keys: setting one more drops the least recently used. */
export class RecentMap<K, V> {
	readonly #entries = new Map<K, V>();
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = limit;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** The value of `key`, which becomes the most recently used. */
	get(key: K): V | undefined {
		const value = this.#entries.get(key);
		if (value !== undefined) this.set(key, value);
		return value;
	}

	/** Set `key` as the most recently used; returns `value`. */
	set(key: K, value: V): V {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		for (const oldest of this.#entries.keys()) {
			if (this.#entries.size <= this.#limit) break;
			this.#entries.delete(oldest);
		}
		return value;
	}
}
