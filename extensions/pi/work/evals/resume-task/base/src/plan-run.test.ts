import assert from "node:assert/strict";
import { test } from "node:test";
import planRun from "./plan-run.ts";

/** A session that answers each step from a script and records the list the autopilot wrote before it. */
function fake(answers: unknown[], checks: { code: number; killed?: boolean }[]) {
	const lists: { id: string; status: string; subject: string }[][] = [];
	const steps: { say: string; deny?: string[]; listBefore: string }[] = [];
	const execs: string[] = [];
	const show = () => (lists.at(-1) ?? []).map((t) => `${t.id}:${t.status}`).join(" ");
	const pi = { appendEntry: (type: string, data: any) => void (type === "work-tasks" && lists.push(structuredClone(data.tasks))) };
	const session = {
		step: async (options: any) => {
			steps.push({ say: options.say, deny: options.deny, listBefore: show() });
			return { text: "", value: answers.shift(), tools: [], model: "m", thinking: "low" };
		},
		exec: async (_command: string, args: string[]) => {
			execs.push(args.at(-1)!);
			return { stdout: "out", stderr: "", killed: false, ...checks.shift()! };
		},
		ask: async () => undefined,
		choose: async () => "",
	};
	return { api: { pi, session: session as any }, lists, steps, execs, show };
}
const PLAN = { steps: [{ subject: "Write code", activeForm: "Writing code" }, { subject: "Write tests", activeForm: "Writing tests" }], check: "npm test" };
const done = { status: "done", note: "ok" };

test("the planning task shows before the first prompt; each step is in_progress while it runs; the check runs by code", async () => {
	const f = fake([PLAN, done, done], [{ code: 0 }]);
	const result = await planRun("do it", f.api);
	assert.equal(f.steps[0].listBefore, "1:in_progress", "the banner has a Now line from the first second");
	assert.equal(f.steps[1].listBefore, "1:completed 2:in_progress 3:pending 4:pending");
	assert.equal(f.steps[2].listBefore, "1:completed 2:completed 3:in_progress 4:pending");
	assert.deepEqual(f.execs, ["npm test"]);
	assert.equal(f.show(), "1:completed 2:completed 3:completed 4:completed");
	assert.equal(f.lists.at(-1)!.at(-1)!.subject, "Run npm test");
	assert.deepEqual(result, { steps: ["Write code", "Write tests"], check: "npm test", passed: true });
	for (const step of f.steps) assert.deepEqual(step.deny, ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"], "the autopilot owns the list");
});

test("a blocked step stays in_progress and stops the run", async () => {
	const f = fake([PLAN, { status: "blocked", note: "no access" }], []);
	const result = await planRun("do it", f.api);
	assert.equal(f.show(), "1:completed 2:in_progress 3:pending 4:pending");
	assert.equal(f.steps.length, 2);
	assert.deepEqual(f.execs, []);
	assert.equal((result as any).blocked, "Write code");
});

test("a red check gets a fix step with the output tail, then runs again; still red after the fixes leaves the check open", async () => {
	const green = fake([PLAN, done, done, done], [{ code: 1 }, { code: 0 }]);
	await planRun("do it", green.api);
	assert.match(green.steps[3].say, /npm test` exited 1\. Output tail:\nout/);
	assert.equal(green.show(), "1:completed 2:completed 3:completed 4:completed");
	const red = fake([PLAN, done, done, done, done], [{ code: 1 }, { code: 1 }, { code: 1 }]);
	const result = await planRun("do it", red.api);
	assert.equal(red.execs.length, 3, "one run and two fixes");
	assert.equal(red.show(), "1:completed 2:completed 3:completed 4:in_progress");
	assert.equal((result as any).failed, "npm test");
});

test("a check killed by the timeout counts as red, though pi reports code 0", async () => {
	const f = fake([PLAN, done, done, done, done], [{ code: 0, killed: true }, { code: 0, killed: true }, { code: 0, killed: true }]);
	const result = await planRun("do it", f.api);
	assert.match(f.steps[3].say, /timed out/);
	assert.equal((result as any).killed, true);
});
