import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

export const MODES = ["ask", "auto", "yolo"] as const;

const policy = z
  .object({
    mode: z.enum(MODES),
    readOnly: z.boolean(),
    programs: z.array(z.string().min(1)),
    allow: z.array(z.string().min(1)),
  })
  .strict();

const state = z
  .object({
    path: z.string(),
    mode: z.string().nullable(),
    readOnly: z.boolean().nullable(),
    programs: z.array(z.string()).nullable(),
    allow: z.array(z.string()).nullable(),
  })
  .strict();

/** Host RPC: the host process owns the pi config file on its machine. */
export const hostContract = defineRpcContract({
  apply: { input: policy, output: z.object({ path: z.string() }).strict() },
  read: { input: z.object({}).strict(), output: state },
});

export type Policy = z.infer<typeof policy>;
export type PolicyState = z.infer<typeof state>;

const view = z
  .object({
    mode: z.enum(MODES),
    readOnly: z.boolean(),
    programs: z.array(z.string()),
    allow: z.array(z.string()),
  })
  .strict();

/** Server RPC used by the composer popup. The mode is global for pi on the host, not per thread. */
export const rpcContract = defineRpcContract({
  state: { input: z.object({}).strict(), output: view },
  setMode: { input: z.object({ mode: z.enum(MODES) }).strict(), output: view },
  setReadOnly: { input: z.object({ readOnly: z.boolean() }).strict(), output: view },
});

export type PermissionView = z.infer<typeof view>;
