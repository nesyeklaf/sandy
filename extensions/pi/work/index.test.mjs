// Loads pi/work/index.ts into the real pi SDK (the managed install, see delegate/sdk-root.mjs) and checks that
// every part registers: one load error or a missing tool means pi would start without that part.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piAiEntry, sdkEntry } from "./delegate/sdk-root.mjs";

const sdk = await import(pathToFileURL(sdkEntry).href);
const ai = await import(pathToFileURL(piAiEntry).href);
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

test("pi/work loads into the pi SDK and registers the goal and autopilot tools (track and delegate only hook tool_call)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-work-load-"));
  const saved = { PI_GOAL_HEADLESS: process.env.PI_GOAL_HEADLESS, SANDY_THREAD_ID: process.env.SANDY_THREAD_ID };
  delete process.env.SANDY_THREAD_ID;
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "cwd");
    const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [extensionPath],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    // One tool_call handler for all parts: the gate (gate.ts) asks the parts in its own order.
    const ours = loader.getExtensions().extensions.find((extension) => extension.path === extensionPath);
    assert.equal(ours.handlers.get("tool_call")?.length, 1);
    const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, model: faux.getModel(), sessionManager: sdk.SessionManager.inMemory(cwd) });
    const errors = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    assert.deepEqual(errors, []);
    const tools = session.getAllTools().map((tool) => tool.name);
    for (const name of ["get_goal", "update_goal", "set_goal_tasks", "autopilot", "autopilot_submit", "tasks"]) assert.ok(tools.includes(name), `${name} registered (have: ${tools.join(", ")})`);
    // The gate runs in the real session: outside a delegate child and a track run a read passes, and the
    // autopilot part still refuses autopilot_submit outside a step.
    const runner = session._extensionRunner;
    assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "t1", input: { path: "x" } }))?.block, undefined);
    assert.deepEqual(await runner.emitToolCall({ type: "tool_call", toolName: "autopilot_submit", toolCallId: "t2", input: { value: 1 } }), { block: true, reason: "No autopilot step asks for a value now." });
    // tasks: active by default, and a change lands as a session entry on the branch (what sandy/work/goals reads).
    assert.ok(session.getActiveToolNames().includes("tasks"), "tasks is active");
    assert.equal(tools.includes("TaskCreate"), false, "the four only with WORK_TASKS=four");
    const create = ours.tools.get("tasks").definition;
    const result = await create.execute("c1", { action: "create", subject: "read code", description: "the parser" }, undefined, undefined, runner.createContext());
    assert.equal(result.content[0].text, "Task #1 created successfully: read code");
    const entry = session.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === "work-tasks");
    assert.equal(entry?.data.tasks[0].subject, "read code");
    // sandy/work/goals reads that entry from the session file as pi writes it (one JSON line).
    const { sessionTasks } = await import("../../sandy/work/goals/goals.ts");
    const file = join(root, "session.jsonl");
    writeFileSync(file, JSON.stringify(entry) + "\n");
    assert.deepEqual(sessionTasks(file), [{ id: "1", subject: "read code", status: "pending", description: "the parser", activeForm: null, parent: null, blockedBy: [] }]);
    session.dispose?.();
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    await rm(root, { recursive: true, force: true });
  }
});
