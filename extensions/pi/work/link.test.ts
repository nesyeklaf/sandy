import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = () => mkdtempSync(path.join(tmpdir(), "pi-work-link-"));

test("link writes the thread pointer on session_start", async () => {
  const agent = tmp();
  const saved = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.SANDY_THREAD_ID = "thr_link";
  process.env.PI_GOAL_ROOT = "/srv/env";
  delete process.env.PI_GOAL_HEADLESS;
  try {
    const { default: extension } = await import("./link.ts");
    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    extension({ on: (name: string, fn: (event: unknown, ctx: unknown) => void) => { handlers[name] = fn; } });
    handlers.session_start({}, { sessionManager: { getCwd: () => "/work", getSessionFile: () => "/s.jsonl" } });
    const pointer = JSON.parse(readFileSync(path.join(agent, "sandy-goals/thr_link.json"), "utf8"));
    assert.deepEqual([pointer.cwd, pointer.sessionFile, pointer.env.PI_GOAL_ROOT], ["/work", "/s.jsonl", "/srv/env"]);
    assert.equal(process.env.PI_GOAL_HEADLESS, "1", "SANDY sessions run goal/ headless");
  } finally {
    process.env = saved;
  }
});
