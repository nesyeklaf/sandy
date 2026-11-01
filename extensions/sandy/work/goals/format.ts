// Pure helpers shared by the banner and the tab.
import type { Goal, SessionTask, Snapshot, Task } from "./contract.ts";

/** Session tasks: completed over all of them, and the one being worked on (first in_progress, else first pending). */
export function sessionProgress(tasks: SessionTask[]): { done: number; total: number; current: SessionTask | null } {
  return {
    done: tasks.filter((t) => t.status === "completed").length,
    total: tasks.length,
    current: tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending") ?? null,
  };
}

/** What the banner says the agent is doing: the activeForm of a task in progress, else its subject. */
export function sessionLabel(task: SessionTask): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
}

/** Session tasks with their depth, subtasks under their parent; orphans (parent gone) at the top level. */
export function sessionTree(tasks: SessionTask[]): { task: SessionTask; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const out: { task: SessionTask; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const task of tasks) {
      const p = task.parent && ids.has(task.parent) ? task.parent : null;
      if (p !== parent) continue;
      out.push({ task, depth });
      if (depth < 8) walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return `${duration((now - at) / 1000)} ago`;
}

/** Every task and subtask, depth first. */
export function flatten(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

/** Done = complete or skipped, counted over top-level tasks (subtasks roll into their parent). */
export function progress(goal: Goal): { done: number; total: number } {
  return { done: goal.tasks.filter((t) => t.status !== "pending").length, total: goal.tasks.length };
}

/** The task the agent works on: pi-goal-x's currentTaskId, else the first pending task. */
export function currentTask(goal: Goal): Task | null {
  const all = flatten(goal.tasks);
  return all.find((t) => t.id === goal.currentTaskId) ?? all.find((t) => t.status === "pending") ?? null;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export function statusOf(goal: Goal): { label: string; tone: Tone; icon: string } {
  switch (goal.status) {
    case "active": return { label: "Running", tone: "info", icon: "Play" };
    case "paused": return { label: "Paused", tone: "warn", icon: "Pause" };
    case "blocked": return { label: "Blocked", tone: "bad", icon: "OctagonAlert" };
    case "budget_limited": return { label: "Budget reached", tone: "bad", icon: "Gauge" };
    case "complete": return { label: "Complete", tone: "good", icon: "CircleCheck" };
  }
}

export function budget(goal: Goal): { used: number; limit: number; pct: number } | null {
  if (!goal.tokenBudget || goal.tokenBudget <= 0) return null;
  return { used: goal.tokensUsed, limit: goal.tokenBudget, pct: Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) };
}

/** First line of the objective, for one-line titles. */
export function title(goal: Goal, max = 120): string {
  const line = goal.objective.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? goal.id;
  const plain = line.replace(/^#+\s*/, "");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** The goal the banner shows: the session's focus; others count as "+N". */
export function focused(snapshot: Snapshot): { goal: Goal | null; others: number } {
  const goal = snapshot.goals.find((g) => g.id === snapshot.focusedId) ?? null;
  return { goal, others: snapshot.goals.length - (goal ? 1 : 0) };
}

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
  info: "text-primary",
};
