// Session tasks: the list of what this session is working on, kept with the session itself. Each change appends
// the whole list as one custom entry (ENTRY) to the pi session, so the state of any branch is its latest entry:
// /resume, /tree and forks see the tasks of their own branch, and sandy/work/goals reads the same entries from the
// session file. Pure: no I/O.
//
// The vocabulary is Claude Code's task tools (subject, description, activeForm, blockedBy; pending -> in_progress ->
// completed, deleted as a tombstone): models trained on those tools keep such a list more readily than one with
// words of its own. Our addition: parent, for subtasks. Lists written before version 2
// (title, note; todo/doing/done/blocked) are read and mapped.
export const ENTRY = "work-tasks";
export const STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
export type Status = (typeof STATUSES)[number];
export type Task = {
  id: string;
  subject: string;
  status: Status;
  description?: string;
  activeForm?: string;
  parent?: string;
  blockedBy?: string[];
};
export type Snapshot = { version: 2; tasks: Task[]; updatedAt: number };

export type TaskInput = {
  subject?: string;
  description?: string;
  activeForm?: string;
  parent?: string;
  blockedBy?: unknown[];
  subtasks?: TaskInput[];
};
export type Action =
  | { action: "list"; includeDeleted?: boolean }
  | ({ action: "create"; tasks?: TaskInput[] } & TaskInput)
  | {
      action: "update";
      id: unknown;
      status?: string;
      subject?: string;
      description?: string;
      activeForm?: string;
      addBlocks?: unknown[];
      addBlockedBy?: unknown[];
      removeBlockedBy?: unknown[];
    }
  | { action: "delete"; id: unknown }
  | { action: "clear" };

/** Allowed moves, as in rpiv-todo: completed only goes to deleted, deleted is final. Same to same is no move. */
const NEXT: Record<Status, readonly Status[]> = {
  pending: ["in_progress", "completed", "deleted"],
  in_progress: ["pending", "completed", "deleted"],
  completed: ["deleted"],
  deleted: [],
};

const isStatus = (value: unknown): value is Status => typeof value === "string" && (STATUSES as readonly string[]).includes(value);
/** Ids are strings ("3"); a model that sends 3 or "#3" means the same task. */
const idOf = (value: unknown): string => String(value ?? "").trim().replace(/^#/, "");
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function nextId(tasks: Task[]): string {
  let n = 0;
  for (const task of tasks) if (/^\d+$/.test(task.id)) n = Math.max(n, Number(task.id));
  return String(Math.max(n, tasks.length) + 1);
}

function find(tasks: Task[], raw: unknown): Task {
  const id = idOf(raw);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task #${id}; ids: ${tasks.filter((t) => t.status !== "deleted").map((t) => "#" + t.id).join(", ") || "none"}`);
  return task;
}

/** blockedBy ids that exist and are not deleted, never the task itself. */
function deps(tasks: Task[], self: string, raw: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const value of raw ?? []) {
    const dep = find(tasks, value);
    if (dep.status === "deleted") throw new Error(`blockedBy: #${dep.id} is deleted`);
    if (dep.id === self) throw new Error(`#${self} cannot be blocked by itself`);
    if (!out.includes(dep.id)) out.push(dep.id);
  }
  return out;
}

function cycle(tasks: Task[]): string | null {
  const by = new Map(tasks.map((t) => [t.id, t.blockedBy ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const dep of by.get(id) ?? []) if (visit(dep)) return true;
    state.set(id, 2);
    return false;
  };
  for (const task of tasks) if (visit(task.id)) return task.id;
  return null;
}

function create(tasks: Task[], inputs: TaskInput[], parent: string | undefined): Task[] {
  let out = tasks;
  for (const input of inputs) {
    const subject = text(input.subject);
    if (!subject) throw new Error("every task needs a subject");
    const id = nextId(out);
    const task: Task = { id, subject, status: "pending" };
    const description = text(input.description);
    const activeForm = text(input.activeForm);
    const under = parent ?? (input.parent !== undefined ? find(out, input.parent).id : undefined);
    if (description) task.description = description;
    if (activeForm) task.activeForm = activeForm;
    if (under) task.parent = under;
    const blockedBy = deps(out, id, input.blockedBy);
    if (blockedBy.length) task.blockedBy = blockedBy;
    out = create([...out, task], input.subtasks ?? [], id);
  }
  return out;
}

/** The ids of a task and all its subtasks. */
function family(tasks: Task[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const task of tasks) {
      if (!task.parent || !ids.has(task.parent) || ids.has(task.id)) continue;
      ids.add(task.id);
      grew = true;
    }
  }
  return ids;
}

