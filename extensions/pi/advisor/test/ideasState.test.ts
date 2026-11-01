import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/core/config.ts";
import { Advisor, type Entry } from "../src/core/runtime.ts";
import { commandFor, keyOf, parseState, renderState } from "../src/core/proposals.ts";
import { parseReview } from "../src/core/verdict.ts";
import { changeWork } from "../src/core/rules.ts";
import type { CompleteFn, Reply } from "../src/core/types.ts";

const reply = (text: string): Reply => ({ content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
const user = (id: string, t: string): Entry => ({ id, message: { role: "user", content: t } });
const long = "Ich habe alles gebaut. Alle Tests sind grün und der Build ist sauber. " + "x".repeat(200);

const withIntent = JSON.stringify({ thread: "thr_1", intent: { id: "intent_9", title: "Karte zoombar", state: "proposed", doneWhen: "command passes: npm test" }, idea: { id: "idea_2", title: "Karte" }, tasks: [{ key: "IDEA-4", title: "Pinch", status: "todo" }] });
const without = JSON.stringify({ thread: "thr_1", intent: null, idea: null, tasks: [] });

describe("session state", () => {
	it("parses what sandy ideas thread prints and ignores anything else", () => {
		expect(parseState(withIntent)?.intent?.id).toBe("intent_9");
		expect(parseState("idea_1")).toBeUndefined();
		expect(parseState("")).toBeUndefined();
	});
	it("renders the intent, its outcome and open tasks, or says there is none", () => {
		const t = renderState(parseState(withIntent)!);
		expect(t).toContain("intent_9");
		expect(t).toContain("command passes: npm test");
		expect(t).toContain("IDEA-4");
		expect(renderState(parseState(without)!)).toContain("keinen Intent");
	});
});

describe("proposal kinds task and fulfil", () => {
	it("parses task and fulfil proposals", () => {
		const r = parseReview('{"proposals":[{"kind":"task","title":"Pinch","description":"d"},{"kind":"fulfil","evidence":"npm test: 51 pass"},{"kind":"fulfil"}]}');
		expect(r?.proposals.map((p) => p.kind)).toEqual(["task", "fulfil"]);
	});
	it("files a task under the session's intent, in the configured project", () => {
		expect(commandFor({ kind: "task", title: "Pinch", description: "D" }, "thr_1", { intentId: "intent_9", project: "IDEA" })).toEqual(["ideas", "task-add", "Pinch", "--project", "IDEA", "--description", "D", "--intent", "intent_9"]);
	});
	it("skips a task or a fulfilment when no intent is known", () => {
		expect(commandFor({ kind: "task", title: "T", description: "D" }, "thr_1", { project: "IDEA" })).toBeUndefined();
		expect(commandFor({ kind: "fulfil", title: "", description: "", evidence: "e" }, "thr_1", { project: "IDEA" })).toBeUndefined();
	});
	it("closes an intent only with evidence", () => {
		expect(commandFor({ kind: "fulfil", title: "", description: "", evidence: "npm test green" }, "thr_1", { intentId: "intent_9", project: "IDEA" })).toEqual(["ideas", "fulfil", "intent_9", "--evidence", "npm test green"]);
		expect(commandFor({ kind: "fulfil", title: "", description: "" }, "thr_1", { intentId: "intent_9", project: "IDEA" })).toBeUndefined();
	});
	it("does not file a second intent when the session has one", () => {
		expect(commandFor({ kind: "intent", title: "T", description: "D" }, "thr_1", { intentId: "intent_9", project: "IDEA" })).toBeUndefined();
	});
	it("keys differ per kind", () => {
		expect(keyOf({ kind: "task", title: "Pinch", description: "" })).toBe("task:pinch");
		expect(keyOf({ kind: "fulfil", title: "", description: "", intent: "intent_9" })).toBe("fulfil:intent_9");
	});
});

describe("change work and the fixed rules", () => {
	const call = (name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: args }] });
	it("sees an edit or write as change work, a read as none", () => {
		expect(changeWork([call("edit", { path: "a.ts" })])).toBe(true);
		expect(changeWork([call("bash", { command: "git commit -m x" })])).toBe(true);
		expect(changeWork([call("read", { path: "a.ts" })])).toBe(false);
		expect(changeWork([call("bash", { command: "ls -la" })])).toBe(false);
		expect(changeWork([{ role: "user", content: "edit a.ts" }])).toBe(false);
	});
	it("an intent proposal may carry its first task", () => {
		const r = parseReview('{"proposals":[{"kind":"intent","title":"Neu","description":"d","task":"Erster Schritt","outcome":{"command":"npm test"}}]}');
		expect(r?.proposals[0]?.task).toBe("Erster Schritt");
		const p = r!.proposals[0]!;
		expect(commandFor(p, "thr_1", { project: "IDEA" })).toContain("--task");
		expect(commandFor({ ...p, task: undefined } as typeof p, "thr_1", { project: "IDEA" })).not.toContain("--task");
	});
});

