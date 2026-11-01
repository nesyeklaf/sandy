// The RPC contract between server.ts and app.tsx.
import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

export { CONTEXT_CHANNEL, LIMITS_CHANNEL, USAGE_CHANNEL } from "./channels.js";

/** The page's longest range is a week; allow a little over for clock skew. */
export const MAX_WINDOW_MS = 9 * 24 * 3_600_000;

/** Limit readings are the base of the value estimate, so they outlive the page's range. */
export const LIMIT_SAMPLE_KEEP_MS = 400 * 24 * 3_600_000;

const tokens = {
  input: z.number(),
  cacheRead: z.number(),
  output: z.number(),
};

export const hourUsageSchema = z.object({ hour: z.number(), ...tokens });

export const threadUsageSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  providerId: z.string(),
  /** When it was archived or deleted; null while it is active. */
  archivedAt: z.number().nullable(),
  turns: z.number(),
  /** Its latest recorded context size, or null before any. */
  context: z.number().nullable(),
  /** Each of its finished turns that started in the window: when, and how long it took in milliseconds; oldest first. */
  turnTimes: z.array(z.object({ at: z.number(), ms: z.number() })).optional(),
  /** Its tokens per hour in the window, for its sparkline. */
  hours: z.array(z.object({ hour: z.number(), total: z.number() })),
  /** Its tokens over its whole life, as its header counts them; more than the window's when it ran before it. */
  lifetime: z.number().optional(),
  ...tokens,
});

/** How many of a thread's latest usage rows the header and its summary read. */
export const MAX_ROWS = 1_000;

export const usageAtSchema = z.object({ at: z.number(), ...tokens });

export const turnDetailSchema = z.object({
  turnId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  usageAt: z.number(),
  prompt: z.string().nullable(),
  /** Where the turn's time went, in milliseconds; null before timings were recorded or while it runs. */
  time: z.object({ model: z.number(), tools: z.number(), waiting: z.number() }).nullable().optional(),
  ...tokens,
});

const thresholdsSchema = z.object({ warning: z.number().nullable(), error: z.number().nullable() });

const splitSchema = z.object({ model: z.number(), tools: z.number(), waiting: z.number() });

/** Where the period's finished turns spent their time. See timeBreakdown. */
export const turnTimeSchema = z.object({
  turns: z.number(),
  split: splitSchema,
  kinds: z.array(z.object({ kind: z.string(), ms: z.number(), count: z.number() })),
  questions: z.number(),
  lengths: z.array(z.object({ turns: z.number(), split: splitSchema })),
  /** The shell commands that took the most time, grouped by commandKey. */
  commands: z.array(
    z.object({ command: z.string(), runs: z.number(), totalMs: z.number(), medianMs: z.number(), longestMs: z.number() }),
  ),
});

export type TurnTimeBreakdown = z.infer<typeof turnTimeSchema>;

/** A subscription's usage limit window and where it's headed. See limits.ts. */
export const limitSchema = z.object({
  providerId: z.string(),
  accountKey: z.string().nullable(),
  label: z.string(),
  kind: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number(),
  sampledAt: z.number(),
  pacePerHour: z.number().nullable(),
  projectedPercent: z.number().nullable(),
  runsOutAt: z.number().nullable(),
  tone: z.enum(["ok", "warning", "error"]),
  /** The provider's tokens in the past hour, for the chart's bars at this pace. */
  lastHourTokens: z.number(),
  /** A session's tokens in each 15 minutes since it began, oldest first, for the title bar's spark chart. */
  slots: z.array(z.number()).optional(),
  /** About how many tokens the whole window holds; null while there's too little to tell; absent when it can't be told. See sizeOf. */
  sizeTokens: z.number().nullable().optional(),
});

export type Limit = z.infer<typeof limitSchema>;

const valueSummarySchema = z.object({
  percent: z.number(),
  costUsd: z.number(),
  usdPerPercent: z.number().nullable(),
  steps: z.number(),
  skipped: z.number(),
  /** Dollars by host id; "" is a turn whose host was not recorded. */
  hostCost: z.record(z.string(), z.number()),
});

