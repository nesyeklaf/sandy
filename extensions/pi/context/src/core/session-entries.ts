/**
 * A session's entries as the reports read them: one ordered list, each entry once. pi loads a session file once; another
 * process on the same file appends entries this one never sees, and a fork (`createBranchedSession`) copies its
 * ancestors into a new file under the same ids. The reports read the file again and merge it with what this process
 * holds, and `npm run measure` merges a fork with the session it came from, so a request is counted once wherever it
 * is written.
 *
 * Pure: the caller reads the files.
 */

/** A session entry as pi stores it; only the fields the reports read. */
export type RawEntry = { readonly type: string };

/** The entries of a session file's lines; a line that is no JSON object (a line still being written) is skipped. */
export function parseEntries(lines: readonly string[]): RawEntry[] {
	return lines.flatMap((line) => {
		if (line.trim() === "") return [];
		try {
			const entry: unknown = JSON.parse(line);
			return typeof entry === "object" && entry !== null && typeof (entry as { type?: unknown }).type === "string" ? [entry as RawEntry] : [];
		} catch {
			return [];
		}
	});
}

/**
 * The entries of several lists of one session family, in list order, each entry id once: the first list's copy stands.
 * An entry without an id is kept as it is. Only merge lists that belong together (one session, or a session and its
 * forks): independent sessions can reuse a short entry id.
 */
export function mergeEntries(lists: readonly (readonly RawEntry[])[]): RawEntry[] {
	const seen = new Set<string>();
	const merged: RawEntry[] = [];
	for (const list of lists) {
		for (const entry of list) {
			const id = (entry as { id?: unknown }).id;
			if (typeof id === "string") {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			merged.push(entry);
		}
	}
	return merged;
}
