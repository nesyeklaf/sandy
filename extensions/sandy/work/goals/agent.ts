// Host side: where pi keeps its agent dir, the thread pointer the pi extension writes,
// and the snapshot the banner and tab render. Reads only.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ReadInput, Snapshot } from "./contract.ts";
import { audits, goalRoot, readArchived, readLedger, readPool, sessionActivity, sessionFocus, sessionTasks, toEvents } from "./goals.ts";

export const agentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
export interface Pointer {
  cwd: string;
  sessionFile: string | null;
  agentDir: string;
  env: Record<string, string>;
}

export function readPointer(agent: string, threadId: string): Pointer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return null;
  try {
    const value = JSON.parse(readFileSync(path.join(agent, "sandy-goals", `${threadId}.json`), "utf8"));
    if (typeof value?.cwd !== "string") return null;
    return {
      cwd: value.cwd,
      sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
      agentDir: typeof value.agentDir === "string" ? value.agentDir : agent,
      env: value.env && typeof value.env === "object" ? value.env : {},
    };
  } catch {
    return null;
  }
}

/** The thread's focused goal and the auditor's latest verdict on goalId (default: the focused one). */
export function goalLink(agent: string, input: { threadId: string; cwd: string; goalId?: string }): { focusedId: string | null; goalId: string | null; verdict: string; at: string | null } {
  const focusedId = snapshot(agent, { threadId: input.threadId, cwd: input.cwd, archivedLimit: 0, eventLimit: 0 }).focusedId;
  const goalId = input.goalId ?? focusedId;
  if (!goalId) return { focusedId, goalId: null, verdict: "none", at: null };
  const pointer = readPointer(agent, input.threadId);
  const cwd = pointer?.cwd ?? input.cwd;
  const root = goalRoot(cwd, { ...process.env, ...(pointer?.env ?? {}) }, pointer?.agentDir ?? agent);
  const audit = audits(readLedger(root)).get(goalId);
  return { focusedId, goalId, verdict: audit?.verdict ?? "none", at: audit?.at ?? null };
}

export function snapshot(agent: string, input: ReadInput): Snapshot {
  const pointer = readPointer(agent, input.threadId);
  const cwd = pointer?.cwd ?? input.cwd;
  const empty: Snapshot = { root: null, linked: pointer !== null, focusedId: null, goals: [], archived: [], events: [], sessionTasks: [], sessionActivity: null, error: null };
  if (!cwd) return { ...empty, error: "no working directory for this thread" };
  try {
    const root = goalRoot(cwd, { ...process.env, ...(pointer?.env ?? {}) }, pointer?.agentDir ?? agent);
    const goals = readPool(root);
    const ledger = readLedger(root);
    const verdicts = audits(ledger);
    for (const goal of goals) goal.audit = verdicts.get(goal.id) ?? null;
    const focus = pointer?.sessionFile ? sessionFocus(pointer.sessionFile) : undefined;
    const focusedId = focus === undefined ? (goals[0]?.id ?? null) : focus && goals.some((g) => g.id === focus) ? focus : null;
    return {
      ...empty,
      root: existsSync(root) ? root : null,
      focusedId,
      goals,
      archived: readArchived(root, input.archivedLimit),
      events: toEvents(ledger, input.eventLimit),
      sessionTasks: pointer?.sessionFile ? sessionTasks(pointer.sessionFile) : [],
      sessionActivity: pointer?.sessionFile ? sessionActivity(pointer.sessionFile) : null,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}
