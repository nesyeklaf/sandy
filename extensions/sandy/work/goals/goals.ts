// Reads pi-goal-x's goal pool, archive and ledger. Read-only: pi-goal-x owns every file here.
// Formats follow pi-goal-x 0.34 (extensions/storage/goal-files.ts, goal-ledger.ts, goal-root.ts).
import { existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Archived, Audit, Goal, GoalEvent, SessionActivity, SessionTask, Task } from "./contract.ts";

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** End index of the leading JSON object, honoring strings; -1 when it never closes. */
export function jsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The objective as pi-goal-x writes it under "# Goal Prompt", up to "## Progress". */
function objectiveFromBody(body: string): string | null {
  const lines = body.replace(/^\s+/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
  if (start < 0) return str(body.trim());
  const end = lines.findIndex((line, i) => i > start && line.trim() === "## Progress");
  return str(lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim());
}

function task(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Raw;
  const id = str(t.id);
  if (!id) return null;
  const status = t.status === "complete" || t.status === "skipped" ? t.status : "pending";
  return {
    id,
    title: str(t.title) ?? id,
    status,
    evidence: str(t.evidence),
    skipReason: str(t.skipReason),
    verificationContract: str(t.verificationContract),
    completedAt: str(t.completedAt) ?? str(t.skippedAt),
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(task).filter((s): s is Task => s !== null) : [],
  };
}

const STATUSES = new Set(["active", "paused", "blocked", "budget_limited", "complete"]);

/** Parses one goal file (JSON meta first, markdown after); null when it is not a goal file. */
export function parseGoal(content: string): Goal | null {
  const end = jsonObjectEnd(content);
  if (end < 0) return null;
  let raw: Raw;
  try {
    raw = JSON.parse(content.slice(0, end + 1)) as Raw;
  } catch {
    return null;
  }
  const id = str(raw.id);
  if (!id) return null;
  const usage = (raw.usage ?? {}) as Raw;
  const list = raw.taskList && typeof raw.taskList === "object" ? (raw.taskList as Raw) : null;
  const status = typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as Goal["status"]) : "active";
  return {
    id,
    objective: objectiveFromBody(content.slice(end + 1)) ?? str(raw.objective) ?? "",
    status,
    autoContinue: raw.autoContinue === true,
    sisyphus: raw.sisyphus === true,
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    tokensUsed: num(usage.tokensUsed) ?? 0,
    activeSeconds: num(usage.activeSeconds) ?? 0,
    tokenBudget: num(raw.tokenBudget),
    pauseReason: str(raw.pauseReason),
    pauseSuggestedAction: str(raw.pauseSuggestedAction),
    stopReason: str(raw.stopReason),
    currentTaskId: str(raw.currentTaskId),
    verificationContract: str(raw.verificationContract),
    skipAuditor: raw.skipAuditor === true,
    blockCompletion: list ? list.blockCompletion === true : null,
    tasks: list && Array.isArray(list.tasks) ? list.tasks.map(task).filter((t): t is Task => t !== null) : [],
    audit: null,
  };
}

const expandHome = (value: string) => (value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);

function settingsRoot(file: string): string | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Raw;
    return str(value.goalsRoot);
  } catch {
    return null;
  }
}

/** pi-goal-x's goal root for a session: PI_GOAL_ROOT, then project, then global goalsRoot, else <cwd>/.pi/goals. */
export function goalRoot(cwd: string, env: Record<string, string | undefined>, agent: string): string {
  const projectFile = str(env.PI_GOAL_SETTINGS_FILE) ?? path.join(cwd, ".pi", "pi-goal-x-settings.json");
  const globalFile = str(env.PI_GOAL_GLOBAL_SETTINGS_FILE) ?? path.join(agent, "pi-goal-x-settings.json");
  const configured = str(env.PI_GOAL_ROOT) ?? settingsRoot(projectFile) ?? settingsRoot(globalFile);
  if (configured) {
    const expanded = expandHome(configured);
    if (path.isAbsolute(expanded)) return path.normalize(expanded);
  }
  return path.resolve(cwd, ".pi/goals");
}

