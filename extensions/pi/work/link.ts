// Links a SANDY thread to its pi session so sandy/work/goals can find the goal root and the focused goal. It writes
// only <agent dir>/sandy-goals/<SANDY_THREAD_ID>.json. In SANDY it also sets PI_GOAL_HEADLESS=1: SANDY never shows the
// dialogs goal/ raises from slash commands, so goal/ takes its no-dialog paths instead of waiting.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV = ["PI_GOAL_ROOT", "PI_GOAL_SETTINGS_FILE", "PI_GOAL_GLOBAL_SETTINGS_FILE"];

export default function sandyGoals(pi: any) {
  const threadId = process.env.SANDY_THREAD_ID?.trim();
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) return;
  process.env.PI_GOAL_HEADLESS ??= "1";
  const agent = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const dir = join(agent, "sandy-goals");
  const file = join(dir, `${threadId}.json`);

  const link = (ctx: any) => {
    try {
      const env: Record<string, string> = {};
      for (const key of ENV) if (process.env[key]) env[key] = process.env[key] as string;
      const pointer = {
        version: 1,
        threadId,
        pid: process.pid,
        cwd: ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd(),
        sessionFile: ctx.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_FILE ?? null,
        agentDir: agent,
        env,
        updatedAt: Date.now(),
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(pointer, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch {
      // the banner falls back to the environment checkout
    }
  };

  pi.on("session_start", (_event: unknown, ctx: any) => link(ctx));
}
