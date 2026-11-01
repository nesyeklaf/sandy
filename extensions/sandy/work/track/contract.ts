import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

/** Runs on the thread's host: writes the guard's policy file and runs check commands. */
export const hostContract = defineRpcContract({
  /** written false: the file on disk has a newer rev (graft 3: a policy never goes back to an older rev). */
  writePolicy: {
    input: z.object({ threadId: z.string().min(1), policy: z.record(z.string(), z.unknown()) }).strict(),
    output: z.object({ path: z.string(), written: z.boolean() }).strict(),
  },
  runCheck: {
    input: z
      .object({ command: z.string().min(1), cwd: z.string().min(1), timeoutSec: z.number().int().min(1).max(1800) })
      .strict(),
    output: z.object({ exitCode: z.number().nullable(), output: z.string(), timedOut: z.boolean() }).strict(),
  },
});

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const autopilotSchema = z.object({ kind: z.literal("autopilot"), name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), args: z.string().max(500).optional() }).strict();
const driverSchema = z.union([z.object({ kind: z.literal("agent") }).strict(), autopilotSchema]);
/** ok false: the run refused the change; message says why. */
const result = z.object({ ok: z.boolean(), message: z.string().optional() });

/** UI <-> server. state returns the run as JSON (see run.ts Run) or null. */
export const rpcContract = defineRpcContract({
  state: {
    input: threadInput,
    output: z.object({ run: z.unknown().nullable(), policyError: z.string().nullable() }),
  },
  setPaused: {
    input: z.object({ threadId: z.string().min(1), paused: z.boolean() }).strict(),
    output: result,
  },
  /** A manual stage switch: a new visit of to, driven by its configured driver. */
  force: {
    input: z.object({ threadId: z.string().min(1), to: z.string().min(1), note: z.string().max(500).optional() }).strict(),
    output: result,
  },
  /** Who drives: the whole track (scope track) or one stage. default returns to the template. */
  setDriver: {
    input: z
      .object({ threadId: z.string().min(1), scope: z.enum(["track", "stage"]), stage: z.string().min(1).optional(), choice: z.union([driverSchema, z.literal("default")]) })
      .strict(),
    output: result,
  },
  abort: {
    input: z.object({ threadId: z.string().min(1), reason: z.string().max(500).optional() }).strict(),
    output: result,
  },
});

export const RUN_CHANGED = "run-changed";