function goalFiles(dir: string): string[] {
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
    return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function readGoal(file: string): Goal | null {
  try {
    return lstatSync(file).isSymbolicLink() ? null : parseGoal(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Open goals of the pool, oldest first (pi-goal-x skips completed ones the same way). */
export function readPool(root: string): Goal[] {
  return goalFiles(root)
    .filter((file) => /^active_goal_.*\.md$/.test(path.basename(file)))
    .sort()
    .map(readGoal)
    .filter((goal): goal is Goal => goal !== null && goal.status !== "complete");
}

/** Archived goals, newest first. */
export function readArchived(root: string, limit: number): Archived[] {
  return goalFiles(path.join(root, "archived"))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ file }) => readGoal(file))
    .filter((goal): goal is Goal => goal !== null)
    .map((goal) => ({
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      updatedAt: goal.updatedAt,
      tokensUsed: goal.tokensUsed,
      activeSeconds: goal.activeSeconds,
      taskCount: goal.tasks.length,
      tasksDone: goal.tasks.filter((t) => t.status !== "pending").length,
    }));
}

/** The last `bytes` of a file, cut at the first full line. */
function tail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

export type LedgerEvent = Raw & { type: string; at: string; goalId?: string };

/** Recent ledger events in file order; malformed lines are skipped. */
export function readLedger(root: string, bytes = 512 * 1024): LedgerEvent[] {
  const file = path.join(root, "goal_events.jsonl");
  if (!existsSync(file)) return [];
  const events: LedgerEvent[] = [];
  for (const line of tail(file, bytes).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Raw;
      if (typeof value.type === "string" && typeof value.at === "string") events.push(value as LedgerEvent);
    } catch {
      // a line being written or a corrupt one
    }
  }
  return events;
}

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One readable line per ledger event. */
export function describe(event: LedgerEvent): string {
  const e = event as Raw;
  const s = (key: string) => str(e[key]) ?? "";
  switch (event.type) {
    case "goal_created": return `Created: ${clip(s("objective"), 100)}`;
    case "goal_focused": return `Focused (${s("reason")})`;
    case "goal_unfocused": return `Unfocused (${s("reason")})`;
    case "goal_paused": return `Paused by ${s("source") || "user"}: ${clip(s("reason"))}`;
    case "goal_resumed": return `Resumed: ${clip(s("reason"))}`;
    case "goal_tweaked": return `Tweaked: ${clip(s("changeSummary"))}`;
    case "auditor_toggled": return e.enabled ? "Auditor on" : "Auditor off";
    case "completion_requested": return `Completion requested${s("summary") ? `: ${clip(s("summary"))}` : ""}`;
    case "audit_started": return `Audit started${s("model") ? ` (${s("model")})` : ""}`;
    case "audit_result": return `Audit ${s("verdict")}`;
    case "audit_skipped": return `Audit skipped (${s("reason")})`;
    case "goal_completed": return "Completed";
    case "goal_archived": return "Archived";
    case "goal_archive_failed": return `Archive failed: ${clip(s("message"))}`;
    case "goal_aborted": return `Aborted: ${clip(s("reason"))}`;
    case "task_list_set": return `Task list set (${num(e.taskCount) ?? 0} tasks)`;
    case "task_started": return `Started task ${s("taskId")}`;
    case "task_complete": return `Completed task ${s("taskId")}${s("evidence") ? `: ${clip(s("evidence"))}` : ""}`;
    case "task_skipped": return `Skipped task ${s("taskId")}: ${clip(s("reason"))}`;
    case "task_reopened": return `Reopened task ${s("taskId")}`;
    case "goal_budget_changed": return `Budget ${num(e.oldBudget) ?? "none"} → ${num(e.newBudget) ?? "none"}`;
    case "goal_budget_limited": return `Budget reached (${num(e.tokensUsed) ?? 0}/${num(e.budget) ?? 0})`;
    case "goal_budget_warning": return `Budget at ${num(e.pct) ?? 0}%`;
    case "goal_stalled": return `Stalled: ${clip(s("reason"))}`;
    case "goal_blocked": return `Blocked: ${clip(s("reason"))}`;
    case "oracle_started": return "Oracle consulted";
    case "oracle_result": return `Oracle: ${s("disposition")} — ${clip(s("summary"))}`;
    case "oracle_failed": return `Oracle failed: ${clip(s("message"))}`;
    default: return event.type.replace(/_/g, " ");
  }
}

const TONE: Record<string, GoalEvent["tone"]> = {
  goal_completed: "good", task_complete: "good", audit_result: "info",
  goal_paused: "warn", goal_stalled: "warn", goal_budget_warning: "warn", task_skipped: "warn",
  goal_blocked: "bad", goal_budget_limited: "bad", goal_aborted: "bad", goal_archive_failed: "bad", oracle_failed: "bad",
};

export function toEvents(events: LedgerEvent[], limit: number): GoalEvent[] {
  return events.slice(-limit).reverse().map((event) => ({
    type: event.type,
    goalId: str(event.goalId),
    at: event.at,
    text: describe(event),
    tone: event.type === "audit_result"
      ? ((event as Raw).verdict === "approved" ? "good" : "bad")
      : TONE[event.type] ?? "neutral",
  }));
}

/** The latest settled auditor verdict per goal. */
export function audits(events: LedgerEvent[]): Map<string, Audit> {
  const result = new Map<string, Audit>();
  for (const event of events) {
    const e = event as Raw;
    const goalId = str(e.goalId);
    if (!goalId) continue;
    if (event.type === "audit_started") result.set(goalId, { verdict: "running", report: null, at: event.at });
    else if (event.type === "audit_result") {
      const verdict = e.verdict === "approved" || e.verdict === "disapproved" ? e.verdict : "error";
      result.set(goalId, { verdict, report: str(e.report), at: event.at });
    } else if (event.type === "audit_skipped") result.set(goalId, { verdict: "skipped", report: str(e.reason), at: event.at });
  }
  return result;
}

