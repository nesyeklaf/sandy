import { describe, expect, it } from "vitest";
import { measureSession, totals } from "../src/core/measure.ts";

const answer = (input: number, cacheRead: number, cacheWrite: number, cost = 0.1) =>
	JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, cacheRead, cacheWrite, cost: { total: cost } } } });
const cut = (reason: string | null) =>
	JSON.stringify({ type: "compaction", summary: reason ? `<sandy-context reason="${reason}">\n…` : "Summary by pi" });

describe("measuring a session log", () => {
	it("counts prompt tokens, cache reads, cost and cuts by reason", () => {
		const m = measureSession([answer(10, 90, 0), cut("watermark"), answer(5, 0, 95), cut(null), "not json", ""]);
		expect(m).toMatchObject({ requests: 2, promptTokens: 200, cacheRead: 90, cuts: { watermark: 1, other: 1 }, taskSpans: [] });
		expect(m.cost).toBeCloseTo(0.2);
	});

	it("splits the prompt tokens into one span per finished task", () => {
		const m = measureSession([answer(100, 0, 0), answer(50, 0, 0), cut("task"), answer(30, 0, 0), cut("task"), answer(7, 0, 0)]);
		expect(m.taskSpans).toEqual([150, 30]);
	});

	it("sums sessions with a cache hit rate", () => {
		const t = totals([measureSession([answer(10, 90, 0)]), measureSession([answer(100, 0, 0), cut("task")])]);
		expect(t).toMatchObject({ sessions: 2, requests: 2, promptTokens: 200, cacheHit: 0.45, promptPerRequest: 100, cuts: { task: 1 }, taskSpans: [100] });
	});
});
