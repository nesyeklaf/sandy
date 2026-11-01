import { describe, expect, it } from "vitest";
import { AdvisorContext, SYSTEM_PROMPT } from "../src/core/advisorContext.ts";
import type { CompleteFn, Reply } from "../src/core/types.ts";

const reply = (text: string, cacheRead = 0): Reply => ({ content: [{ type: "text", text }], usage: { input: 100, output: 10, cacheRead, cacheWrite: 0 }, stopReason: "stop" });

function make(fn: CompleteFn, budget = 100000) {
	return new AdvisorContext({ complete: fn, sessionId: "advisor:s", retention: "long", budgetTokens: budget, maxOutputTokens: 100 });
}

describe("AdvisorContext", () => {
	it("is append-only: every call sends the previous prefix unchanged", async () => {
		const seen: string[][] = [];
		const c = make(async (ctx) => {
			seen.push(ctx.messages.map((m) => JSON.stringify(m)));
			expect(ctx.systemPrompt).toBe(SYSTEM_PROMPT);
			return reply("{}");
		});
		await c.ask("a");
		await c.ask("b");
		await c.ask("c");
		expect(seen[1]?.slice(0, seen[0]!.length + 1)).toEqual([...seen[0]!, seen[1]![seen[0]!.length]]);
		expect(seen[2]?.slice(0, seen[1]!.length)).toEqual(seen[1]);
	});
	it("passes a stable session id and retention", async () => {
		const ids = new Set<string>();
		const c = make(async (_c, o) => (ids.add(`${o.sessionId}|${o.cacheRetention}`), reply("{}")));
		await c.ask("a");
		await c.ask("b");
		expect([...ids]).toEqual(["advisor:s|long"]);
	});
	it("removes the user message again when a call fails, so a retry resends the same delta", async () => {
		let n = 0;
		const sizes: number[] = [];
		const c = make(async (ctx) => {
			sizes.push(ctx.messages.length);
			if (n++ === 0) throw new Error("boom");
			return reply("ok");
		});
		expect(await c.ask("a")).toBeUndefined();
		expect(c.size).toBe(0);
		expect(await c.ask("a")).toBe("ok");
		expect(sizes).toEqual([1, 1]);
		expect(c.stats.failures).toBe(1);
	});
	it("treats an error stop reason as failure", async () => {
		const c = make(async () => ({ ...reply(""), stopReason: "error" }));
		expect(await c.ask("a")).toBeUndefined();
		expect(c.size).toBe(0);
	});
	it("tracks the cache hit rate", async () => {
		const c = make(async () => reply("x", 300));
		await c.ask("a");
		expect(c.stats.hitRate).toBeCloseTo(300 / 400);
	});
	it("resets once at the budget and counts it", async () => {
		const c = make(async () => ({ ...reply("x"), usage: { input: 900, output: 1, cacheRead: 0, cacheWrite: 0 } }), 500);
		await c.ask("a");
		await c.ask("b");
		expect(c.stats.resets).toBe(1);
		expect(c.size).toBe(2);
	});
});
