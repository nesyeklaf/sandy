import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

export const socketRowSchema = z.object({
  seq: z.number().int().positive(),
  pid: z.number().int(),
  startTime: z.number().int(),
  comm: z.string(),
  inode: z.number().int(),
  proto: z.enum(["tcp", "udp"]),
  localIp: z.string(),
  localPort: z.number().int(),
  remoteIp: z.string(),
  remotePort: z.number().int(),
  tcpState: z.number().int(),
  localListening: z.boolean(),
  continued: z.boolean(),
  sampledAt: z.number(),
});
export type SocketRow = z.infer<typeof socketRowSchema>;

export const sampleGapSchema = z.object({
  id: z.number().int(),
  start: z.number(),
  end: z.number(),
  reason: z.string(),
});
export type SampleGap = z.infer<typeof sampleGapSchema>;

export const sampleReplySchema = z.object({
  supported: z.literal(true),
  generation: z.string(),
  cursor: z.number().int(),
  gapCursor: z.number().int(),
  reset: z.boolean(),
  more: z.boolean(),
  rows: z.array(socketRowSchema),
  gaps: z.array(sampleGapSchema),
  sampledAt: z.number().nullable(),
  hostNow: z.number(),
  treeSize: z.number().int(),
  unreadablePids: z.number().int(),
  rootPid: z.number().int(),
});
export type SampleReply = Omit<z.infer<typeof sampleReplySchema>, "supported">;

export const hostConnectionsContract = defineRpcContract({
  sample: {
    input: z
      .object({
        generation: z.string().nullable(),
        cursor: z.number().int().nonnegative(),
        gapCursor: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.discriminatedUnion("supported", [
      sampleReplySchema,
      z.object({ supported: z.literal(false), platform: z.string() }),
    ]),
  },
});

export const OVERVIEW_WINDOWS = ["1h", "24h", "7d"] as const;
export const OVERVIEW_TAG = "overview";

export const connectionStateSchema = z.enum([
  "allowed",
  "inferred",
  "yellow",
  "red",
  "unverifiable",
  "undetermined",
  "third-party",
]);

export const overviewRowSchema = z.object({
  key: z.string(),
  sourceId: z.string(),
  direction: z.enum(["out", "in", "undetermined"]),
  proto: z.enum(["tcp", "udp"]),
  port: z.number().int(),
  hostname: z.string().nullable(),
  ip: z.string(),
  state: connectionStateSchema,
  reason: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  count: z.number().int(),
  attributions: z.array(
    z.object({
      pid: z.number().int(),
      startTime: z.number(),
      comm: z.string(),
    }),
  ),
});
export type OverviewRow = z.infer<typeof overviewRowSchema>;

export const sourceHealthSchema = z.object({
  sourceId: z.string(),
  label: z.string(),
  collector: z.enum(["fresh", "stale", "unknown"]),
  transport: z.enum(["fresh", "stale", "disconnected"]),
  supported: z.boolean(),
  treeSize: z.number().int(),
  unreadablePids: z.number().int(),
  error: z.string().nullable(),
});

export const overviewSchema = z.object({
  now: z.number(),
  since: z.number(),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  problems: z.array(z.string()),
  counts: z.record(z.string(), z.number().int()),
  sources: z.array(sourceHealthSchema),
  gaps: z.array(
    z.object({
      sourceId: z.string(),
      start: z.number(),
      end: z.number(),
      reason: z.string(),
    }),
  ),
  capReached: z.boolean(),
  notMeasured: z.array(z.string()),
  totalRows: z.number().int(),
  rows: z.array(overviewRowSchema),
});
export type Overview = z.infer<typeof overviewSchema>;

export const connectionOverviewContract = defineRpcContract({
  "overview.get": {
    input: z.object({ window: z.enum(OVERVIEW_WINDOWS) }).strict(),
    output: overviewSchema,
    tags: () => [OVERVIEW_TAG],
  },
});
