// pi extension installed by sandy-plugin-pi-lifecycle. It tells the SANDY plugin when this pi process
// was loaded or reloaded and carries out reload requests once pi is idle.
// State: <agent dir>/lifecycle/<pid>.json. Request: <agent dir>/lifecycle/<pid>.reload-request.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_MS = 3000;

export default function lifecycle(pi: any) {
  const dir = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "lifecycle");
  const state = join(dir, `${process.pid}.json`);
  const request = join(dir, `${process.pid}.reload-request`);
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: { isIdle(): boolean } | undefined;

  const previous = (): Record<string, any> | null => {
    try {
      const value = JSON.parse(readFileSync(state, "utf8"));
      return Math.abs(value.startedAt - startedAt) < 5000 ? value : null;
    } catch {
      return null;
    }
  };

  pi.on("session_start", (event: { reason: string }, ctx: { isIdle(): boolean }) => {
    context = ctx;
    const before = previous();
    const now = Date.now();
    const reloaded = event.reason === "reload";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${state}.tmp`, JSON.stringify({
      pid: process.pid,
      threadId: process.env.SANDY_THREAD_ID ?? null,
      startedAt,
      lastLoadAt: now,
      reason: event.reason,
      lastReloadAt: reloaded ? now : before?.lastReloadAt ?? null,
      reloadCount: (before?.reloadCount ?? 0) + (reloaded ? 1 : 0),
    }));
    renameSync(`${state}.tmp`, state);
    // A request older than this process was meant for a dead pi that had the same pid.
    if ((statSync(request, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < startedAt) rmSync(request, { force: true });
    clearInterval(timer);
    timer = setInterval(() => {
      if (!existsSync(request) || !context?.isIdle()) return;
      rmSync(request, { force: true });
      pi.sendUserMessage("/lifecycle-reload", { expandPromptTemplates: true });
    }, POLL_MS);
    timer.unref();
  });

  pi.on("session_shutdown", (event: { reason: string }) => {
    clearInterval(timer);
    if (event.reason === "quit") rmSync(state, { force: true });
  });

  pi.registerCommand("lifecycle-reload", {
    description: "Reload extensions, skills and settings (used by the SANDY pi lifecycle plugin)",
    handler: async (_args: string, ctx: { reload(): Promise<void> }) => {
      await ctx.reload();
    },
  });
}
