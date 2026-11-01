import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server.ts";

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "presets-"));
  const dir = join(home, "chat-presets");
  const { sandy, harness } = createFakePluginHost({ pluginId: "personas", settings: { presetsDir: dir } });
  await plugin(sandy);
  return { harness, dir };
}
const ctx = (threadId: string, projectId = "proj_1") =>
  makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: projectId } } as never);

test("seeds examples and lists them", async () => {
  const { harness } = await boot();
  const s = (await harness.behavior.callRpc("state", { scope: "thread:t1" })) as any;
  assert.deepEqual(s.personas.map((p: any) => p.id), ["chat"]);
  assert.deepEqual(s.skills.map((p: any) => p.id), ["coach", "worklog"]);
  assert.deepEqual(s.problems, []);
});

test("no selection adds nothing", async () => {
  const { harness } = await boot();
  const r = await harness.behavior.resolveAgentConfiguration(ctx("t1"));
  assert.equal(r.instructions, null);
});

test("selection becomes the block, persona first, skill path included", async () => {
  const { harness } = await boot();
  await harness.behavior.callRpc("select", { scope: "thread:t1", selection: { persona: "chat", skills: ["coach"] } });
  const r = await harness.behavior.resolveAgentConfiguration(ctx("t1"));
  assert.ok(r.instructions!.startsWith("Für diesen Thread"));
  assert.match(r.instructions!, /- leveling-coach/);
  assert.match(r.instructions!, /~\/leveling/);
  assert.deepEqual(r.tools, []);
  assert.deepEqual(r.skills, []);
});

test("new-thread selection is adopted once by the next thread", async () => {
  const { harness } = await boot();
  await harness.behavior.callRpc("select", { scope: "new:proj_1", selection: { persona: "chat", skills: [] } });
  const a = await harness.behavior.resolveAgentConfiguration(ctx("t9"));
  assert.ok(a.instructions);
  const b = await harness.behavior.resolveAgentConfiguration(ctx("t10"));
  assert.equal(b.instructions, null);
  const again = await harness.behavior.resolveAgentConfiguration(ctx("t9"));
  assert.ok(again.instructions);
});

test("reset clears the selection", async () => {
  const { harness } = await boot();
  await harness.behavior.callRpc("select", { scope: "thread:t1", selection: { persona: "chat", skills: [] } });
  await harness.behavior.callRpc("select", { scope: "thread:t1", selection: { persona: null, skills: [] } });
  assert.equal((await harness.behavior.resolveAgentConfiguration(ctx("t1"))).instructions, null);
});

test("unknown skill preset and missing skill produce warnings, not crashes", async () => {
  const { harness } = await boot();
  await harness.behavior.callRpc("select", { scope: "thread:t1", selection: { persona: null, skills: ["nope"] } });
  const s = (await harness.behavior.callRpc("state", { scope: "thread:t1" })) as any;
  assert.match(s.warnings.join("\n"), /nope/);
});
