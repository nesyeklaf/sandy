/**
 * Measured model usage per Track lease (Track drivers v2, sandy/work/track/docs/design-v2.md §8). Read-only: it never
 * authorizes a transition. Source: pi's session entries (the active branch). Whoever drives a lease appends a lease
 * marker (customType LEASE_MARKER, data { ticket }) when it starts acting for the lease: the track-guard when it
 * captures the agent's ticket, the autopilot runner right after its claim. Every entry after a marker, until the next
 * marker, belongs to that marker's lease: assistant messages, tool results that report nested model work (subagents)
 * and usage entries. Missing usage on an assistant message is unknown (null), never zero.
 * An end marker (data { ticket: null }) ends the attribution: the track-guard appends it once it reported a lease's
 * usage after the lease closed, so later entries belong to no lease until the next marker.
 */

export const LEASE_MARKER = "track-lease";
/**
 * Record (customType LEASE_METERED, data { ticket }) that the track-guard reported an ended lease whose attribution a
 * newer marker already follows. It changes no attribution; an end marker is only appended when the newest marker ended.
 */
export const LEASE_METERED = "track-lease-metered";

/** Same shape as sandy/work/track/run.ts LeaseUsage (the CLI and tool argument). */
export type LeaseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; messages: number };

type UsageLike = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };

/** One session entry as pi persists it (SessionManager entries); only the fields read here. */
export type SessionEntryLike = {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; usage?: UsageLike };
	/** type "usage": model work outside the conversation (e.g. cache warming). */
	usage?: UsageLike;
};

/** undefined: not a marker; null: an end marker; string: the ticket a marker starts attribution for. */
const markerTicket = (entry: SessionEntryLike): string | null | undefined => {
	if (entry.type !== "custom" || entry.customType !== LEASE_MARKER) return undefined;
	const data = entry.data as { ticket?: unknown } | undefined;
	if (typeof data?.ticket === "string") return data.ticket;
	return data?.ticket === null ? null : undefined;
};

/** The ticket of the last lease marker, i.e. the lease the session acts for now; null without one or after an end marker. */
export function latestMarker(entries: readonly SessionEntryLike[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const ticket = markerTicket(entries[i]);
		if (ticket !== undefined) return ticket;
	}
	return null;
}

/**
 * The tickets of the session's markers whose usage was not reported yet, oldest first: a ticket is reported once an end
 * marker follows its attribution segment or a LEASE_METERED record names it. Read from the entries, so it survives a restart.
 */
export function unreportedTickets(entries: readonly SessionEntryLike[]): string[] {
	const pending = new Set<string>();
	let current: string | null = null;
	for (const entry of entries) {
		const next = markerTicket(entry);
		if (next === undefined) {
			const reported = (entry.data as { ticket?: unknown } | undefined)?.ticket;
			if (entry.type === "custom" && entry.customType === LEASE_METERED && typeof reported === "string") pending.delete(reported);
			continue;
		}
		if (next === null && current !== null) pending.delete(current);
		if (next !== null) pending.add(next);
		current = next;
	}
	return [...pending];
}

/** Usage of the lease the ticket names; null when the session has no marker for it or a message's usage is missing. */
export function usageForTicket(entries: readonly SessionEntryLike[], ticket: string): LeaseUsage | null {
	const sum: LeaseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 };
	const add = (usage: UsageLike) => {
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		sum.input += input;
		sum.output += output;
		sum.cacheRead += cacheRead;
		sum.cacheWrite += cacheWrite;
		sum.total += usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	};
	let marked = false;
	let current: string | null = null;
	for (const entry of entries) {
		const next = markerTicket(entry);
		if (next !== undefined) {
			current = next;
			marked ||= next === ticket;
			continue;
		}
		if (current !== ticket) continue;
		if (entry.type === "usage" && entry.usage) add(entry.usage);
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "assistant") {
			if (!entry.message.usage) return null;
			add(entry.message.usage);
			sum.messages++;
		} else if (entry.message.role === "toolResult" && entry.message.usage) add(entry.message.usage);
	}
	return marked ? sum : null;
}