/** The list after one action; throws with a message for the model on bad input. list returns tasks unchanged. */
export function apply(tasks: Task[], action: Action): Task[] {
  switch (action.action) {
    case "list":
      return tasks;
    case "clear":
      return [];
    case "create": {
      const batch = action.tasks?.length ? action.tasks : [action];
      if (action.tasks?.length && text(action.subject)) throw new Error("pass either subject or tasks[], not both");
      return create(tasks, batch, undefined);
    }
    case "delete": {
      const ids = family(tasks, find(tasks, action.id).id);
      return tasks.map((t) => (ids.has(t.id) ? { ...t, status: "deleted" as const } : t));
    }
    case "update": {
      const old = find(tasks, action.id);
      const task: Task = { ...old };
      if (action.status !== undefined) {
        if (!isStatus(action.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
        if (action.status !== old.status && !NEXT[old.status].includes(action.status))
          throw new Error(`#${old.id} is ${old.status}; it cannot go to ${action.status}${old.status === "completed" ? " (create a new task for follow-up work)" : ""}`);
        task.status = action.status;
      }
      if (text(action.subject)) task.subject = text(action.subject)!;
      if (action.description !== undefined) {
        if (text(action.description)) task.description = text(action.description);
        else delete task.description;
      }
      if (action.activeForm !== undefined) {
        if (text(action.activeForm)) task.activeForm = text(action.activeForm);
        else delete task.activeForm;
      }
      if (action.addBlockedBy?.length || action.removeBlockedBy?.length) {
        const drop = new Set((action.removeBlockedBy ?? []).map(idOf));
        const kept = (task.blockedBy ?? []).filter((id) => !drop.has(id));
        const blockedBy = [...kept, ...deps(tasks, task.id, action.addBlockedBy).filter((id) => !kept.includes(id))];
        if (blockedBy.length) task.blockedBy = blockedBy;
        else delete task.blockedBy;
      }
      let next = tasks.map((t) => (t.id === old.id ? task : t));
      // addBlocks is Claude Code's other direction: those tasks get this one in their blockedBy.
      for (const raw of action.addBlocks ?? []) {
        const other = find(next, raw);
        if (other.status === "deleted") throw new Error(`addBlocks: #${other.id} is deleted`);
        if (other.id === task.id) throw new Error(`#${task.id} cannot block itself`);
        if (!other.blockedBy?.includes(task.id)) next = next.map((t) => (t.id === other.id ? { ...t, blockedBy: [...(t.blockedBy ?? []), task.id] } : t));
      }
      if (cycle(next)) throw new Error("addBlockedBy would create a cycle in the blockedBy graph");
      return next;
    }
    default:
      throw new Error(`unknown action ${(action as { action?: unknown }).action}`);
  }
}

const LEGACY: Record<string, Status> = { todo: "pending", doing: "in_progress", done: "completed", blocked: "pending" };

/** One task from untrusted data, current or version 1 shape; null when it is not one. */
export function parseTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id) : null;
  const subject = typeof r.subject === "string" ? r.subject : typeof r.title === "string" ? r.title : null;
  const status = isStatus(r.status) ? r.status : typeof r.status === "string" ? LEGACY[r.status] : undefined;
  if (!id || subject === null || !status) return null;
  const task: Task = { id, subject, status };
  const description = typeof r.description === "string" ? r.description : typeof r.note === "string" ? (r.status === "blocked" ? `blocked: ${r.note}` : r.note) : undefined;
  if (description) task.description = description;
  if (typeof r.activeForm === "string") task.activeForm = r.activeForm;
  if (typeof r.parent === "string" || typeof r.parent === "number") task.parent = String(r.parent);
  if (Array.isArray(r.blockedBy)) task.blockedBy = r.blockedBy.map(String);
  return task;
}

/** Reads a snapshot from untrusted data (a session entry); null when it is not one. */
export function parseSnapshot(data: unknown): Snapshot | null {
  if (!data || typeof data !== "object") return null;
  const { tasks, updatedAt } = data as Record<string, unknown>;
  if (!Array.isArray(tasks)) return null;
  const clean: Task[] = [];
  for (const raw of tasks) {
    const task = parseTask(raw);
    if (!task) return null;
    clean.push(task);
  }
  return { version: 2, tasks: clean, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
}

/** The latest snapshot among session entries in order (a branch from root to leaf, or a whole file). */
export function latest(entries: readonly unknown[]): Snapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (entry?.type === "custom" && entry.customType === ENTRY) return parseSnapshot(entry.data);
  }
  return null;
}
