// Host entry: runs on the host of the thread (where pi and the track-guard extension run).
// It owns the policy file the guard reads (contract: POLICY.md) and runs gate check commands.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { hostContract } from "./contract.ts";

const OUTPUT_TAIL = 8000;

function stateDir(): string {
  return process.env.TRACK_STATE_DIR || join(homedir(), ".local", "state", "sandy-track");
}

/** Per policy path: the tail of its compare-and-write chain. Writes of one thread never interleave. */
const policyWrites = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, job: () => Promise<T>): Promise<T> {
  const result = (policyWrites.get(path) ?? Promise.resolve()).then(job, job);
  const tail = result.catch(() => {});
  policyWrites.set(path, tail);
  void tail.then(() => {
    if (policyWrites.get(path) === tail) policyWrites.delete(path);
  });
  return result;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    writePolicy: async ({ threadId, policy }) => {
      if (!/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error("invalid thread id");
      const dir = join(stateDir(), "threads");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${threadId}.json`);
      // Graft 3: never replace a newer rev (a late write of an older commit). Files without rev (v1) are older.
      // Compare and write are one step per thread (serialized); each write renames its own temporary file.
      return serialized(path, async () => {
        const onDisk = await readFile(path, "utf8").then((text) => JSON.parse(text) as { rev?: unknown }, () => null);
        const rev = typeof policy.rev === "number" ? policy.rev : 0;
        if (onDisk !== null && typeof onDisk.rev === "number" && onDisk.rev > rev) return { path, written: false };
        const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(policy, null, 2), { mode: 0o600 });
          await rename(tmp, path);
        } catch (error) {
          await rm(tmp, { force: true });
          throw error;
        }
        return { path, written: true };
      });
    },
    runCheck: ({ command, cwd, timeoutSec }, context) =>
      new Promise((resolve, reject) => {
        const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let timedOut = false;
        const append = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        }, timeoutSec * 1000);
        const onAbort = () => child.kill("SIGTERM");
        context.signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          resolve({ exitCode: code, output, timedOut });
        });
      }),
  },
});
