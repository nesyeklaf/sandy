import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/core/config.ts";
import { Advisor, type Entry } from "../src/core/runtime.ts";
import { commandFor, keyOf } from "../src/core/proposals.ts";
import type { CompleteFn, Msg, Reply } from "../src/core/types.ts";

const reply = (text: string): Reply => ({ content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
const user = (id: string, t: string): Entry => ({ id, message: { role: "user", content: t } });
const text = (id: string, t: string): Entry => ({ id, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: t }] } });
const tool = (id: string): Entry => ({ id, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c" + id, name: "bash", arguments: { cmd: "ls" } }] } });

function setup(complete: CompleteFn, entries: Entry[], cfg = DEFAULTS) {
	const execs: string[][] = [];
	const a = new Advisor({ config: cfg, complete, exec: async (_c, args) => (execs.push(args), { code: 0, stdout: "idea_1", stderr: "" }), sandy: "sandy", sessionId: "s", threadId: "thr_1", entries: () => entries });
	return { a, execs };
}
const long = "Ich habe alles gebaut. Alle Tests sind grün und der Build ist sauber. " + "x".repeat(200);

describe("Advisor.gateFinal", () => {
	it("does not call the model when no rule hits", async () => {
		let calls = 0;
		const { a } = setup(async () => (calls++, reply("{}")), [user("1", "bau")]);
		const r = await a.gateFinal("Fertig, siehe Diff.");
		expect(calls).toBe(0);
		expect(r.outcome).toBe("released");
	});
	it("sends the delta once; the next call only sends what is new", async () => {
		const prompts: string[] = [];
		const entries = [user("1", "bau das")];
		const { a } = setup(async (ctx) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}")), entries);
		await a.gateFinal(long);
		entries.push(user("2", "und jetzt zweites"));
		await a.gateFinal(long);
		expect(prompts[0]).toContain("bau das");
		expect(prompts[1]).not.toContain("bau das");
		expect(prompts[1]).toContain("zweites");
	});
	it("keeps the cursor when the call fails, so the delta is resent", async () => {
		let n = 0;
		const prompts: string[] = [];
		const { a } = setup(async (ctx) => {
			prompts.push(String((ctx.messages.at(-1) as { content: string }).content));
			if (n++ === 0) throw new Error("x");
			return reply("{}");
		}, [user("1", "bau das")]);
		await a.gateFinal(long);
		await a.gateFinal(long);
		expect(prompts[1]).toContain("bau das");
	});
	it("serialises concurrent calls", async () => {
		let running = 0;
		let max = 0;
		const { a } = setup(async () => {
			max = Math.max(max, ++running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return reply("{}");
		}, [user("1", "x")]);
		await Promise.all([a.gateFinal(long), a.gateFinal(long), a.gateFinal(long)]);
		expect(max).toBe(1);
	});
	it("submits proposals once, dedupes by title", async () => {
		const p = '{"proposals":[{"kind":"idea","title":"Advisor","description":"d"}]}';
		const { a, execs } = setup(async () => reply(p), [user("1", "x")]);
		await a.gateFinal(long);
		await a.gateFinal(long);
		const filed = execs.filter((e) => e[1] !== "thread");
		expect(filed).toHaveLength(1);
		expect(filed[0]).toContain("propose-idea");
		expect(filed[0]).toContain("thr_1");
	});
});

describe("Advisor.reviewTurn", () => {
	const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, everyTurns: 2, immuneTurns: 3, maxNotesPerRun: 1 } };
	const note = reply('{"note":"prüf die Tests"}');
	it("only reviews every N turns", async () => {
		let calls = 0;
		const { a } = setup(async () => (calls++, note), [user("1", "x"), tool("2")], cfg);
		await a.reviewTurn();
		expect(calls).toBe(0);
		await a.reviewTurn();
		expect(calls).toBe(1);
	});
	it("steers with the first note, then holds back (budget per run)", async () => {
		const entries = [user("1", "x"), tool("2")];
		const { a } = setup(async () => note, entries, cfg);
		await a.reviewTurn();
		expect((await a.reviewTurn())?.note).toBe("prüf die Tests");
		entries.push(tool("3"));
		await a.reviewTurn();
		const r = await a.reviewTurn();
		expect(r?.note).toBeUndefined();
	});
	it("can be switched to proposals only", async () => {
		const c = { ...cfg, review: { ...cfg.review, steer: false, everyTurns: 1 } };
		const { a } = setup(async () => note, [user("1", "x")], c);
		expect((await a.reviewTurn())?.note).toBeUndefined();
	});
});

describe("proposals", () => {
	it("builds the sandy ideas command with an outcome for intents", () => {
		expect(commandFor({ kind: "intent", title: "T", description: "D", outcome: { pr: "o/r#3" } }, "thr_1")).toEqual(["ideas", "propose-intent", "T", "--description", "D", "--thread", "thr_1", "--pr", "o/r#3"]);
		expect(commandFor({ kind: "intent", title: "T", description: "D" }, undefined)?.slice(-2)).toEqual(["--decision", "Owner decides whether this is done"]);
	});
	it("normalises keys", () => {
		expect(keyOf({ kind: "idea", title: " Der  Advisor! ", description: "" })).toBe("idea:der advisor");
	});
});

describe("Advisor.isFinal", () => {
	it("is final only for a stopped assistant message without tool calls", () => {
		expect(Advisor.isFinal(text("1", "x").message as Msg)).toBe(true);
		expect(Advisor.isFinal(tool("1").message as Msg)).toBe(false);
		expect(Advisor.isFinal({ role: "user", content: "x" })).toBe(false);
	});
});