/** The goal this pi session focused last, from its pi-goal-focus session entries; undefined when it never set one. */
/** pi/work/tasks statuses, current and version 1 (todo/doing/done/blocked), as shown here; deleted is left out. */
const TASK_STATUS: Record<string, SessionTask["status"]> = {
  pending: "pending", in_progress: "in_progress", completed: "completed",
  todo: "pending", doing: "in_progress", done: "completed", blocked: "pending",
};

/**
 * The session's own task list: the data of the last "work-tasks" entry pi/work's tasks tool appended (each
 * entry holds the whole list). Reads the file's tail like sessionFocus, but a larger one, because the list
 * may have changed long before the last turn. [] when there is none.
 */
export function sessionTasks(sessionFile: string, bytes = 8 * 1024 * 1024): SessionTask[] {
  if (!existsSync(sessionFile)) return [];
  const lines = tail(sessionFile, bytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"work-tasks"')) continue;
    try {
      const entry = JSON.parse(lines[i]) as Raw;
      if (entry.type !== "custom" || entry.customType !== "work-tasks") continue;
      const tasks = ((entry.data ?? {}) as Raw).tasks;
      if (!Array.isArray(tasks)) return [];
      return tasks.flatMap((raw: Raw) => {
        const id = typeof raw?.id === "number" ? String(raw.id) : str(raw?.id);
        const subject = str(raw?.subject) ?? str(raw?.title);
        const status = TASK_STATUS[raw?.status as string];
        if (!id || !subject || !status) return [];
        const note = str(raw.note);
        const description = str(raw.description) ?? (note && raw.status === "blocked" ? `blocked: ${note}` : note);
        const blockedBy = Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [];
        return [{ id, subject, status, description, activeForm: str(raw.activeForm), parent: str(raw.parent), blockedBy }];
      });
    } catch {
      // partial line
    }
  }
  return [];
}

const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file;
const oneLine = (text: string, max: number) => {
  const flat = text.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A short English label for a tool call: what the agent is doing right now. */
export function activityLabel(name: string, args: Raw): string {
  const tool = name.replace(/^mcp__.*?__/, "");
  const file = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  if ((tool === "edit" || tool === "write") && file) return `Editing ${baseName(file)}`;
  if (tool === "read" && file) return `Reading ${baseName(file)}`;
  if (tool === "bash" && str(args.command)) return `Running ${oneLine(args.command as string, 40)}`;
  if (tool.endsWith("codemode")) {
    const used = [...new Set([...(str(args.code) ?? "").matchAll(/\btools\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))].slice(0, 3);
    return used.length > 0 ? `Running script (${used.join(", ")})` : "Running script";
  }
  return `Running ${tool}`;
}

/**
 * The tool call the agent is running now: the newest call of the last assistant message that has no toolResult
 * yet, provided no user message follows it. Reads the file's tail, newest line first. null when nothing is open.
 * An aborted turn can leave an open call behind; the banner only shows this while the thread runs.
 */
export function sessionActivity(sessionFile: string, bytes = 1024 * 1024): SessionActivity | null {
  if (!existsSync(sessionFile)) return null;
  const lines = tail(sessionFile, bytes).split("\n");
  const finished = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes('"role":"toolResult"')) {
      const id = /"toolCallId":"([^"]+)"/.exec(line)?.[1];
      if (id) finished.add(id);
    } else if (line.includes('"role":"user"')) {
      return null;
    } else if (line.includes('"role":"assistant"')) {
      try {
        const entry = JSON.parse(line) as Raw;
        const message = (entry.message ?? {}) as Raw;
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        const calls = (message.content as Raw[]).filter((block) => block?.type === "toolCall" && typeof block.name === "string");
        if (calls.length === 0) return null;
        const open = calls.filter((block) => !finished.has(block.id as string)).pop();
        if (!open) return null;
        const args = open.arguments && typeof open.arguments === "object" ? (open.arguments as Raw) : {};
        const since = str(entry.timestamp);
        return since ? { tool: (open.name as string).replace(/^mcp__.*?__/, ""), label: activityLabel(open.name as string, args), since } : null;
      } catch {
        // a partial line at the file's end: the call is still being written
      }
    }
  }
  return null;
}

export function sessionFocus(sessionFile: string, bytes = 2 * 1024 * 1024): string | null | undefined {
  if (!existsSync(sessionFile)) return undefined;
  let focus: string | null | undefined;
  for (const line of tail(sessionFile, bytes).split("\n")) {
    if (!line.includes('"pi-goal-focus"')) continue;
    try {
      const entry = JSON.parse(line) as Raw;
      if (entry.customType !== "pi-goal-focus") continue;
      const data = (entry.data ?? {}) as Raw;
      focus = str(data.focusedGoalId);
    } catch {
      // partial line
    }
  }
  return focus;
}
