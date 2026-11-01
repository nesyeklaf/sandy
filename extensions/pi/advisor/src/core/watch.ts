import type { OwnerNote, SessionState } from "./proposals.ts";

export interface StateChanges {
	/** Keys of tasks of the same intent that left the open list since the last update. */
	closed: string[];
	/** Owner notes newer than any seen before. */
	notes: OwnerNote[];
}

/** The owner's new notes as one message for the session's next turn. They add to the current task; they do not replace it. */
export function notesMessage(notes: readonly OwnerNote[]): string {
	return [
		"Neue Notizen des Owners zu deinem Intent. Bezieh sie in den aktuellen Task ein oder lege dafür einen Task an; brich die laufende Arbeit dafür nicht ab.",
		...notes.map((n) => `- ${n.text}`),
	].join("\n");
}

/** The open tasks a session last saw, kept in the session log so a restarted process still knows them. */
export interface WatchSnapshot {
	intent: string | null;
	open: string[];
}

/**
 * What changed in a session's ideas state between two reads. The first read is the baseline:
 * the session started knowing its open tasks and notes (the plugin briefs it), so nothing is new yet.
 * A process restarted between turns (SANDY starts pi per message) restores the open tasks it saw last,
 * so a task closed meanwhile still ends a piece of work; notes stay a baseline, the briefing carries them.
 */
export class StateWatch {
	private seen: { intent: string | null; open: Set<string>; notesAt: number } | undefined;
	private restored: WatchSnapshot | undefined;

	restore(snapshot: WatchSnapshot): void {
		this.restored = snapshot;
	}

	snapshot(): WatchSnapshot | undefined {
		return this.seen && { intent: this.seen.intent, open: [...this.seen.open].sort() };
	}

	update(s: SessionState): StateChanges {
		const intent = s.intent?.id ?? null;
		const open = new Set(s.tasks.map((t) => t.key));
		const notesAt = Math.max(this.seen?.notesAt ?? Number.NEGATIVE_INFINITY, ...s.notes.map((n) => n.at));
		const prev = this.seen ?? (this.restored && { intent: this.restored.intent, open: new Set(this.restored.open), notesAt });
		this.restored = undefined;
		this.seen = { intent, open, notesAt };
		if (!prev) return { closed: [], notes: [] };
		// Another intent is a new assignment, not a finished task.
		const closed = prev.intent === intent ? [...prev.open].filter((k) => !open.has(k)) : [];
		return { closed, notes: s.notes.filter((n) => n.at > prev.notesAt) };
	}
}
