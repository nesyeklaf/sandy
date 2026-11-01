/**
 * Plan-run autopilot: the code keeps the task list, the model only does the work. A planning task shows from the first
 * second; one planning step returns the work steps and the command that checks the whole work (schema). Each step runs
 * as its own turn, set in_progress before and completed after by the autopilot, so the list and the banner's Now line
 * follow the work by construction. A step the model reports blocked stays in_progress and the run stops there. The
 * check runs by code at the end; on red the model gets the output tail in a fix step, at most FIXES times. The task
 * tools are blocked in every step: the autopilot is the list's only owner while it runs.
 *
 * Every change also appends the run's state (RUN entry): the task, the plan, the list and the status. A pi that
 * reloaded mid-run continues it with resumeRun (/autopilot resume): completed steps are skipped, the step that was
 * running runs again from the start, the list keeps its ids.
 *
 *   /autopilot plan-run <the task>
 */
import type { Api, Entry } from "./session.ts";

// Same entry and shape as the session task tools write, so the composer banner shows this list.
const ENTRY = "work-tasks";
/** The run's state, appended with every list change. */
export const RUN = "autopilot-run";
type Task = { id: string; subject: string; activeForm: string; status: "pending" | "in_progress" | "completed" };
type Plan = { steps: { subject: string; activeForm: string }[]; check: string };
export type Run = { task: string; status: "running" | "blocked" | "passed" | "failed"; plan?: Plan; tasks: Task[] };

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
	return drive({ task, status: "running", tasks: [] }, api);
}

/** The newest plan-run recorded in the session entries, or null. */
export function latestRun(entries: readonly Entry[]): Run | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === RUN) return structuredClone(e.data) as Run;
	}
	return null;
}

/** A run pi stopped in (still "running") or one that ended blocked; passed and failed runs are over. */
export const resumable = (run: Run | null): run is Run => run !== null && (run.status === "running" || run.status === "blocked");

/** Continues a recorded run where it stopped. */
export function resumeRun(run: Run, api: Api) {
	return drive({ ...run, status: "running" }, api);
}

async function drive(run: Run, api: Api) {
	const list = run.tasks;
	const write = () => {
		api.pi.appendEntry(ENTRY, { version: 2, tasks: list, updatedAt: Date.now() });
		api.pi.appendEntry(RUN, run);
	};
	const add = (subject: string, activeForm: string): Task => {
		const t: Task = { id: String(list.length + 1), subject, activeForm, status: "pending" };
		list.push(t);
		return t;
	};
	const set = (t: Task, status: Task["status"]) => {
		t.status = status;
		write();
	};
	// A task already in_progress when the run (re)starts was cut off by a reload or blocked: it runs again from the start.
	const again = (t: Task) => (t.status === "in_progress" ? " It was interrupted before: check what is already done, then finish it." : "");

	const planning = list[0] ?? add("Plan the work", "Planning the work");
	if (!run.plan) {
		set(planning, "in_progress");
		const plan = await api.session.step({
			say:
				"The task:\n" + run.task + "\n\nPlan it first. Read what you need, but change no file yet. Split the work into 2 to 4 steps in the order you will do them; " +
				"each step is a sizeable piece (several files may share one). Running the checks is not a step: name the one shell command that checks the whole work (check). Submit the steps and the command.",
			tools: ["read", "bash", "grep", "find", "ls"],
			deny: TASK_TOOLS,
			schema: PLAN,
		});
		run.plan = plan.value as Plan;
		planning.status = "completed";
		for (const s of run.plan.steps) add(s.subject, s.activeForm);
		add("Run " + run.plan.check, "Running " + run.plan.check);
		write();
	}
	const plan = run.plan;
	const steps = list.slice(1, 1 + plan.steps.length);
	const checking = list[1 + plan.steps.length];
	const subjects = steps.map((s) => s.subject);

	for (const [i, t] of steps.entries()) {
		if (t.status === "completed") continue;
		const note = again(t);
		set(t, "in_progress");
		const done = await api.session.step({
			say: "Step " + (i + 1) + " of " + steps.length + ": " + t.subject + "." + note + " Only this step. Submit status done and one short line when it is done; if you cannot finish it, status blocked and why.",
			deny: TASK_TOOLS,
			schema: DONE,
		});
		const result = done.value as { status: "done" | "blocked"; note: string };
		if (result.status === "blocked") {
			run.status = "blocked";
			write();
			return { blocked: t.subject, note: result.note, steps: subjects };
		}
		set(t, "completed");
	}

	set(checking, "in_progress");
	const check = () => api.session.exec("bash", ["-c", plan.check], { timeout: CHECK_TIMEOUT_MS });
	let ran = await check();
	for (let fix = 1; !passed(ran) && fix <= FIXES; fix++) {
		await api.session.step({
			say:
				"\u0060" + plan.check + "\u0060 " + (ran.killed ? "timed out" : "exited " + ran.code) + ". Output tail:\n" + tail(ran) + "\n\n" +
				"Fix the cause (attempt " + fix + " of " + FIXES + "); do not weaken or delete tests. Submit status done and one short line when it is fixed, blocked and why if you cannot.",
			deny: TASK_TOOLS,
			schema: DONE,
		});
		ran = await check();
	}
	if (!passed(ran)) {
		run.status = "failed";
		write();
		return { failed: plan.check, code: ran.code, killed: ran.killed, tail: tail(ran), steps: subjects };
	}
	run.status = "passed";
	set(checking, "completed");
	return { steps: subjects, check: plan.check, passed: true };
}

const passed = (ran: { code: number; killed?: boolean }) => ran.code === 0 && !ran.killed;
const tail = (ran: { stdout: string; stderr: string }) => (ran.stdout + "\n" + ran.stderr).trim().split("\n").slice(-60).join("\n");
