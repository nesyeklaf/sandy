import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadoutProblem, parseStagePolicy, readStagePolicy, type StagePolicy } from "./policy.ts";
import { installSession } from "./session.ts";

const policy = (over: Partial<StagePolicy> = {}): StagePolicy => ({
	active: true,
	running: true,
	stage: "build",
	allow: { skills: ["understand"], denyTools: ["bash"] },
	driver: { kind: "agent" },
	...over,
});

test("the policy file per SANDY_THREAD_ID gives the stage and its driver; old files and no thread are handled", () => {
	const dir = mkdtempSync(join(tmpdir(), "track-policy-"));
	mkdirSync(join(dir, "threads"));
	const file = join(dir, "threads", "thr_1.json");
	writeFileSync(file, JSON.stringify({ version: 1, threadId: "thr_1", active: false, running: true, stage: "build", allow: { skills: ["a"], edits: false }, driver: { kind: "autopilot", name: "track-probe", args: "x" }, runId: "r1", rev: 3, ticket: "r1.4" }));
	const env = { SANDY_THREAD_ID: "thr_1", TRACK_STATE_DIR: dir };
	assert.deepEqual(readStagePolicy(env), { active: false, running: true, stage: "build", allow: { skills: ["a"] }, driver: { kind: "autopilot", name: "track-probe", args: "x" } });
	assert.equal(readStagePolicy({ ...env, SANDY_THREAD_ID: "thr_2" }), null, "no file: no track");
	assert.equal(readStagePolicy({ TRACK_STATE_DIR: dir }), null, "no thread: no track");
	assert.deepEqual(parseStagePolicy(JSON.stringify({ version: 1, active: true, stage: "a", allow: {} })), { active: true, running: true, stage: "a", allow: {}, driver: { kind: "agent" } });
	assert.equal(parseStagePolicy("{"), null);
	assert.equal(parseStagePolicy(JSON.stringify({ version: 2, active: true })), null);
});

test("a step loadout outside the stage names the skills and denied tools; no or inactive track allows anything", () => {
	assert.equal(loadoutProblem(policy(), { skills: ["understand"], tools: ["read"] }), undefined);
	assert.equal(
		loadoutProblem(policy(), { skills: ["understand", "architect"], tools: ["read", "mcp__x__bash"] }),
		'stage "build" does not allow skills architect (allowed: understand) and tools mcp__x__bash (denied in this stage)',
	);
	assert.equal(loadoutProblem(policy({ allow: {} }), { skills: ["any"], tools: ["bash"] }), undefined);
	assert.equal(loadoutProblem(policy({ active: false }), { skills: ["architect"] }), undefined);
	assert.equal(loadoutProblem(null, { skills: ["architect"] }), undefined);
});

test("session.step refuses a loadout outside the stage before it prompts", async () => {
	const prompts: string[] = [];
	const pi = {
		registerTool() {},
		on() {},
		getActiveTools: () => ["read", "bash"],
		getThinkingLevel: () => "low",
		sendUserMessage: (text: string) => prompts.push(text),
	};
	const session = installSession(pi, () => policy())({ waitForIdle: async () => {}, isIdle: () => true });
	await assert.rejects(session.step({ say: "go", skills: ["architect"] }), /session\.step refused: stage "build" does not allow skills architect/);
	await assert.rejects(session.step({ say: "go", tools: ["bash"] }), /tools bash \(denied in this stage\)/);
	assert.deepEqual(prompts, []);
});

test("session.step checks the tools the turn really gets: the inherited ones without a tools list; autopilot_submit always fits", async () => {
	const prompts: string[] = [];
	const handlers = new Map<string, (event: any) => unknown>();
	const pi = {
		registerTool() {},
		on: (name: string, handler: (event: any) => unknown) => handlers.set(name, handler),
		getActiveTools: () => ["read", "bash", "autopilot_submit"],
		setActiveTools() {},
		getThinkingLevel: () => "low",
		setThinkingLevel() {},
		events: { emit() {} },
		sendUserMessage: (text: string) => {
			prompts.push(text);
			queueMicrotask(() => handlers.get("agent_end")!({ messages: [{ role: "assistant", content: '"done"' }] }));
		},
	};
	const ctx = { waitForIdle: async () => {}, isIdle: () => true };
	const inherits = installSession(pi, () => policy())(ctx);
	await assert.rejects(inherits.step({ say: "go" }), /session\.step refused: stage "build" does not allow tools bash \(denied in this stage\)/);
	assert.deepEqual(prompts, []);
	const deniesSubmit = installSession(pi, () => policy({ allow: { denyTools: ["autopilot_submit", "bash"] } }))(ctx);
	const step = await deniesSubmit.step({ say: "go", tools: ["read"], schema: { type: "string" } });
	assert.equal(step.value, "done", "a step whose only extra tool is autopilot_submit runs");
	assert.equal(loadoutProblem(policy({ allow: { denyTools: ["autopilot_submit"] } }), { tools: ["autopilot_submit"] }), undefined);
});
