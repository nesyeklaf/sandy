import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const task: z.ZodType<Task> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["pending", "complete", "skipped"]),
      evidence: z.string().nullable(),
      skipReason: z.string().nullable(),
      verificationContract: z.string().nullable(),
      completedAt: z.string().nullable(),
      subtasks: z.array(task),
    })
    .strict(),
);

export interface Task {
  id: string;
  title: string;
  status: "pending" | "complete" | "skipped";
  evidence: string | null;
  skipReason: string | null;
  verificationContract: string | null;
  completedAt: string | null;
  subtasks: Task[];
}

/** One task of the session's own list (pi/work tasks tool), kept as "work-tasks" entries in the pi session. */
const sessionTask = z
  .object({
    id: z.string(),
    subject: z.string(),
    /** Deleted tasks (tombstones) are left out. */
    status: z.enum(["pending", "in_progress", "completed"]),
    description: z.string().nullable(),
    /** The present-continuous label the agent gives a task in progress, e.g. "writing tests". */
    activeForm: z.string().nullable(),
    parent: z.string().nullable(),
    blockedBy: z.array(z.string()),
  })
  .strict();

/** The tool call the agent is running right now, from the end of the pi session file. */
const sessionActivity = z
  .object({
    /** Tool name without the mcp__server__ prefix. */
    tool: z.string(),
    /** Short English description, e.g. "Editing app.tsx". */
    label: z.string(),
    /** When the call started (ISO). */
    since: z.string(),
  })
  .strict();

/** The auditor's latest word on a goal, from the ledger. */
const audit = z
  .object({
    verdict: z.enum(["approved", "disapproved", "error", "running", "skipped"]),
    report: z.string().nullable(),
    at: z.string(),
  })
  .strict();

/** One open goal as pi-goal-x stores it (active_goal_*.md). */
const goal = z
  .object({
    id: z.string(),
    objective: z.string(),
    status: z.enum(["active", "paused", "blocked", "budget_limited", "complete"]),
    autoContinue: z.boolean(),
    sisyphus: z.boolean(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    tokensUsed: z.number(),
    activeSeconds: z.number(),
    tokenBudget: z.number().nullable(),
    pauseReason: z.string().nullable(),
    pauseSuggestedAction: z.string().nullable(),
    stopReason: z.string().nullable(),
    currentTaskId: z.string().nullable(),
    verificationContract: z.string().nullable(),
    skipAuditor: z.boolean(),
    blockCompletion: z.boolean().nullable(),
    tasks: z.array(task),
    audit: audit.nullable(),
  })
  .strict();

const archived = z
  .object({
    id: z.string(),
    objective: z.string(),
    status: z.string(),
    updatedAt: z.string().nullable(),
    tokensUsed: z.number(),
    activeSeconds: z.number(),
    taskCount: z.number(),
    tasksDone: z.number(),
  })
  .strict();

const event = z
  .object({
    type: z.string(),
    goalId: z.string().nullable(),
    at: z.string(),
    text: z.string(),
    tone: z.enum(["neutral", "good", "warn", "bad", "info"]),
  })
  .strict();

/**
 * Everything the banner and the tab show for one thread.
 * focusedId: the goal this pi session works on (its pi-goal-focus entry); null when it focused none,
 * and the first open goal when the session never chose (pi-goal-x does the same on start).
 */
const snapshot = z
  .object({
    root: z.string().nullable(),
    linked: z.boolean(),
    focusedId: z.string().nullable(),
    goals: z.array(goal),
    archived: z.array(archived),
    events: z.array(event),
    /** The session's task list (latest work-tasks entry); empty when the thread is not linked or keeps none. */
    sessionTasks: z.array(sessionTask),
    /** The open tool call of the session; null when none is open. The banner shows it only while the thread runs. */
    sessionActivity: sessionActivity.nullable(),
    error: z.string().nullable(),
  })
  .strict();

const read = z
  .object({
    threadId: z.string().min(1),
    /** Fallback when the pi extension has not linked the thread yet: the environment's checkout. */
    cwd: z.string(),
    archivedLimit: z.number().int().min(0).max(100),
    eventLimit: z.number().int().min(0).max(200),
  })
  .strict();

const goalLink = z.object({ threadId: z.string().min(1), cwd: z.string(), goalId: z.string().min(1).optional() }).strict();

/** Host RPC: goal files live on the machine pi runs on. */
export const hostContract = defineRpcContract({
  read: { input: read, output: snapshot },
  /**
   * For the track part: the goal the thread's pi session focuses (goalId null when none) and, for goalId (default:
   * that focused goal), the auditor's latest verdict from the ledger, so it survives the goal's archiving.
   * verdict "none": the auditor never ran on it.
   */
  goalLink: {
    input: goalLink,
    output: z.object({ focusedId: z.string().nullable(), goalId: z.string().nullable(), verdict: z.string(), at: z.string().nullable() }).strict(),
  },
});

const threadId = z.object({ threadId: z.string().min(1) }).strict();

import { COMMANDS, VIEWS, type View } from "./views.ts";

export { COMMANDS, VIEWS, type View };
const viewKeys = Object.keys(VIEWS) as [View, ...View[]];

/** Frontend RPC. */
export const rpcContract = defineRpcContract({
  snapshot: {
    input: threadId.extend({ archivedLimit: z.number().int().min(0).max(100), eventLimit: z.number().int().min(0).max(200) }).strict(),
    output: snapshot,
  },
  /** Sends a pi-goal-x slash command into the thread; it steers a running turn so pause lands at once. */
  command: {
    input: threadId.extend({ command: z.enum(COMMANDS), arg: z.string().regex(/^[A-Za-z0-9_.:-]*$/).max(200).optional() }).strict(),
    output: z.object({ sent: z.string() }).strict(),
  },
  /** Switches banner lines and tab sections on or off from the tab. */
  setView: { input: z.object({ view: z.enum(viewKeys), on: z.boolean() }).strict(), output: z.object({}).strict() },
});

export type Goal = z.infer<typeof goal>;
export type Audit = z.infer<typeof audit>;
export type Archived = z.infer<typeof archived>;
export type GoalEvent = z.infer<typeof event>;
export type Snapshot = z.infer<typeof snapshot>;
export type SessionTask = z.infer<typeof sessionTask>;
export type SessionActivity = z.infer<typeof sessionActivity>;
export type ReadInput = z.infer<typeof read>;
