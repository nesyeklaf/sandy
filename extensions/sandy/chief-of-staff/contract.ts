// The wire contract between server.ts and app.tsx. app.tsx imports only types.
import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

export const ITEM_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_chief",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Who currently owns an open question; closed questions are answered or dropped. */
export const QUESTION_STATUSES = ["chief", "user", "answered", "dropped"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/**
 * ask: the worker called cos_ask. checkin: the worker stopped without asking
 * or finishing. prompt: the worker waits on a native prompt inside its thread.
 */
export const QUESTION_KINDS = ["ask", "checkin", "prompt"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

const itemSchema = z.object({
  id: z.number(),
  title: z.string(),
  details: z.string(),
  projectId: z.string(),
  status: z.enum(ITEM_STATUSES),
  threadId: z.string().nullable(),
  summary: z.string().nullable(),
  lastUpdate: z.string().nullable(),
  nudges: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Item = z.infer<typeof itemSchema>;

const questionSchema = z.object({
  id: z.number(),
  itemId: z.number(),
  itemTitle: z.string(),
  threadId: z.string().nullable(),
  kind: z.enum(QUESTION_KINDS),
  question: z.string(),
  context: z.string(),
  options: z.array(z.string()),
  status: z.enum(QUESTION_STATUSES),
  why: z.string().nullable(),
  recommendation: z.string().nullable(),
  answer: z.string().nullable(),
  answeredBy: z.enum(["chief", "user"]).nullable(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});
export type Question = z.infer<typeof questionSchema>;

const activitySchema = z.object({
  id: z.number(),
  itemId: z.number().nullable(),
  text: z.string(),
  at: z.number(),
});
export type Activity = z.infer<typeof activitySchema>;

const overviewSchema = z.object({
  items: z.array(itemSchema),
  decisions: z.array(questionSchema),
  answeredByChief: z.number(),
  activity: z.array(activitySchema),
  paused: z.boolean(),
  guidance: z.string(),
  chiefThreadId: z.string().nullable(),
  lastProjectId: z.string().nullable(),
  maxConcurrent: z.number(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const ITEM_ACTIONS = ["cancel", "retry", "remove"] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: overviewSchema },
  projects: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  add_backlog: {
    input: z.object({
      text: z.string().min(1).max(50_000),
      projectId: z.string().min(1),
    }),
    output: z.object({ added: z.array(itemSchema) }),
  },
  decide: {
    input: z.object({
      questionId: z.number(),
      answer: z.string().trim().min(1).max(10_000),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  item_action: {
    input: z.object({ itemId: z.number(), action: z.enum(ITEM_ACTIONS) }),
    output: z.object({ ok: z.literal(true) }),
  },
  set_paused: {
    input: z.object({ paused: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  set_guidance: {
    input: z.object({ text: z.string().max(10_000) }),
    output: z.object({ ok: z.literal(true) }),
  },
  brief: { input: z.null(), output: z.object({ markdown: z.string() }) },
});

/** Realtime channel: the server publishes after every state change. */
export const CHANGED_CHANNEL = "cos-changed";
