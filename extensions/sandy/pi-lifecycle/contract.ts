import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

/** What the pi-side extension reports about one pi process; null when it is not loaded in that process. */
const hook = z
  .object({
    /** Start time the extension recorded for its process; requestReload checks it to tell processes on a reused pid apart. */
    startedAt: z.number(),
    lastLoadAt: z.number(),
    reason: z.string(),
    lastReloadAt: z.number().nullable(),
    reloadCount: z.number(),
    reloadPending: z.boolean(),
  })
  .strict();

/** One loaded pi process (a SANDY session) as the host sees it. */
const proc = z
  .object({
    threadId: z.string(),
    pid: z.number(),
    startedAt: z.number(),
    rssBytes: z.number(),
    cpuPercent: z.number(),
    children: z.number(),
    hook: hook.nullable(),
  })
  .strict();

const scan = z.object({ extensionInstalled: z.boolean(), processes: z.array(proc) }).strict();

/** Host RPC: only the host process can read /proc and pi's state directory on its machine. */
export const hostContract = defineRpcContract({
  scan: { input: z.object({}).strict(), output: scan },
  requestReload: {
    /** startedAt: hook.startedAt from the scan */
    input: z.object({ targets: z.array(z.object({ pid: z.number(), startedAt: z.number() }).strict()) }).strict(),
    output: z.object({ requested: z.number() }).strict(),
  },
  install: { input: z.object({}).strict(), output: z.object({ path: z.string() }).strict() },
});

export type Hook = z.infer<typeof hook>;
export type Proc = z.infer<typeof proc>;
export type HostScan = z.infer<typeof scan>;

const session = proc
  .extend({ title: z.string().nullable(), status: z.string().nullable() })
  .strict();

const hostView = z
  .object({
    hostId: z.string(),
    name: z.string(),
    error: z.string().nullable(),
    extensionInstalled: z.boolean(),
    sessions: z.array(session),
  })
  .strict();

const one = z
  .object({ hostId: z.string().nullable(), session: session.nullable(), extensionInstalled: z.boolean() })
  .strict();

const count = z.object({ count: z.number() }).strict();
const threadId = z.object({ threadId: z.string().min(1) }).strict();
const hostId = z.object({ hostId: z.string().min(1) }).strict();

/** Server RPC used by the composer popup and the overview page. */
export const rpcContract = defineRpcContract({
  hosts: { input: z.object({}).strict(), output: z.object({ hosts: z.array(hostView) }).strict() },
  session: { input: threadId, output: one },
  restart: { input: threadId.extend({ force: z.boolean().optional() }).strict(), output: z.object({}).strict() },
  reload: { input: threadId, output: z.object({}).strict() },
  restartHost: { input: hostId.extend({ includeRunning: z.boolean() }).strict(), output: count },
  reloadHost: { input: hostId, output: count },
  install: { input: hostId, output: z.object({ path: z.string() }).strict() },
});

export type SessionView = z.infer<typeof session>;
export type HostView = z.infer<typeof hostView>;
export type OneView = z.infer<typeof one>;
