// Real pi SDK sessions with pi-extension.ts loaded from its file, driven by pi-ai's faux model:
// each scripted assistant message issues real tool calls that run through pi's agent loop, the
// codemode extension and the tool_call handlers.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { piAiEntry, sdkEntry } from "./sdk-root.mjs";
const sdk = await import(pathToFileURL(sdkEntry).href);
const ai = await import(pathToFileURL(piAiEntry).href);
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "./gate.ts");

const scoutPolicy = { delegationId: "dlg_test", snapshotHash: "snap_test", allowTools: ["read"], transportTools: ["codemode"] };

// toolsFile: "marker" | "plain" | undefined (env unset). policy: written to SANDY_DELEGATE_POLICY_FILE when given.
// extraFactories run after codemode; the default one re-adds edit and write after our
// before_agent_start, like the extensions in probe P3 that re-add tools after us.
async function fixture({ toolsFile, policy, extraFactories = [reAddEditWrite] }) {
  const root = await mkdtemp(join(tmpdir(), "sandy-delegate-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const env = {};
  if (toolsFile) {
    const tools = [{ name: "sandy_other", description: "", inputSchema: { type: "object" } }];
    if (toolsFile === "marker") tools.push({ name: "sandy_delegate_brief", description: "", inputSchema: { type: "object" } });
    env.PI_SANDY_TOOLS_FILE = join(root, "tools.json");
    await writeFile(env.PI_SANDY_TOOLS_FILE, JSON.stringify(tools));
  }
  if (policy) {
    env.SANDY_DELEGATE_POLICY_FILE = join(root, "policy.json");
    await writeFile(env.SANDY_DELEGATE_POLICY_FILE, JSON.stringify(policy));
  }

  const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, defaultTools: ["+codemode"] });
  // A blocking handler ends the tool_call chain, so the recorder must load before pi-extension.ts:
  // path extensions load before factories, in list order.
  const toolCalls = [];
  globalThis.sandyDelegateToolCalls = toolCalls;
  const recorderPath = join(root, "record-tool-calls.mjs");
  await writeFile(recorderPath, "export default (pi) => pi.on('tool_call', (event) => { globalThis.sandyDelegateToolCalls.push({ toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId, active: pi.getActiveTools() }); });\n");
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [recorderPath, extensionPath],
    extensionFactories: [sdk.createCodemodeExtension({ mode: "on", models: false }), ...extraFactories],
  });
  // pi-extension.ts reads its env when pi loads it.
  // SANDY_THREAD_ID would select the sandy CLI policy source; these sessions use the file source or none.
  const saved = { PI_SANDY_TOOLS_FILE: process.env.PI_SANDY_TOOLS_FILE, SANDY_DELEGATE_POLICY_FILE: process.env.SANDY_DELEGATE_POLICY_FILE, SANDY_THREAD_ID: process.env.SANDY_THREAD_ID };
  delete process.env.PI_SANDY_TOOLS_FILE;
  delete process.env.SANDY_DELEGATE_POLICY_FILE;
  delete process.env.SANDY_THREAD_ID;
  Object.assign(process.env, env);
  try {
    await loader.reload();
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
  assert.deepEqual(loader.getExtensions().errors, [], "actual SDK extension loading");
  const ours = loader.getExtensions().extensions.find((extension) => extension.path === extensionPath);
  assert.ok(ours, "pi-extension.ts loaded from its file");

  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, model: faux.getModel(), sessionManager: sdk.SessionManager.inMemory(cwd) });
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });

  // Runs one turn in which the model issues the given tool calls, then returns their results by id.
  const turn = async (calls) => {
    const done = ai.fauxAssistantMessage("done");
    faux.setResponses(calls.length === 0 ? [done] : [
      ai.fauxAssistantMessage(calls.map(([name, args, id]) => ai.fauxToolCall(name, args, { id })), { stopReason: "toolUse" }),
      done,
    ]);
    await session.prompt("go");
    const results = new Map();
    for (const message of session.messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, { isError: message.isError, text: message.content.map((part) => part.text ?? "").join("") });
    }
    return results;
  };
  return { cwd, session, faux, ours, toolCalls, errors, turn, dispose: () => session.dispose() };
}

