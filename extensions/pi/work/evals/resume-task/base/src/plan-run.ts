/**
 * Plan-run autopilot: the code keeps the task list, the model only does the work. A planning task shows from the first
 * second; one planning step returns the work steps and the command that checks the whole work (schema). Each step runs
 * as its own turn, set in_progress before and completed after by the autopilot, so the list and the banner's Now line
 * follow the work by construction. A step the model reports blocked stays in_progress and the run stops there. The
 * check runs by code at the end; on red the model gets the output tail in a fix step, at most FIXES times. The task
 * tools are blocked in every step: the autopilot is the list's only owner while it runs.
 *
 *   /autopilot plan-run <the task>
 */
// Same entry and shape as the session task tools write, so the composer banner shows this list.
const ENTRY = "work-tasks";
type Task = { id: string; subject: string; activeForm: string; status: "pending" | "in_progress" | "completed" };
import type { Api } from "./session.ts";

const FIXES = 2;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const TASK_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const PLAN = {
	type: "object",
	required: ["steps", "check"],
	properties: {
		steps: {
			type: "array",
			items: { type: "object", required: ["subject", "activeForm"], properties: { subject: { type: "string" }, activeForm: { type: "string" } } },
		},
		check: { type: "string" },
	},
};
// A step ends through autopilot_submit, which ends the turn without a model reply (session.ts): no prose summary.
const DONE = { type: "object", required: ["status", "note"], properties: { status: { enum: ["done", "blocked"] }, note: { type: "string" } } };

export default async function planRun(args: unknown, api: Api) {
	const task = (typeof args === "string" ? args : String((args as any)?.task ?? "")).trim();
	if (!task) throw new Error("plan-run needs the task as its args");
	const list: Task[] = [];
	const write = () => api.pi.appendEntry(ENTRY, { version: 2, tasks: list, updatedAt: Date.now() });
	const add = (subject: string, activeForm: string): Task => {
		const t: Task = { id: String(list.length + 1), subject, activeForm, status: "pending" };
		list.push(t);
		return t;
	};
	const set = (t: Task, status: Task["status"]) => {
		t.status = status;
		write();
	};

	const planning = add("Plan the work", "Planning the work");
	set(planning, "in_progress");
	const plan = await api.session.step({
		say:
			`The task:\n${task}\n\nPlan it first. Read what you need, but change no file yet. Split the work into 2 to 4 steps in the order you will do them; ` +
			"each step is a sizeable piece (several files may share one). Running the checks is not a step: name the one shell command that checks the whole work (check). Submit the steps and the command.",
		tools: ["read", "bash", "grep", "find", "ls"],
		deny: TASK_TOOLS,
		schema: PLAN,
	});
	const value = plan.value as { steps: { subject: string; activeForm: string }[]; check: string };
	planning.status = "completed";
	const steps = value.steps.map((s) => add(s.subject, s.activeForm));
	const checking = add(`Run ${value.check}`, `Running ${value.check}`);
	write();
	const subjects = steps.map((s) => s.subject);

	for (const [i, t] of steps.entries()) {
		set(t, "in_progress");
		const done = await api.session.step({
			// Only the current step: the plan is already in the context (the planning step's submit).
			say: `Step ${i + 1} of ${steps.length}: ${t.subject}. Only this step. Submit status done and one short line when it is done; if you cannot finish it, status blocked and why.`,
			deny: TASK_TOOLS,
			schema: DONE,
		});
		const result = done.value as { status: "done" | "blocked"; note: string };
		if (result.status === "blocked") return { blocked: t.subject, note: result.note, steps: subjects };
		set(t, "completed");
	}

	set(checking, "in_progress");
	const check = () => api.session.exec("bash", ["-c", value.check], { timeout: CHECK_TIMEOUT_MS });
	let ran = await check();
	for (let fix = 1; !passed(ran) && fix <= FIXES; fix++) {
		await api.session.step({
			say:
				`\`${value.check}\` ${ran.killed ? "timed out" : `exited ${ran.code}`}. Output tail:\n${tail(ran)}\n\n` +
				`Fix the cause (attempt ${fix} of ${FIXES}); do not weaken or delete tests. Submit status done and one short line when it is fixed, blocked and why if you cannot.`,
			deny: TASK_TOOLS,
			schema: DONE,
		});
		ran = await check();
	}
	if (!passed(ran)) return { failed: value.check, code: ran.code, killed: ran.killed, tail: tail(ran), steps: subjects };
	set(checking, "completed");
	return { steps: subjects, check: value.check, passed: true };
}

const passed = (ran: { code: number; killed?: boolean }) => ran.code === 0 && !ran.killed;
const tail = (ran: { stdout: string; stderr: string }) => `${ran.stdout}\n${ran.stderr}`.trim().split("\n").slice(-60).join("\n");
