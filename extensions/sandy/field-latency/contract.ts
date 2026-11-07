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

export const PRESSURE_STATES = ["nominal", "fair", "serious", "critical"] as const;

const loadSchema = z
  .object({
    windowMs: ms,
    busyPct: z.number().min(0).max(100).nullable(),
    maxLagMs: ms.nullable(),
    pressure: z.enum(PRESSURE_STATES).nullable(),
    charging: z.boolean().nullable(),
    batteryPct: z.number().min(0).max(100).nullable(),
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
    contentDoneMs: ms.nullable().default(null),
    contentDone: z.enum(["settled", "capped", "aborted"]).nullable().default(null),
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
    load: loadSchema.nullable().default(null),
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
    deviceId: z.string().min(8).max(64).nullable().default(null),
    platform: z.string().max(80).nullable().default(null),
    screen: z.string().max(20).nullable().default(null),
    refreshMs: z.number().min(0).max(1000).nullable().default(null),
    gpu: z.string().max(200).nullable().default(null),
  })
  .strict();

const recordInput = z.object({ client: clientSchema, samples: z.array(sampleSchema).min(1).max(200) }).strict();

export const rpcContract = defineRpcContract({
  record: {
    input: recordInput,
    output: z.object({ stored: z.number().int() }).strict(),
  },
});

export type ScrollStats = z.output<typeof scrollSchema>;
export type Sample = z.output<typeof sampleSchema>;
export type Load = z.output<typeof loadSchema>;
export type Client = z.output<typeof clientSchema>;
export type RecordInput = z.input<typeof recordInput>;

export function toWire(sample: Sample): z.input<typeof sampleSchema> {
  const { contentDoneMs, contentDone, load, ...rest } = sample;
  const withContent = contentDone === null && contentDoneMs === null ? rest : { ...rest, contentDoneMs, contentDone };
  return load === null ? withContent : { ...withContent, load };
}

const NEW_CLIENT_KEYS = ["deviceId", "platform", "screen", "refreshMs", "gpu"] as const;

export function toClientWire(client: Client): z.input<typeof clientSchema> {
  const wire: z.input<typeof clientSchema> = { ...client };
  for (const key of NEW_CLIENT_KEYS) if (wire[key] === null) delete wire[key];
  return wire;
}

export function toLegacyWire(client: Client, samples: readonly Sample[]): RecordInput {
  const legacyClient: z.input<typeof clientSchema> = { ...client };
  for (const key of NEW_CLIENT_KEYS) delete legacyClient[key];
  return {
    client: legacyClient,
    samples: samples.map((sample) => {
      const { load: _load, ...wire } = toWire(sample);
      return wire;
    }),
  };
}

function rpcRejection(error: unknown): { code: string; messages: string[] } | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string") return null;
  const issues: unknown = Reflect.get(error, "issues");
  const messages: string[] = [];
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const message: unknown = typeof issue === "object" && issue !== null ? Reflect.get(issue, "message") : undefined;
      if (typeof message === "string") messages.push(message);
    }
  }
  return { code, messages };
}

export function isInvalidInput(error: unknown): boolean {
  return rpcRejection(error)?.code === "invalid_input";
}

export function isUnknownKeyRejection(error: unknown): boolean {
  const rejection = rpcRejection(error);
  return rejection?.code === "invalid_input" && rejection.messages.some((message) => /unrecognized key/i.test(message));
}

export const AUTOMATED_USER_AGENT_MARKER = "HeadlessChrome";

export function isAutomatedBrowser(userAgent: string, webdriver: boolean): boolean {
  return webdriver || userAgent.includes(AUTOMATED_USER_AGENT_MARKER);
}
