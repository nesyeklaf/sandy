import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@sandy-sdk/plugin-sdk/testing/host";
import { applyPolicy, readPolicy } from "./apply.ts";
import hostEntry from "./host.ts";
import plugin from "./server.ts";
import { parseList } from "./lists.ts";

const policy = { mode: "yolo", readOnly: false, programs: ["ssh"], allow: ["ssh AI"] } as const;
const tmp = () => join(mkdtempSync(join(tmpdir(), "perm-")), "agent", "permissions.json");

test("parseList splits lines and commas, trims, dedupes", () => {
  assert.deepEqual(parseList(" ssh\nscp, ssh \n\n"), ["ssh", "scp"]);
});

test("applyPolicy merges, keeps other keys, writes 0600", () => {
  const file = tmp();
  applyPolicy(file, { ...policy, programs: [...policy.programs], allow: [...policy.allow] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const first = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(first, { version: 1, mode: "yolo", readOnly: false, blockedCommands: { programs: ["ssh"], allow: ["ssh AI"] } });
  writeFileSync(file, JSON.stringify({ ...first, permission: { tools: { x: "allow" } }, mode: "ask" }));
  applyPolicy(file, { mode: "auto", readOnly: true, programs: [], allow: [] });
  const next = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(next.permission, { tools: { x: "allow" } });
  assert.equal(next.mode, "auto");
  assert.equal(next.readOnly, true);
  assert.deepEqual(readPolicy(file), { path: file, mode: "auto", readOnly: true, programs: [], allow: [] });
});

test("applyPolicy never overwrites a broken file", () => {
  const file = tmp();
  applyPolicy(file, { ...policy, programs: [], allow: [] });
  writeFileSync(file, "{ nope");
  assert.throws(() => applyPolicy(file, { ...policy, programs: [], allow: [] }), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ nope");
  writeFileSync(file, "[]");
  assert.throws(() => applyPolicy(file, { ...policy, programs: [], allow: [] }), /not a JSON object/);
});

test("host entry validates its input and writes under PI_CODING_AGENT_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-host-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    await assert.rejects(harness.experimental_call("apply", { mode: "bogus", readOnly: false, programs: [], allow: [] } as never));
    assert.equal(existsSync(join(dir, "permissions.json")), false);
    const result = await harness.experimental_call("apply", { mode: "ask", readOnly: false, programs: ["ssh"], allow: ["ssh AI"] });
    assert.equal(result.path, join(dir, "permissions.json"));
    assert.equal((await harness.experimental_call("read", {})).mode, "ask");
  } finally {
    await harness.experimental_dispose();
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

async function boot() {
  const calls: Array<{ method: string; input: any; hostId?: string }> = [];
  const { sandy, harness } = createFakePluginHost({
    pluginId: "permissions",
    sdk: { system: { config: async () => ({ primaryHostId: "host_1" }) } } as never,
    experimental_callHostRpc: async ({ method, input, hostId }: any) => {
      calls.push({ method, input, hostId });
      if (method === "read") return { path: "/p", mode: "auto", readOnly: false, programs: ["ssh"], allow: ["ssh AI"] };
      return { path: "/p" };
    },
  } as never);
  await plugin(sandy);
  await new Promise((r) => setTimeout(r, 20));
  return { harness, calls };
}

test("start pushes the defaults to the primary host", async () => {
  const { calls } = await boot();
  const apply = calls.find((c) => c.method === "apply")!;
  assert.equal(apply.hostId, "host_1");
  assert.equal(apply.input.mode, "auto");
  assert.ok(apply.input.programs.includes("ssh"));
  assert.deepEqual(apply.input.allow, ["ssh AI"]);
});

test("a settings change is pushed", async () => {
  const { harness, calls } = await boot();
  calls.length = 0;
  await harness.behavior.setSettings({ mode: "yolo", blockedPrograms: "ssh\nkubectl" });
  await new Promise((r) => setTimeout(r, 20));
  const apply = calls.find((c) => c.method === "apply")!;
  assert.equal(apply.input.mode, "yolo");
  assert.deepEqual(apply.input.programs, ["ssh", "kubectl"]);
});

test("cli: mode, block, allow, status", async () => {
  const { harness, calls } = await boot();
  calls.length = 0;
  assert.equal((await harness.behavior.runCli(["mode", "yolo"])).exitCode, 0);
  assert.equal(calls.at(-1)!.input.mode, "yolo");
  assert.notEqual((await harness.behavior.runCli(["mode", "bogus"])).exitCode, 0);
  await harness.behavior.runCli(["block", "kubectl"]);
  assert.ok(calls.at(-1)!.input.programs.includes("kubectl"));
  await harness.behavior.runCli(["allow", "kubectl get"]);
  assert.deepEqual(calls.at(-1)!.input.allow, ["ssh AI", "kubectl get"]);
  await harness.behavior.runCli(["unblock", "kubectl"]);
  assert.ok(!calls.at(-1)!.input.programs.includes("kubectl"));
  const status = await harness.behavior.runCli(["status"]);
  assert.equal(status.exitCode, 0);
  assert.match(status.stdout ?? "", /blocked: ssh/);
});

test("rpc: state, setMode and setReadOnly write through to the host", async () => {
  const { harness, calls } = await boot();
  const first = (await harness.behavior.callRpc("state", {})) as any;
  assert.equal(first.mode, "auto");
  calls.length = 0;
  const next = (await harness.behavior.callRpc("setMode", { mode: "yolo" })) as any;
  assert.equal(next.mode, "yolo");
  assert.equal(calls.at(-1)!.input.mode, "yolo");
  await harness.behavior.callRpc("setReadOnly", { readOnly: true });
  assert.equal(calls.at(-1)!.input.readOnly, true);
  await assert.rejects(harness.behavior.callRpc("setMode", { mode: "bogus" }));
});