/** What 1% of one account's limit is worth, for one kind of window. See value.ts. */
export const valueSeriesSchema = z.object({
  providerId: z.string(),
  accountKey: z.string().nullable(),
  kind: z.string(),
  total: valueSummarySchema,
  windows: z.array(z.object({ resetsAt: z.number(), summary: valueSummarySchema })),
  steps: z.array(
    z.object({
      from: z.number(),
      to: z.number(),
      fromPercent: z.number(),
      toPercent: z.number(),
      percent: z.number(),
      costUsd: z.number(),
      tokens: z.number(),
      turns: z.number(),
      unpricedTurns: z.number(),
      hostCost: z.record(z.string(), z.number()),
    }),
  ),
});

export type ValueSeriesView = z.infer<typeof valueSeriesSchema>;

export const rpcContract = defineRpcContract({
  /** What 1% of each subscription limit is worth since `since`, from the readings and the turns priced at list price. */
  value_report: {
    input: z.object({ since: z.number().int().nonnegative() }),
    output: z.object({
      series: z.array(valueSeriesSchema),
      /** Models seen in turns that have no price, with their turn counts; their steps are left out. */
      unpricedModels: z.array(z.object({ model: z.string(), turns: z.number() })),
      /** Lines of the prices setting that could not be read. */
      invalidPrices: z.array(z.string()),
      recordingSince: z.number(),
    }),
  },
  /**
   * Model calls a Pi process reports as it makes them, in the shape of its session file's lines
   * (see pi-extension/value-calls.ts). `known` is false while sandy has no Pi thread with that id yet.
   */
  value_ingest: {
    input: z.object({
      threadId: z.string().min(1),
      /** The session file's name without .jsonl, used to build call keys when a call has no response id. */
      file: z.string().min(1).max(200),
      lines: z.array(z.string().max(20_000)).max(1000),
    }),
    output: z.object({ known: z.boolean(), added: z.number() }),
  },
  /** Each subscription's limits from the latest reading, for the meters above the chart. */
  usage_limits: {
    input: z.null(),
    output: z.object({
      limits: z.array(limitSchema),
      /** When the providers were last read; null before the first reading. */
      polledAt: z.number().nullable(),
      /** Why the last reading failed, if it did. */
      error: z.string().nullable(),
    }),
  },
  usage_window: {
    input: z.object({ since: z.number().int().nonnegative() }),
    output: z.object({
      hours: z.array(hourUsageSchema),
      threads: z.array(threadUsageSchema),
      /** When this plugin started recording; earlier hours may be missing turns. */
      recordingSince: z.number(),
      /** The context warning and error settings in tokens; null when one is off. */
      contextThresholds: thresholdsSchema,
      turnTime: turnTimeSchema,
    }),
  },
  thread_usage: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({
      input: z.number(),
      cacheRead: z.number(),
      output: z.number(),
      total: z.number(),
      turns: z.number(),
      /** The latest usage rows, up to MAX_ROWS, oldest first, subagents' calls included. */
      recent: z.array(usageAtSchema),
      /** Claude Code subagents the thread ran and the tokens they used, which sandy does not report. */
      subagents: z.object({ count: z.number(), tokens: z.number() }),
    }),
  },
  /** The thread's usage by turn, with the message that began each. Reads sandy, so it runs when the summary opens. */
  thread_turns: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ turns: z.array(turnDetailSchema) }),
  },
  /**
   * The thread's latest context size and the warning setting, for the meter
   * above the composer. Null `context` means none recorded yet.
   */
  thread_context: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({
      context: z
        .object({
          usedTokens: z.number(),
          contextWindow: z.number().nullable(),
          autoCompactAt: z.number().nullable(),
          at: z.number(),
        })
        .nullable(),
      /** Tokens the thread's latest recorded turn used. */
      lastTurn: z.number().nullable(),
      /** The context warning and error settings in tokens; null when one is off. */
      thresholds: thresholdsSchema,
      /** Archived or deleted threads get no meter. */
      archived: z.boolean(),
    }),
  },
  /** How many active threads have their latest context past the warning setting, and past the error one, for the sidebar. */
  context_levels: {
    input: z.null(),
    output: z.object({ warning: z.number(), error: z.number() }),
  },
  /** Asks sandy to compact the thread, which runs /compact as a turn. Only an idle or errored thread can. */
  compact_thread: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ ok: z.literal(true) }),
  },
});

export type HourUsage = z.infer<typeof hourUsageSchema>;
export type ThreadUsage = z.infer<typeof threadUsageSchema>;
export type UsageAt = z.infer<typeof usageAtSchema>;
export type TurnDetail = z.infer<typeof turnDetailSchema>;