describe("Advisor with the ideas state", () => {
	function setup(complete: CompleteFn, state: string, entries: Entry[]) {
		const execs: string[][] = [];
		const a = new Advisor({
			config: DEFAULTS,
			complete,
			exec: async (_c, args) => (execs.push(args), args[1] === "thread" ? { code: 0, stdout: state, stderr: "" } : { code: 0, stdout: "ok", stderr: "" }),
			sandy: "sandy",
			sessionId: "s",
			threadId: "thr_1",
			entries: () => entries,
		});
		return { a, execs };
	}
	const lastPrompt = (prompts: string[]) => prompts.at(-1) ?? "";

	it("puts the state at the end of the update and sends it again only when it changed", async () => {
		const prompts: string[] = [];
		const entries = [user("1", "bau das")];
		const { a } = setup(async (ctx) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}")), withIntent, entries);
		await a.gateFinal(long);
		expect(lastPrompt(prompts)).toContain("intent_9");
		expect(lastPrompt(prompts).indexOf("intent_9")).toBeGreaterThan(lastPrompt(prompts).indexOf("bau das"));
		entries.push(user("2", "und weiter"));
		await a.gateFinal(long);
		expect(lastPrompt(prompts)).toContain("und weiter");
		expect(lastPrompt(prompts)).not.toContain("intent_9");
	});
	it("files a task under the intent the state names", async () => {
		const p = '{"proposals":[{"kind":"task","title":"Pinch","description":"d"}]}';
		const { a, execs } = setup(async () => reply(p), withIntent, [user("1", "x")]);
		await a.gateFinal(long);
		const add = execs.find((e) => e[1] === "task-add");
		expect(add).toContain("intent_9");
	});
	it("does not file an intent for a session that has one", async () => {
		const p = '{"proposals":[{"kind":"intent","title":"Neu","description":"d","outcome":{"command":"npm test"}}]}';
		const { a, execs } = setup(async () => reply(p), withIntent, [user("1", "x")]);
		await a.gateFinal(long);
		expect(execs.some((e) => e[1] === "propose-intent")).toBe(false);
	});
	it("files an intent for a session without one", async () => {
		const p = '{"proposals":[{"kind":"intent","title":"Neu","description":"d","outcome":{"command":"npm test"}}]}';
		const { a, execs } = setup(async () => reply(p), without, [user("1", "x")]);
		await a.gateFinal(long);
		expect(execs.some((e) => e[1] === "propose-intent")).toBe(true);
	});
	it("warns when change work runs without an intent, naming the missing intent and first task", async () => {
		const prompts: string[] = [];
		const entries: Entry[] = [user("1", "bau das"), { id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }] } }];
		const { a } = setup(async (ctx) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}")), without, entries);
		await a.gateFinal(long);
		expect(lastPrompt(prompts)).toContain("MAHNUNG");
		expect(lastPrompt(prompts)).toMatch(/Intent[^\n]*erste[nm]? Task/);
	});
	it("warns when change work runs under an intent without an open task", async () => {
		const prompts: string[] = [];
		const noTasks = JSON.stringify({ ...JSON.parse(withIntent), tasks: [] });
		const entries: Entry[] = [user("1", "bau das"), { id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts" } }] } }];
		const { a } = setup(async (ctx) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}")), noTasks, entries);
		await a.gateFinal(long);
		expect(lastPrompt(prompts)).toContain("MAHNUNG");
		expect(lastPrompt(prompts)).toContain("offenen Task");
	});
	it("does not warn without change work, or when intent and task exist", async () => {
		const prompts: string[] = [];
		const edit: Entry = { id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }] } };
		const capture = async (ctx: { messages: unknown[] }) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}"));
		await setup(capture, without, [user("1", "nur eine Frage")]).a.gateFinal(long);
		await setup(capture, withIntent, [user("1", "bau das"), edit]).a.gateFinal(long);
		expect(prompts.join("\n")).not.toContain("MAHNUNG");
	});

	it("ends a review with a goal check against the intent's outcome, and none without an intent", async () => {
		const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, everyTurns: 1 } };
		const run = async (state: string) => {
			const prompts: string[] = [];
			const entries: Entry[] = [user("1", "bau das"), { id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }] } }];
			const a = new Advisor({ config: cfg, complete: async (ctx) => (prompts.push(String((ctx.messages.at(-1) as { content: string }).content)), reply("{}")), exec: async (_c, args) => (args[1] === "thread" ? { code: 0, stdout: state, stderr: "" } : { code: 0, stdout: "ok", stderr: "" }), sandy: "sandy", sessionId: "s", threadId: "thr_1", entries: () => entries });
			await a.reviewTurn();
			return prompts.at(-1) ?? "";
		};
		const withGoal = await run(withIntent);
		expect(withGoal).toContain("ZIELPRÜFUNG");
		expect(withGoal).toContain("command passes: npm test");
		expect(withGoal).toMatch(/fulfil/);
		expect(await run(without)).not.toContain("ZIELPRÜFUNG");
	});

	it("carries on when the state cannot be read", async () => {
		const { a } = setup(async () => reply("{}"), "garbage", [user("1", "x")]);
		await expect(a.gateFinal(long)).resolves.toBeDefined();
	});
});
