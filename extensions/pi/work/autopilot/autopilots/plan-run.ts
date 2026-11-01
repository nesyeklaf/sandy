/**
 * Plan-run autopilot: the code keeps the task list, the model only does the work. A planning task shows from the first
 * second; one planning step returns the work steps and the command that checks the whole work (schema). Each step runs
 * as its own turn, set in_progress before and completed after by the autopilot, so the list and the banner's Now line
 * follow the work by construction. A step the model reports blocked stays in_progress and the run stops there. The
 * check runs by code at the end; on red the model gets the output tail in a fix step, at most FIXES times. The task
 * tools are blocked in every step: the autopilot is the list's only owner while it runs.
 *
 * Each transition is also recorded as an autopilot-plan-run session entry (run id, task, plan, phase, step, fixes used).
 * After pi reloaded or restarted mid-run, /autopilot resume continues the newest unfinished run from them: done steps and
 * the plan stay done, the step that was running (or blocked) runs again from the start, an interrupted check runs again
 * with the fix steps it has left, and a run stopped while planning plans again. The task list keeps its ids and subjects.
 * A run that passed or failed is never resumed; while a plan-run goes in this pi, resume starts nothing and says why.
 *
 *   /autopilot plan-run <the task>
 *   /autopilot resume
 */
// Inline, not imported from tasks/state.ts: autopilots load through the ~/.pi/agent/autopilots symlink, where relative
// imports outside the folder do not resolve. Same entry and shape as the task tools write (tasks/state.ts).
const ENTRY = "work-tasks";
type Task = { id: string; subject: string; activeForm: string; status: "pending" | "in_progress" | "completed" };
import { randomUUID } from "node:crypto";
import type { Session } from "../session.ts";

