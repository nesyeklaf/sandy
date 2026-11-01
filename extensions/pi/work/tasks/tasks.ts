// The session's task list. The user follows it live in SANDY: sandy/work/goals reads the list from the session (state.ts)
// and shows the task in_progress with its activeForm as what is running. Two shapes of the same tools, for the
// measurement in pi/work/evals: one tool, tasks, with an action (the default); WORK_TASKS=four gives four tools named as
// in Claude Code, TaskCreate, TaskUpdate, TaskList and TaskGet. Measured on a real task with the same rules and notes,
// Haiku kept the list 6/6 with one tool and 1/6 with four (evals, onevsfour). Both shapes share the rules (guidelines, in the system
// prompt), the fields, the answers and the reminders (reminder.ts); only the shape differs. Always active, so a
// delegated child or a run inside a track stage keeps its list too; a focused goal with its own task tools hides
// them (goal/extensions). parent is ours: subtasks the SANDY banner opens.
import { apply, ENTRY, latest, STATUSES, type Action, type Task } from "./state.ts";
import { early, openTasks, regular, type Names } from "./reminder.ts";

export type Shape = "one" | "four";
export const shape = (): Shape => (process.env.WORK_TASKS === "four" ? "four" : "one");

export const FOUR = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
export const ONE = "tasks";
/** The tool names of a shape. */
export const toolNames = (s: Shape = shape()): string[] => (s === "one" ? [ONE] : [...FOUR]);
export const names = (s: Shape = shape()): Names =>
  s === "one" ? { create: 'tasks (action "create")', update: 'tasks (action "update")' } : { create: "TaskCreate", update: "TaskUpdate" };

/** The rules, exact, in the system prompt. */
export const guidelines = (n: Names = names()): string[] => [
  `Keep a task list with ${n.create} for any request that takes three or more steps (each changed file, test run or doc update counts), when the user gives a list of things to do, or right after new instructions. Create it BEFORE your first edit: one task per step the user would name, subject in imperative form, activeForm in present continuous. Skip it for a question or a one-step change.`,
  `Set a task in_progress with ${n.update} BEFORE you start its work. Exactly one task in_progress at a time.`,
  `Set a task completed with ${n.update} IMMEDIATELY when it is done: one task per update, never several at once. Not while its tests fail or the work is partial; then it stays in_progress.`,
  `Before your final answer, every task is completed or deleted. The user follows the list live in SANDY.`,
];

const CREATE = "Create one task, status pending. subject: imperative title. description: what needs to be done. activeForm: present continuous, shown while the task is in_progress. parent: id of the task this one is a step of.";
const UPDATE = "Update one task by taskId: status (pending, in_progress, completed, deleted), subject, description, activeForm, addBlocks, addBlockedBy (task ids).";
const LIST = "List all tasks: id, status, subject, open blockers.";
const GET = "Read one task in full by taskId: fields, blockers, steps.";

