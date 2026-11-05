/**
 * The record of a retrieval call made inside another tool, stored under `RETRIEVAL_KIND`. Ids and paths only: the log
 * is the record and a record holds no content.
 */
export interface RetrievalRecord {
	/** The nested call's id, `<parent id>/<n>`. */
	readonly call: string;
	readonly parent: string;
	readonly tool: "history_search" | "history_read" | "read";
	/** The entries a search found, or the entry a read read. */
	readonly ids?: readonly string[];
	/** The file a `read` read. */
	readonly path?: string;
	/** The read failed: an attempt, not a read. */
	readonly failed?: boolean;
}

const TOOLS_RECORDED: readonly unknown[] = ["history_search", "history_read", "read"];

export function readRetrievalRecord(value: unknown): RetrievalRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.call !== "string" || typeof record.parent !== "string" || !TOOLS_RECORDED.includes(record.tool)) return undefined;
	const ids = Array.isArray(record.ids) && record.ids.every((id) => typeof id === "string") ? (record.ids as string[]) : undefined;
	return {
		call: record.call,
		parent: record.parent,
		tool: record.tool as RetrievalRecord["tool"],
		...(ids ? { ids } : {}),
		...(typeof record.path === "string" ? { path: record.path } : {}),
		...(record.failed === true ? { failed: true } : {}),
	};
}
