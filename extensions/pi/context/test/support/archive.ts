import { openArchive } from "../../src/core/archive.ts";
import type { ArchiveItem, ArchivedCompaction, ArchiveReader, ArchiveStatus, LogEntry } from "../../src/core/types.ts";

/** The entries as archive items; every entry has left the model's context unless `status` says otherwise. */
export function entryItems(entries: readonly LogEntry[], status: Record<string, ArchiveStatus> = {}): ArchiveItem[] {
	return entries.map((entry) => ({ kind: "entry", entry: { ...entry, status: status[entry.id] ?? "archived" } }));
}

export function compactionItem(
	id: string,
	owner: "own" | "foreign",
	summary: string,
	covers?: ArchivedCompaction["covers"],
	buildsOn?: string,
): ArchiveItem {
	return { kind: "compaction", compaction: { id, owner, timestamp: Date.UTC(2026, 9, 9, 13, 0, 0), summary, covers, buildsOn } };
}

export const archiveOf = (entries: readonly LogEntry[], status: Record<string, ArchiveStatus> = {}): ArchiveReader =>
	openArchive(entryItems(entries, status));

/** Whether the text holds a surrogate that is not half of a pair. */
export const hasLoneSurrogate = (text: string): boolean =>
	/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
