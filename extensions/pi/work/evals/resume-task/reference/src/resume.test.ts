import assert from "node:assert/strict";
import { test } from "node:test";
import autopilot from "./autopilot.ts";

const PLAN = { steps: [{ subject: "Write code", activeForm: "Writing code" }, { subject: "Write tests", activeForm: "Writing tests" }], check: "npm test" };
const done = { status: "done", note: "ok" };
const hang = Symbol("hang");

/** One pi process over shared session entries; a step answered with hang stands for the reload. */
function pi(entries: any[], answers: unknown[]) {
	const commands: Record<string, any> = {};
	const messages: string[] = [];
	const says: string[] = [];
	autopilot(
		{
			registerCommand: (name: string, options: any) => void (commands[name] = options),
			appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data: structuredClone(data) }),
			sendMessage: (message: { content: string }) => void messages.push(message.content),
		},
		() => ({
			step: async (options: any) => {
				says.push(options.say);
				const answer = answers.shift();
				return answer === hang ? new Promise(() => {}) : { text: "", value: answer, tools: [], model: "m", thinking: "low" };
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		}),
	);
	const ctx = { cwd: ".", sessionManager: { getBranch: () => entries } };
	return { run: (input: string) => commands.autopilot.handler(input, ctx), messages, says };
}
const tasks = (entries: any[]) => entries.filter((e) => e.customType === "work-tasks").at(-1).data.tasks.map((t: any) => t.id + ":" + t.status).join(" ");
const tick = () => new Promise((r) => setTimeout(r, 10));

test("resume after a reload skips the completed step and runs the interrupted one again", async () => {
	const entries: any[] = [];
	void pi(entries, [PLAN, done, hang]).run("plan-run do it");
	await tick();
	assert.equal(tasks(entries), "1:completed 2:completed 3:in_progress 4:pending");
	const after = pi(entries, [done]);
	await after.run("resume");
	assert.equal(after.says.length, 1);
	assert.match(after.says[0], /^Step 2 of 2: Write tests\. It was interrupted before/);
	assert.equal(tasks(entries), "1:completed 2:completed 3:completed 4:completed");
	assert.match(after.messages[0], /"passed":true/);
});

test("a reload during planning plans again; a blocked run resumes from its step", async () => {
	const entries: any[] = [];
	void pi(entries, [hang]).run("plan-run do it");
	await tick();
	const after = pi(entries, [PLAN, { status: "blocked", note: "no access" }]);
	await after.run("resume");
	assert.match(after.says[0], /The task:\ndo it/);
	assert.equal(tasks(entries), "1:completed 2:in_progress 3:pending 4:pending");
	const again = pi(entries, [done, done]);
	await again.run("resume");
	assert.deepEqual(again.says.map((s) => s.slice(0, 22)), ["Step 1 of 2: Write cod", "Step 2 of 2: Write tes"]);
	assert.equal(tasks(entries), "1:completed 2:completed 3:completed 4:completed");
});

test("nothing to resume, a finished run, or a run still going: no step, a message why", async () => {
	const empty = pi([], [PLAN]);
	await empty.run("resume");
	assert.deepEqual(empty.says, []);
	assert.match(empty.messages[0], /no plan-run in this session/);
	const entries: any[] = [];
	await pi(entries, [PLAN, done, done]).run("plan-run do it");
	const later = pi(entries, [done]);
	await later.run("resume");
	assert.deepEqual(later.says, []);
	assert.match(later.messages[0], /the last plan-run passed/);
	const busy = pi([], [PLAN, hang]);
	void busy.run("plan-run do it");
	await tick();
	await busy.run("resume");
	assert.equal(busy.says.length, 2);
	assert.match(busy.messages[0], /still running in this pi/);
});
