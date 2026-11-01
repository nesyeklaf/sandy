/**
 * What a session cost, read from its pi session log: the numbers that tell whether cutting per task
 * saves tokens. Pure: the caller reads the files.
 */

export interface SessionMeasure {
	requests: number;
	/** Every token sent as prompt: uncached input, cache reads and cache writes. */
	promptTokens: number;
	cacheRead: number;
	cost: number;
	/** Cuts by the reason in their summary head (watermark, cold, task, …); foreign compactions count as "other". */
	cuts: Record<string, number>;
	/** Prompt tokens spent between two task cuts, one entry per finished task. Empty until a task cut happens. */
	taskSpans: number[];
}

interface Usage {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export function measureSession(lines: readonly string[]): SessionMeasure {
	const m: SessionMeasure = { requests: 0, promptTokens: 0, cacheRead: 0, cost: 0, cuts: {}, taskSpans: [] };
	let sinceTaskCut = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let entry: { type?: string; summary?: string; message?: { role?: string; usage?: Usage } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "compaction") {
			const reason = /^<sandy-context reason="([a-z-]+)"/.exec(entry.summary ?? "")?.[1] ?? "other";
			m.cuts[reason] = (m.cuts[reason] ?? 0) + 1;
			if (reason === "task") {
				m.taskSpans.push(sinceTaskCut);
				sinceTaskCut = 0;
			}
			continue;
		}
		const usage = entry.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;
		if (!usage) continue;
		const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		m.requests++;
		m.promptTokens += prompt;
		m.cacheRead += usage.cacheRead ?? 0;
		m.cost += usage.cost?.total ?? 0;
		sinceTaskCut += prompt;
	}
	return m;
}

/** Sums sessions; cache hit is cache reads over prompt tokens. */
export function totals(sessions: readonly SessionMeasure[]) {
	const t = { sessions: sessions.length, requests: 0, promptTokens: 0, cacheRead: 0, cost: 0, cuts: {} as Record<string, number>, taskSpans: [] as number[] };
	for (const s of sessions) {
		t.requests += s.requests;
		t.promptTokens += s.promptTokens;
		t.cacheRead += s.cacheRead;
		t.cost += s.cost;
		for (const [k, v] of Object.entries(s.cuts)) t.cuts[k] = (t.cuts[k] ?? 0) + v;
		t.taskSpans.push(...s.taskSpans);
	}
	return { ...t, cacheHit: t.promptTokens === 0 ? 0 : t.cacheRead / t.promptTokens, promptPerRequest: t.requests === 0 ? 0 : t.promptTokens / t.requests };
}
