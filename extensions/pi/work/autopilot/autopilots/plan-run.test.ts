import assert from "node:assert/strict";
import { test } from "node:test";
import planRun from "./plan-run.ts";

/** Answered by a step or an exec that never settles: pi stopped (reloaded or restarted) in the middle of it. */
const HANG = Symbol("hang");
type Check = { code: number; killed?: boolean };
type Entry = { type: "custom"; customType: string; data: any };
const TASK_TOOLS = ["tasks", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];

/**
 * One pi instance on a session whose entries (the branch) are shared: a reloaded pi is a new instance on the same entries.
 * Each step is answered from answers and each check from checks (an Error throws, HANG never settles); it records the
 * task list the autopilot wrote before each step.
 */
function pilot(entries: Entry[], answers: unknown[], checks: (Check | typeof HANG)[] = []) {
	const steps: { say: string; deny?: string[]; listBefore: string }[] = [];
	const execs: string[] = [];
	const messages: string[] = [];
	const tasks = () => entries.filter((e) => e.customType === "work-tasks").map((e) => e.data.tasks as { id: string; status: string; subject: string }[]);
	const show = () => (tasks().at(-1) ?? []).map((t) => `${t.id}:${t.status}`).join(" ");
	const pi = {
		appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message: { content: string }) => void messages.push(message.content),
	};
	const session = {
		step: async (options: any) => {
			steps.push({ say: options.say, deny: options.deny, listBefore: show() });
			const answer = await answers.shift();
			if (answer === HANG) return new Promise(() => {});
			if (answer instanceof Error) throw answer;
			return { text: "", value: answer, tools: [], model: "m", thinking: "low" };
		},
		exec: async (_command: string, args: string[]) => {
			execs.push(args.at(-1)!);
			const check = checks.shift()!;
			if (check === HANG) return new Promise(() => {});
			return { stdout: "out", stderr: "", killed: false, ...check };
		},
		ask: async () => undefined,
		choose: async () => "",
	};
	const ctx = { sessionManager: { getBranch: () => entries } };
	return { api: { pi, session: session as any, ctx }, answers, steps, execs, messages, show, get lists() { return tasks(); } };
}
const fake = (answers: unknown[], checks: Check[]) => pilot([], answers, checks);

/** plan-run as a reloaded pi loads it: a fresh import, as /autopilot does on every call. */
let imports = 0;
const fresh = async () => (await import(`./plan-run.ts?fresh=${++imports}`)) as typeof import("./plan-run.ts");
/** Lets a started run go until it reached cond (a step or an exec that hangs). */
async function until(cond: () => boolean) {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(cond(), "the run never got there");
}
const subjects = (f: { lists: { subject: string }[][] }) => f.lists.at(-1)!.map((t) => `${(t as any).id}:${t.subject}`).join(" | ");
const LIST = "1:Plan the work | 2:Write code | 3:Write tests | 4:Run npm test";
const states = (entries: Entry[]) => entries.filter((e) => e.customType === "autopilot-plan-run").map((e) => e.data.phase as string);

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
	for (const step of f.steps) assert.deepEqual(step.deny, TASK_TOOLS, "the autopilot owns the list");
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

// ---- /autopilot resume (docs/resume.md) ----------------------------------------------------------------------------

test("resume after pi stopped mid-step: done steps do not run again, the stopped step runs again from the start", async () => {
	const entries: Entry[] = [];
	const before = pilot(entries, [PLAN, done, HANG]);
	void planRun("do it", before.api);
	await until(() => before.steps.length === 3);

	const after = pilot(entries, [done], [{ code: 0 }]);
	const result = await (await fresh()).resume("", after.api);
	assert.equal(after.steps.length, 1, "no planning, no Write code");
	assert.match(after.steps[0].say, /^Step 2 of 2: Write tests\./);
	assert.equal(after.steps[0].listBefore, "1:completed 2:completed 3:in_progress 4:pending");
	assert.deepEqual(after.execs, ["npm test"]);
	assert.equal(after.show(), "1:completed 2:completed 3:completed 4:completed");
	assert.equal(subjects(after), LIST, "the same ids and subjects");
	for (const step of after.steps) assert.deepEqual(step.deny, TASK_TOOLS, "the resumed run still owns the list");
	assert.deepEqual(result, { steps: ["Write code", "Write tests"], check: "npm test", passed: true });

	const again = pilot(entries, [done], [{ code: 0 }]);
	const nothing = await (await fresh()).resume("", again.api);
	assert.deepEqual([again.steps.length, again.execs.length], [0, 0], "a resumed run that passed is finished");
	assert.equal((nothing as any).resumed, false);
	assert.match(again.messages[0], /no unfinished plan-run/);
});

test("resume after pi stopped during planning plans again with the original task", async () => {
	const entries: Entry[] = [];
	const before = pilot(entries, [HANG]);
	void planRun("the original task", before.api);
	await until(() => before.steps.length === 1);

	const after = pilot(entries, [PLAN, done, done], [{ code: 0 }]);
	const result = await (await fresh()).resume("", after.api);
	assert.match(after.steps[0].say, /^The task:\nthe original task\n/);
	assert.equal(after.steps[0].listBefore, "1:in_progress");
	assert.equal(after.steps.length, 3);
	assert.equal(subjects(after), LIST);
	assert.equal((result as any).passed, true);
});