// Re-adds edit and write after both of our narrowing points (before_agent_start and turn_start), so
// the tools are active at call time and only the tool_call gate stands in the way.
function reAddEditWrite(pi) {
  const reAdd = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), "edit", "write"])]);
  pi.on("before_agent_start", reAdd);
  pi.on("turn_start", reAdd);
}

// Like pi-goal-x: re-adds its tools in before_agent_start only, after ours.
function reAddBeforeAgentStart(pi) {
  pi.on("before_agent_start", () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "edit", "write"])]);
  });
}

const nestedWrite = (path) => `try { await tools.write({ path: ${JSON.stringify(path)}, content: "nested" }); return "WROTE"; } catch (error) { return "BLOCKED " + error.message; }`;

test("delegate with policy {allow: read, transport: codemode}: direct edit and nested write blocked, read allowed", async () => {
  const f = await fixture({ toolsFile: "marker", policy: scoutPolicy });
  try {
    const editTarget = join(f.cwd, "edit-me.txt");
    const writeTarget = join(f.cwd, "nested.txt");
    const readTarget = join(f.cwd, "read-me.txt");
    await writeFile(editTarget, "original\n");
    await writeFile(readTarget, "readable content\n");

    const results = await f.turn([
      ["edit", { path: editTarget, edits: [{ oldText: "original", newText: "changed" }] }, "call_edit"],
      ["codemode", { code: nestedWrite(writeTarget) }, "call_codemode"],
      ["read", { path: readTarget }, "call_read"],
    ]);

    // Direct edit: blocked by the gate, file untouched.
    assert.equal(results.get("call_edit").isError, true);
    assert.match(results.get("call_edit").text, /sandy-delegate: tool "edit" is not in this delegate's allowlist/);
    assert.equal(await readFile(editTarget, "utf8"), "original\n");
    // Nested write through codemode: codemode runs (transport), its write is blocked.
    assert.equal(results.get("call_codemode").isError, false);
    assert.match(results.get("call_codemode").text, /BLOCKED sandy-delegate: tool "write" is not in this delegate's allowlist/);
    assert.equal(existsSync(writeTarget), false);
    // read: allowed.
    assert.equal(results.get("call_read").isError, false);
    assert.match(results.get("call_read").text, /readable content/);

    // The gate saw the nested call as a nested call, and edit/write were active (re-added), so the
    // tool_call gate, not setActiveTools, is what blocked them.
    const nested = f.toolCalls.find((call) => call.toolName === "write");
    assert.equal(nested.parentToolCallId, "call_codemode");
    assert.equal(nested.toolCallId, "call_codemode/1");
    assert.ok(nested.active.includes("write") && f.toolCalls.find((call) => call.toolName === "edit").active.includes("edit"));
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test("delegate with a policy narrows the active tools at before_agent_start (cosmetic)", async () => {
  const f = await fixture({ toolsFile: "marker", policy: scoutPolicy, extraFactories: [] });
  try {
    assert.deepEqual(f.session.getActiveToolNames(), ["read", "bash", "edit", "write", "codemode"]);
    await f.turn([]);
    assert.deepEqual(f.session.getActiveToolNames(), ["read", "codemode"]);
  } finally {
    f.dispose();
  }
});

test("delegate without a policy stays pending and denies every call", async () => {
  const f = await fixture({ toolsFile: "marker" });
  try {
    const readTarget = join(f.cwd, "read-me.txt");
    await writeFile(readTarget, "readable content\n");
    const results = await f.turn([["read", { path: readTarget }, "call_read"], ["codemode", { code: "return 1" }, "call_codemode"]]);
    for (const id of ["call_read", "call_codemode"]) {
      assert.equal(results.get(id).isError, true);
      assert.match(results.get(id).text, /policy is not applied yet/);
    }
  } finally {
    f.dispose();
  }
});

for (const toolsFile of [undefined, "plain"]) {
  // In a SANDY thread without the marker only the pi-subagents block is registered; outside SANDY nothing is.
  test(`without the marker (${toolsFile ? "tool list without sandy_delegate_brief" : "PI_SANDY_TOOLS_FILE unset"}) the extension changes nothing${toolsFile ? " but blocks pi-subagents" : ""}`, async () => {
    const f = await fixture({ toolsFile, policy: scoutPolicy, extraFactories: [] });
    try {
      assert.deepEqual([...f.ours.handlers.keys()], toolsFile ? ["tool_call"] : [], "event handlers registered");
      assert.equal(f.ours.tools.size, 0, "no tools registered");
      assert.deepEqual(f.session.getActiveToolNames(), ["read", "bash", "edit", "write", "codemode"]);
      const editTarget = join(f.cwd, "edit-me.txt");
      const writeTarget = join(f.cwd, "nested.txt");
      await writeFile(editTarget, "original\n");
      const results = await f.turn([
        ["edit", { path: editTarget, edits: [{ oldText: "original", newText: "changed" }] }, "call_edit"],
        ["codemode", { code: nestedWrite(writeTarget) }, "call_codemode"],
      ]);
      assert.equal(results.get("call_edit").isError, false);
      assert.equal(await readFile(editTarget, "utf8"), "changed\n");
      assert.match(results.get("call_codemode").text, /WROTE/);
      assert.equal(await readFile(writeTarget, "utf8"), "nested");
    } finally {
      f.dispose();
    }
  });
}

test("pi blocks a call whose tool_call handler throws (the fail-closed behaviour the gate relies on)", async () => {
  const throwing = (pi) => pi.on("tool_call", () => { throw new Error("handler broke"); });
  const f = await fixture({ toolsFile: undefined, extraFactories: [throwing] });
  try {
    const writeTarget = join(f.cwd, "thrown.txt");
    const results = await f.turn([["write", { path: writeTarget, content: "x" }, "call_write"]]);
    assert.equal(results.get("call_write").isError, true);
    assert.equal(existsSync(writeTarget), false);
  } finally {
    f.dispose();
  }
});

test("delegate: the first request already offers only the policy's tools, also when another extension re-adds tools in before_agent_start, and no tool change follows", async () => {
  const f = await fixture({ toolsFile: "marker", policy: scoutPolicy, extraFactories: [reAddBeforeAgentStart] });
  try {
    // Per request: the tool changes the transcript declares (pi sends tools as transcript deltas).
    const requests = [];
    const record = (message) => (context) => {
      requests.push(context.messages.filter((m) => m.role === "system" && (m.toolsAdded || m.toolsRemoved)).map((m) => ({ added: (m.toolsAdded ?? []).map((tool) => tool.name).sort(), removed: (m.toolsRemoved ?? []).map((tool) => tool.name).sort() })));
      return message;
    };
    const readTarget = join(f.cwd, "read-me.txt");
    await writeFile(readTarget, "readable content\n");
    f.faux.setResponses([
      record(ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: readTarget }, { id: "call_read" })], { stopReason: "toolUse" })),
      record(ai.fauxAssistantMessage("done")),
    ]);
    await f.session.prompt("go");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], [{ added: ["codemode", "read"], removed: [] }], "first request: only the policy's tools");
    assert.deepEqual(requests[1], requests[0], "second request: no tool change appended");
    // A follow-up run (the parent sends the child more work): the re-add happens again, still nothing changes.
    f.faux.setResponses([record(ai.fauxAssistantMessage("done again"))]);
    await f.session.prompt("more");
    assert.deepEqual(requests[2], requests[0], "follow-up run: no tool change appended");
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});