const text = (content: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: content }], ...extra });
const id = (value: unknown) => String(value ?? "").trim().replace(/^#/, "");
const ids = { type: "array", items: { type: "string" } };
const fields = {
  subject: { type: "string", description: "Imperative title" },
  description: { type: "string", description: "What needs to be done" },
  activeForm: { type: "string", description: 'Present continuous form shown while in_progress (e.g., "Running tests")' },
};
const createFields = { ...fields, parent: { type: "string", description: "Id of an existing task this one is a step of" } };
const updateFields = {
  taskId: { type: "string", description: "The ID of the task" },
  status: { type: "string", enum: [...STATUSES], description: "New status" },
  ...fields,
  addBlocks: { ...ids, description: "Task IDs that this task blocks" },
  addBlockedBy: { ...ids, description: "Task IDs that block this task" },
};

export default function tasks(pi: any): void {
  const s = shape();
  const n = names(s);
  const updater = s === "one" ? ONE : "TaskUpdate";
  let list: Task[] = [];
  let changedThisRun = false;
  let earlyDue = false;
  const restore = (ctx: any) => {
    try {
      list = latest(ctx.sessionManager?.getBranch?.() ?? [])?.tasks ?? [];
    } catch {
      list = [];
    }
  };
  pi.on("session_start", (_event: unknown, ctx: any) => restore(ctx));
  pi.on("session_tree", (_event: unknown, ctx: any) => restore(ctx));
  pi.on("agent_start", () => {
    changedThisRun = false;
    earlyDue = openTasks(list).length === 0;
  });
  pi.on("tool_result", (event: any, ctx: any) => {
    if (event.parentToolCallId) return undefined;
    try {
      if (!(pi.getActiveTools?.() ?? []).includes(updater)) return undefined;
      let note: string | null = null;
      if (earlyDue) {
        earlyDue = false;
        if (openTasks(list).length === 0) note = early(n);
      } else note = regular(ctx?.sessionManager?.getBranch?.() ?? [], list, n, changedThisRun && openTasks(list).length === 0);
      return note === null ? undefined : { content: [...(event.content ?? []), { type: "text", text: note }] };
    } catch {
      return undefined;
    }
  });

  /** Applies a change; a bad input comes back to the model as an error with the reason. */
  const change = (action: Action, answer: (next: Task[]) => string) => {
    let next: Task[];
    try {
      next = apply(list, action);
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), { isError: true });
    }
    list = next;
    changedThisRun = true;
    pi.appendEntry(ENTRY, { version: 2, tasks: list, updatedAt: Date.now() });
    return text(answer(list), { details: { tasks: list } });
  };
  const live = () => list.filter((t) => t.status !== "deleted");

  const create = (params: any) =>
    change({ action: "create", subject: params.subject, description: params.description, activeForm: params.activeForm, parent: params.parent }, (next) => {
      const task = next[next.length - 1];
      return `Task #${task.id} created successfully: ${task.subject}`;
    });
  const update = (params: any) => {
    const taskId = id(params.taskId);
    // Not found is benign, as in Claude Code: the list may have been cleaned up.
    if (!list.some((t) => t.id === taskId && t.status !== "deleted")) return text(`Task #${taskId} not found`);
    const changed = ["status", "subject", "description", "activeForm", "addBlocks", "addBlockedBy"].filter((key) => params[key] !== undefined);
    const action: Action =
      params.status === "deleted"
        ? { action: "delete", id: taskId }
        : { action: "update", id: taskId, status: params.status, subject: params.subject, description: params.description, activeForm: params.activeForm, addBlocks: params.addBlocks, addBlockedBy: params.addBlockedBy };
    return change(action, () => `Updated task #${taskId} ${changed.map((f) => (f === "addBlocks" ? "blocks" : f === "addBlockedBy" ? "blockedBy" : f)).join(", ")}`);
  };
  const show = () => {
    const shown = live();
    if (shown.length === 0) return text("No tasks found");
    return text(
      shown
        .map((task) => {
          const blockers = (task.blockedBy ?? []).filter((dep) => list.some((t) => t.id === dep && t.status !== "completed" && t.status !== "deleted"));
          return `#${task.id} [${task.status}] ${task.subject}${blockers.length ? ` [blocked by ${blockers.map((dep) => "#" + dep).join(", ")}]` : ""}`;
        })
        .join("\n"),
      { details: { tasks: list } },
    );
  };
  const get = (params: any) => {
    const task = live().find((t) => t.id === id(params.taskId));
    if (!task) return text("Task not found");
    const blocks = live().filter((t) => t.blockedBy?.includes(task.id)).map((t) => "#" + t.id);
    const steps = live().filter((t) => t.parent === task.id).map((t) => `#${t.id} [${t.status}] ${t.subject}`);
    return text(
      [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
        task.activeForm ? `Active form: ${task.activeForm}` : "",
        task.description ? `Description: ${task.description}` : "",
        task.parent ? `Step of: #${task.parent}` : "",
        task.blockedBy?.length ? `Blocked by: ${task.blockedBy.map((dep) => "#" + dep).join(", ")}` : "",
        blocks.length ? `Blocks: ${blocks.join(", ")}` : "",
        steps.length ? `Steps:\n${steps.join("\n")}` : "",
      ].filter(Boolean).join("\n"),
      { details: { task } },
    );
  };

  if (s === "one") {
    pi.registerTool({
      name: ONE,
      label: "tasks",
      description: `The session's task list; the user follows it live in SANDY. One call per change.\n- action "create": ${CREATE}\n- action "update": ${UPDATE}\n- action "list": ${LIST}\n- action "get": ${GET}`,
      promptSnippet: "Keep the session's task list: create, update, list, get (the user follows it in SANDY)",
      promptGuidelines: guidelines(n),
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["create", "update", "list", "get"], description: "What to do" }, ...updateFields, parent: createFields.parent },
        required: ["action"],
      },
      async execute(_call: string, params: any) {
        if (params.action === "create") return create(params);
        if (params.action === "update") return update(params);
        if (params.action === "list") return show();
        if (params.action === "get") return get(params);
        return text("action must be one of create, update, list, get", { isError: true });
      },
    });
    return;
  }
  pi.registerTool({ name: "TaskCreate", label: "TaskCreate", description: CREATE, promptSnippet: "Create a task in the session's task list (the user follows it in SANDY)", promptGuidelines: guidelines(n), parameters: { type: "object", properties: createFields, required: ["subject"] }, execute: async (_c: string, p: any) => create(p) });
  pi.registerTool({ name: "TaskUpdate", label: "TaskUpdate", description: UPDATE, promptSnippet: "Update a task: status, subject, description, activeForm, dependencies", parameters: { type: "object", properties: updateFields, required: ["taskId"] }, execute: async (_c: string, p: any) => update(p) });
  pi.registerTool({ name: "TaskList", label: "TaskList", description: LIST, promptSnippet: "List the session's tasks", parameters: { type: "object", properties: {} }, execute: async () => show() });
  pi.registerTool({ name: "TaskGet", label: "TaskGet", description: GET, promptSnippet: "Read one task in full", parameters: { type: "object", properties: { taskId: updateFields.taskId }, required: ["taskId"] }, execute: async (_c: string, p: any) => get(p) });
}