test("an interrupted check runs again with the fix steps it has left", async () => {
	const entries: Entry[] = [];
	const before = pilot(entries, [PLAN, done, done, done], [{ code: 1 }, HANG]);
	void planRun("do it", before.api);
	await until(() => before.execs.length === 2);
	assert.match(before.steps[3].say, /attempt 1 of 2/);

	const after = pilot(entries, [done, done], [{ code: 1 }, { code: 1 }]);
	const result = await (await fresh()).resume("", after.api);
	assert.deepEqual(after.execs, ["npm test", "npm test"], "the check again, then once after the one fix left");
	assert.equal(after.steps.length, 1);
	assert.match(after.steps[0].say, /attempt 2 of 2/);
	assert.equal(after.steps[0].listBefore, "1:completed 2:completed 3:completed 4:in_progress");
	assert.equal((result as any).failed, "npm test");
});

test("a run that ended blocked resumes from its blocked step, in the same pi once it ended", async () => {
	const entries: Entry[] = [];
	const f = pilot(entries, [PLAN, done, { status: "blocked", note: "no access" }], [{ code: 0 }]);
	assert.equal(((await planRun("do it", f.api)) as any).blocked, "Write tests");
	f.answers.push(done);
	const result = await (await fresh()).resume("", f.api);
	assert.equal(f.steps.length, 4);
	assert.match(f.steps[3].say, /^Step 2 of 2: Write tests\./);
	assert.equal(f.steps[3].listBefore, "1:completed 2:completed 3:in_progress 4:pending");
	assert.equal(subjects(f), LIST);
	assert.equal((result as any).passed, true);
});

test("a passed run and a failed run are never resumed, not even through their older snapshots", async () => {
	for (const [answers, checks] of [
		[[PLAN, done, done], [{ code: 0 }]],
		[[PLAN, done, done, done, done], [{ code: 1 }, { code: 1 }, { code: 1 }]],
	] as [unknown[], Check[]][]) {
		const entries: Entry[] = [];
		await planRun("do it", pilot(entries, answers, checks).api);
		const phases = states(entries);
		assert.ok(phases.includes("step") && phases.includes("check"), "older unfinished snapshots are in the branch");
		assert.ok(["passed", "failed"].includes(phases.at(-1)!));
		const after = pilot(entries, [PLAN, done, done, done, done], [{ code: 0 }]);
		const result = await (await fresh()).resume("", after.api);
		assert.deepEqual([after.steps.length, after.execs.length], [0, 0]);
		assert.deepEqual(result, { resumed: false, reason: "no unfinished plan-run in this session" });
	}
});

test("two runs in one session: resume continues the newer one, even when the older one wrote last", async () => {
	const entries: Entry[] = [];
	let release!: (answer: unknown) => void;
	const older = pilot(entries, [PLAN, new Promise((resolve) => (release = resolve)), HANG]);
	void planRun("older task", older.api);
	await until(() => older.steps.length === 2);
	const newer = pilot(entries, [PLAN, { status: "blocked", note: "no access" }]);
	assert.equal(((await planRun("newer task", newer.api)) as any).blocked, "Write code");
	release(done);
	await until(() => older.steps.length === 3);

	const after = pilot(entries, [done, done], [{ code: 0 }]);
	const result = await (await fresh()).resume("", after.api);
	assert.match(after.steps[0].say, /^Step 1 of 2: Write code\./, "the newer run's blocked step, not the older run's step 2");
	assert.equal((result as any).passed, true);
});

test("nothing to resume: no step, a message and a result that say why", async () => {
	const f = pilot([], [PLAN, done, done], [{ code: 0 }]);
	const result = await (await fresh()).resume("", f.api);
	assert.deepEqual([f.steps.length, f.execs.length], [0, 0]);
	assert.deepEqual(result, { resumed: false, reason: "no unfinished plan-run in this session" });
	assert.deepEqual(f.messages, ["[autopilot] resume: no unfinished plan-run in this session"]);
});

test("resume starts nothing while a plan-run is still going in this pi, and resumes once that run threw", async () => {
	const entries: Entry[] = [];
	const f = pilot(entries, [PLAN, HANG]);
	void planRun("do it", f.api);
	await until(() => f.steps.length === 2);
	const refused = await (await fresh()).resume("", f.api);
	assert.equal(f.steps.length, 2, "no step started");
	assert.equal((refused as any).resumed, false);
	assert.match((refused as any).reason, /still going/);
	assert.match(f.messages[0], /still going/);

	const g = pilot([], [PLAN, new Error("boom")], [{ code: 0 }]);
	await assert.rejects(planRun("do it", g.api), /boom/);
	g.answers.push(done, done);
	const result = await (await fresh()).resume("", g.api);
	assert.equal((result as any).passed, true, "a run that threw does not block resume in its pi");
	assert.match(g.steps[2].say, /^Step 1 of 2: Write code\./);
});
