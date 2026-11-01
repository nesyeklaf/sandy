import type { Usage } from "./types.ts";

export interface Stats extends Usage {
	calls: number;
	failures: number;
	resets: number;
	toolCalls: number;
	/** Share of prompt tokens served from cache over all calls. */
	hitRate: number;
}

export const emptyStats = (): Stats => ({ calls: 0, failures: 0, resets: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hitRate: 0 });

export function addUsage(s: Stats, u: Usage): void {
	s.input += u.input;
	s.output += u.output;
	s.cacheRead += u.cacheRead;
	s.cacheWrite += u.cacheWrite;
	const prompt = s.input + s.cacheRead + s.cacheWrite;
	s.hitRate = prompt === 0 ? 0 : s.cacheRead / prompt;
}

/** The advisor's conversation. One implementation is a bare model call, the other a full pi agent session with read-only tools. */
export interface Asker {
	/** Returns the reply text, or undefined when the call failed or was aborted. The caller re-sends the same delta then. */
	ask(userText: string, signal?: AbortSignal): Promise<string | undefined>;
	reset(): void;
	readonly stats: Stats;
	/** Messages held in the conversation (0 while empty). */
	readonly size: number;
	dispose?(): void;
	/** Build the conversation ahead of the first call so the gate does not pay for it. Never throws. */
	warm?(): Promise<void>;
}
