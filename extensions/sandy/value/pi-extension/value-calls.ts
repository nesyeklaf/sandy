// Pi extension: reports every model call this Pi process makes to the sandy "value" plugin.
// sandy's own usage event holds only the last call of a turn; Pi sees each call, with the cost it
// worked out, in message_end. Calls are batched, sent with `sandy plugin rpc call value value_ingest`
// and kept in a spool file when sandy cannot take them, so a sandy restart loses nothing.
// Install: copy to ~/.pi/agent/extensions/ or list it in a Pi package. Outside sandy (no SANDY_THREAD_ID) it does nothing.

import { mkdir, readFile, rename, unlink, writeFile, appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface QueuedCall {
  threadId: string;
  file: string;
  line: string;
  at: number;
}

export interface ExecLike {
  (command: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

const FLUSH_MS = 15_000;
const SPOOL_MAX_AGE_MS = 24 * 3_600_000;
const BATCH = 500;

/** The session-file line for an assistant message with usage, without its content; null for anything else. */
export function callLine(message: unknown): string | null {
  const m = message as { role?: string; model?: string; responseId?: string; timestamp?: number; usage?: unknown } | null;
  if (m === null || typeof m !== "object" || m.role !== "assistant" || typeof m.usage !== "object" || m.usage === null) return null;
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", model: m.model, responseId: m.responseId, timestamp: m.timestamp ?? Date.now(), usage: m.usage },
  });
}

/** Sends queued calls to the plugin and keeps what it did not take in a spool file. */
export function createReporter(options: { exec: ExecLike; sandy: string; spoolPath: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  let queue: QueuedCall[] = [];
  let flushing: Promise<void> | null = null;

  async function send(threadId: string, file: string, lines: string[]): Promise<boolean> {
    const input = join(tmpdir(), `value-calls-${process.pid}-${now()}.json`);
    await writeFile(input, JSON.stringify({ threadId, file, lines }));
    try {
      const result = await options.exec(options.sandy, ["plugin", "rpc", "call", "value", "value_ingest", "--input-file", input, "--json"], { timeout: 20_000 });
      if (result.code !== 0) return false;
      const out = JSON.parse(result.stdout) as { known?: boolean };
      return out.known !== false;
    } catch {
      return false;
    } finally {
      await unlink(input).catch(() => undefined);
    }
  }

  async function claimSpool(): Promise<QueuedCall[]> {
    const claim = `${options.spoolPath}.${process.pid}`;
    try {
      await rename(options.spoolPath, claim);
    } catch {
      return [];
    }
    const text = await readFile(claim, "utf8").catch(() => "");
    await unlink(claim).catch(() => undefined);
    const fresh: QueuedCall[] = [];
    for (const raw of text.split("\n")) {
      if (raw === "") continue;
      try {
        const item = JSON.parse(raw) as QueuedCall;
        if (now() - item.at < SPOOL_MAX_AGE_MS) fresh.push(item);
      } catch {
        // a half-written line
      }
    }
    return fresh;
  }

  async function run(): Promise<void> {
    const items = [...(await claimSpool()), ...queue];
    queue = [];
    const failed: QueuedCall[] = [];
    const groups = new Map<string, QueuedCall[]>();
    for (const item of items) {
      const key = `${item.threadId}\u0000${item.file}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i += BATCH) {
        const part = group.slice(i, i + BATCH);
        if (!(await send(part[0].threadId, part[0].file, part.map((p) => p.line)))) failed.push(...part);
      }
    }
    if (failed.length > 0) {
      await mkdir(join(options.spoolPath, ".."), { recursive: true });
      await appendFile(options.spoolPath, failed.map((f) => JSON.stringify(f)).join("\n") + "\n");
    }
  }

  return {
    add(call: QueuedCall): void {
      queue.push(call);
    },
    pending: () => queue.length,
    /** Sends everything queued; calls made while one flush runs wait for the next. */
    flush(): Promise<void> {
      flushing = (flushing ?? Promise.resolve()).then(run).catch(() => undefined);
      return flushing;
    },
  };
}

export default function (pi: ExtensionAPI) {
  const threadId = process.env.SANDY_THREAD_ID;
  if (!threadId) return;
  const reporter = createReporter({
    exec: (command, args, options) => pi.exec(command, args, options),
    sandy: process.env.SANDY_CLI || "sandy",
    spoolPath: join(homedir(), ".local", "state", "pi-value-calls", "spool.jsonl"),
  });
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", () => {
    if (timer === undefined) {
      timer = setInterval(() => void reporter.flush(), FLUSH_MS);
      timer.unref?.();
    }
    void reporter.flush();
  });
  pi.on("message_end", (event, ctx) => {
    const line = callLine((event as { message?: unknown }).message);
    if (line === null) return;
    let file = "";
    try {
      file = basename(ctx.sessionManager.getSessionFile() ?? "", ".jsonl");
    } catch {
      // no session file yet
    }
    if (file === "") file = process.env.PI_SESSION_ID ?? threadId;
    reporter.add({ threadId, file, line, at: Date.now() });
  });
  pi.on("agent_end", () => void reporter.flush());
  pi.on("session_shutdown", async () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    await reporter.flush();
  });
}