const FIXES = 2;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
// pi/work/tasks' names, either shape (tasks, or WORK_TASKS=four); inlined, the autopilots symlink resolves no imports.
const TASK_TOOLS = ["tasks", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
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

/** The run's own state, next to the task list: what a resumed run needs to go on (docs/resume.md). */
const STATE = "autopilot-plan-run";
type Plan = { steps: { subject: string; activeForm: string }[]; check: string };
type Phase = "planning" | "step" | "blocked" | "check" | "passed" | "failed";
/** step: the step's index while it runs or is blocked; fixes: the fix steps finished in the check phase. */
type RunState = { run: string; task: string; phase: Phase; plan?: Plan; step?: number; fixes?: number };
type Api = { pi: any; session: Session; ctx?: any };
const FINISHED: Phase[] = ["passed", "failed"];

/**
 * The plan-runs going in each extension instance, keyed by its pi. In globalThis, because autopilot modules are imported
 * fresh on every call; by pi, because a reload makes a new instance while the old run hangs on a turn end that never
 * comes (docs/resume.md), so it must not block the new instance.
 */
const RUNNING = Symbol.for("pi-work.plan-run.running");
const running = (): WeakMap<object, number> => ((globalThis as any)[RUNNING] ??= new WeakMap());

export default async function planRun(args: unknown, api: Api) {
	const task = (typeof args === "string" ? args : String((args as any)?.task ?? "")).trim();
	if (!task) throw new Error("plan-run needs the task as its args");
	return await go(api, { run: randomUUID(), task, phase: "planning" });
}

/** /autopilot resume: continues the newest unfinished plan-run of this session where it stopped. */
export async function resume(_args: unknown, api: Api) {
	const refuse = (reason: string) => {
		api.pi.sendMessage({ customType: "autopilot", content: `[autopilot] resume: ${reason}`, display: true }, { triggerTurn: false });
		return { resumed: false, reason };
	};
	if (running().has(api.pi)) return refuse("a plan-run is still going in this pi; it was not resumed");
	const from = unfinished(api.ctx?.sessionManager?.getBranch?.() ?? []);
	if (!from) return refuse("no unfinished plan-run in this session");
	return await go(api, from);
}

/**
 * The newest run (by its first entry) whose latest state is not finished: a passed or failed run never comes back through
 * an older state, and an older run that wrote last does not win over a newer one.
 */
function unfinished(branch: readonly any[]): RunState | undefined {
	const latest = new Map<string, RunState>();
	for (const entry of branch) {
		if (entry?.type !== "custom" || entry.customType !== STATE || typeof entry.data?.run !== "string") continue;
		latest.set(entry.data.run, entry.data);
	}
	return [...latest.values()].reverse().find((state) => !FINISHED.includes(state.phase));
}

async function go(api: Api, from: RunState) {
	const marks = running();
	marks.set(api.pi, (marks.get(api.pi) ?? 0) + 1);
	try {
		return await drive(api, from);
	} finally {
		const left = (marks.get(api.pi) ?? 1) - 1;
		if (left > 0) marks.set(api.pi, left);
		else marks.delete(api.pi);
	}
}

/** Runs from where from stands: planning, a step (running or blocked) or the check. Ids and subjects follow from the plan. */
async function drive(api: Api, from: RunState) {
	const { run, task } = from;
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
	let plan = from.phase === "planning" ? undefined : from.plan;
	const record = (phase: Phase, at: { step?: number; fixes?: number } = {}) =>
		api.pi.appendEntry(STATE, { version: 1, run, task, phase, plan, ...at, updatedAt: Date.now() });

	const planning = add("Plan the work", "Planning the work");
	if (!plan) {
		record("planning");
		set(planning, "in_progress");
		const answer = await api.session.step({
			say:
				`The task:\n${task}\n\nPlan it first. Read what you need, but change no file yet. Split the work into 2 to 4 steps in the order you will do them; ` +
				"each step is a sizeable piece (several files may share one). Running the checks is not a step: name the one shell command that checks the whole work (check). Submit the steps and the command.",
			tools: ["read", "bash", "grep", "find", "ls"],
			deny: TASK_TOOLS,
			schema: PLAN,
		});
		plan = answer.value as Plan;
	}
	const value = plan;
	planning.status = "completed";
	const steps = value.steps.map((s) => add(s.subject, s.activeForm));
	const checking = add(`Run ${value.check}`, `Running ${value.check}`);
	const first = from.phase === "check" ? steps.length : from.phase === "step" || from.phase === "blocked" ? (from.step ?? 0) : 0;
	for (const t of steps.slice(0, first)) t.status = "completed";
	write();
	const subjects = steps.map((s) => s.subject);

	for (let i = first; i < steps.length; i++) {
		const t = steps[i];
		record("step", { step: i });
		set(t, "in_progress");
		const done = await api.session.step({
			// Only the current step: the plan is already in the context (the planning step's submit).
			say: `Step ${i + 1} of ${steps.length}: ${t.subject}. Only this step. Submit status done and one short line when it is done; if you cannot finish it, status blocked and why.`,
			deny: TASK_TOOLS,
			schema: DONE,
		});
		const result = done.value as { status: "done" | "blocked"; note: string };
		if (result.status === "blocked") {
			record("blocked", { step: i });
			return { blocked: t.subject, note: result.note, steps: subjects };
		}
		set(t, "completed");
	}

	// An interrupted check runs again with the fix steps it has left.
	let fixes = from.phase === "check" ? (from.fixes ?? 0) : 0;
	record("check", { fixes });
	set(checking, "in_progress");
	const check = () => api.session.exec("bash", ["-c", value.check], { timeout: CHECK_TIMEOUT_MS });
	let ran = await check();
	while (!passed(ran) && fixes < FIXES) {
		const fix = fixes + 1;
		await api.session.step({
			say:
				`\`${value.check}\` ${ran.killed ? "timed out" : `exited ${ran.code}`}. Output tail:\n${tail(ran)}\n\n` +
				`Fix the cause (attempt ${fix} of ${FIXES}); do not weaken or delete tests. Submit status done and one short line when it is fixed, blocked and why if you cannot.`,
			deny: TASK_TOOLS,
			schema: DONE,
		});
		fixes = fix;
		record("check", { fixes });
		ran = await check();
	}
	if (!passed(ran)) {
		record("failed", { fixes });
		return { failed: value.check, code: ran.code, killed: ran.killed, tail: tail(ran), steps: subjects };
	}
	set(checking, "completed");
	record("passed", { fixes });
	return { steps: subjects, check: value.check, passed: true };
}

const passed = (ran: { code: number; killed?: boolean }) => ran.code === 0 && !ran.killed;
const tail = (ran: { stdout: string; stderr: string }) => `${ran.stdout}\n${ran.stderr}`.trim().split("\n").slice(-60).join("\n");
