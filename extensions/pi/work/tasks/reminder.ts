// Small, regular reminders for the session task list. The evals (pi/work/evals) showed that no model keeps a list from
// tool descriptions and guidelines alone, Claude or not, and that a nudge only works early; Claude Code's one reminder
// after ten turns came when the work was nearly done. So:
// - the early note: on the first top-level tool result of each run while no task is open, before the first edit;
// - the regular note: every EVERY assistant turns without a change of the list (and EVERY since the last note), one
//   line: the task in progress, or the next one, or that there is still no list.
// Both say what to do in the tool's own words and to ignore them for a question or a one-step change. Both are
// appended to a top-level tool result, so the cached prefix stays intact, and both stay quiet while the task tools
// are hidden (a focused goal keeps its own list). The counts come from the session branch, so a resumed session goes
// on where it was: a change of the list is a "work-tasks" entry, a note a tool result text that starts with MARK.
import { ENTRY, type Task } from "./state.ts";

export const EVERY = 3;
export const MARK = "[tasks]";

/** How the notes name the tools: TaskCreate, or tasks with action "create". */
export type Names = { create: string; update: string };

type Entry = { type?: string; customType?: string; message?: { role?: string; content?: unknown } };

const isNote = (entry: Entry) =>
  entry.message?.role === "toolResult" &&
  Array.isArray(entry.message.content) &&
  entry.message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(MARK));

/** Assistant messages since the last list change and since the last note, counted back from the leaf. */
export function turnsSince(branch: readonly unknown[]): { task: number; note: number } {
  let task = -1;
  let note = -1;
  let assistants = 0;
  for (let i = branch.length - 1; i >= 0 && (task < 0 || note < 0); i--) {
    const entry = (branch[i] ?? {}) as Entry;
    if (entry.type === "custom" && entry.customType === ENTRY && task < 0) task = assistants;
    else if (entry.type === "message" && entry.message?.role === "assistant") assistants++;
    else if (entry.type === "message" && note < 0 && isNote(entry)) note = assistants;
  }
  return { task: task < 0 ? assistants : task, note: note < 0 ? assistants : note };
}

const open = (tasks: readonly Task[]) => tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
const label = (t: Task) => `#${t.id} ${t.activeForm ?? t.subject}`;

/** The note at the start of a run while no task is open. */
export function early(names: Names): string {
  return `${MARK} No open tasks. If this request takes three or more steps (each changed file, test run or doc update counts), create one task per step now with ${names.create}, before your first edit, and set the first one in_progress with ${names.update}. If it is a question or a one-step change, ignore this.`;
}

/**
 * The regular note for the next top-level tool result, or null. finished: the list was changed in this run and has
 * no open task, so the work is done and the run is wrapping up.
 */
export function regular(branch: readonly unknown[], tasks: readonly Task[], names: Names, finished = false): string | null {
  const { task, note } = turnsSince(branch);
  if (task < EVERY || note < EVERY || finished) return null;
  const now = tasks.find((t) => t.status === "in_progress");
  const next = open(tasks).find((t) => t.status === "pending");
  if (now) return `${MARK} Now: ${label(now)} (in_progress). When it is done, set it completed and the next one in_progress with ${names.update}.`;
  if (next) return `${MARK} Nothing in_progress; next: ${label(next)}. Set it in_progress with ${names.update} before you work on it.`;
  return `${MARK} Still no open tasks after ${task} turns. If this work has three or more steps, create the list now with ${names.create}; if not, ignore this.`;
}

export { open as openTasks };
