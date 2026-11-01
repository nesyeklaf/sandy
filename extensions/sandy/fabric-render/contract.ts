import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const audit = z
  .object({
    ref: z.string(),
    tool: z.string().optional(),
    provider: z.string().optional(),
    success: z.boolean().optional(),
    error: z.string().optional(),
    args: z.record(z.string(), z.string()).optional(),
    result: z.string().optional(),
    resultTruncated: z.boolean().optional(),
    diff: z.string().optional(),
    content: z.string().optional(),
    lines: z.number().optional(),
    command: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().optional(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
  })
  .strict();

/** One fabric_exec call of a session, from the render entry when pi wrote one, else from the tool call alone. */
const exec = z
  .object({
    itemId: z.string(),
    startSeq: z.number(),
    at: z.number(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    codeHead: z.string(),
    code: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    /** "entry" = rich audits from the fabric-render entry; "call" = only the tool call's own arguments and result. */
    source: z.enum(["entry", "call"]),
    phases: z.array(z.string()),
    auditCount: z.number(),
    truncated: z.boolean(),
    audits: z.array(audit),
    resultText: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  execs: {
    input: z.object({ threadId: z.string(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    output: z.object({ execs: z.array(exec), withEntry: z.number() }).strict(),
  },
});

export type Exec = z.infer<typeof exec>;
export type ExecAudit = z.infer<typeof audit>;
