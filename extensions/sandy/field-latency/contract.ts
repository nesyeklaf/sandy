import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const ms = z.number().min(0).max(600000);

const scrollSchema = z
  .object({
    durationMs: ms,
    frames: z.number().int().min(0).max(100000),
    dropped: z.number().int().min(0).max(100000),
    refreshMs: z.number().min(0).max(1000),
    p95FrameMs: ms,
    maxFrameMs: ms,
    smoothnessPct: z.number().min(0).max(100),
    truncated: z.boolean(),
  })
  .strict();

const script = z
  .object({
    source: z.string().max(200),
    invoker: z.string().max(200),
    durationMs: ms,
    forcedStyleLayoutMs: ms,
  })
  .strict();

export const sampleSchema = z
  .object({
    kind: z.enum(["open", "switch", "slow", "scroll"]),
    label: z.string().max(120),
    at: z.number().int(),
    path: z.string().max(300),
    threadId: z.string().max(80).nullable(),
    visit: z.enum(["first", "revisit"]).nullable(),
    overlay: z.string().max(80).nullable(),
    mountMs: ms.nullable(),
    readyMs: ms.nullable(),
    settledMs: ms.nullable(),
    timedOut: z.boolean(),
    eventMs: ms.nullable(),
    inputDelayMs: ms.nullable(),
    processingMs: ms.nullable(),
    presentationMs: ms.nullable(),
    frameMs: ms,
    blockingMs: ms,
    styleLayoutMs: ms,
    scripts: z.array(script).max(5),
    domNodes: z.number().int().min(0),
    tracedMs: ms.nullable().default(null),
    phases: z.record(z.string().max(40), ms).nullable().default(null),
    scroll: scrollSchema.nullable().default(null),
  })
  .strict();

export const clientSchema = z
  .object({
    userAgent: z.string().max(400),
    cores: z.number().int().min(0).max(1024),
    devicePixelRatio: z.number().min(0).max(16),
    viewport: z.string().max(40),
    deviceMemoryGb: z.number().min(0).max(4096).nullable().default(null),
    effectiveType: z.string().max(20).nullable().default(null),
    sandyVersion: z.string().max(80).nullable().default(null),
    appScript: z.string().max(80).nullable().default(null),
    benchmarkIndex: z.number().min(0).max(1000000).nullable().default(null),
  })
  .strict();

export const rpcContract = defineRpcContract({
  record: {
    input: z.object({ client: clientSchema, samples: z.array(sampleSchema).min(1).max(200) }).strict(),
    output: z.object({ stored: z.number().int() }).strict(),
  },
});

export type ScrollStats = z.output<typeof scrollSchema>;
export type Sample = z.output<typeof sampleSchema>;
export type Client = z.output<typeof clientSchema>;

export const AUTOMATED_USER_AGENT_MARKER = "HeadlessChrome";

export function isAutomatedBrowser(userAgent: string, webdriver: boolean): boolean {
  return webdriver || userAgent.includes(AUTOMATED_USER_AGENT_MARKER);
}
