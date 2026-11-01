# Track drivers v2: probes (slice 0)

Two facts the v2 design rests on, checked on this machine on 2026-10-27 before any product code. sandy `sandy-app` host
daemon as installed, pi `@earendil-works/pi-coding-agent` 1.4.0, plugin SDK 0.6.79.

## (a) A plugin launches a pi command with `sandy.sdk.threads.send`

Question: when the plugin sends the text `/autopilot nosuch` into an idle thread through `sandy.sdk.threads.send`, does
pi run the `/autopilot` command (through the sandy pi bridge), or does the model get the text as a prompt?

Setup: a throwaway plugin `track-launch-probe` (id differs from `track`), installed from `/tmp/track-launch-probe`
with `sandy plugin install /tmp/track-launch-probe --yes`, removed afterwards with `sandy plugin uninstall
track-launch-probe` (`sandy plugin list` no longer shows it). Its whole server:

```ts
// Throwaway probe for sandy/track v2 slice 0 (a): send a slash command into a thread through sandy.sdk.threads.send.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default async function plugin(sandy: SandyPluginApi) {
  sandy.cli.register({
    name: "launch-probe",
    summary: "Send text into a thread via sandy.sdk.threads.send",
    commands: [{ name: "send", summary: "send <threadId> <text> [mode]", usage: "sandy launch-probe send <threadId> <text> [mode]" }],
    async run(argv) {
      const [command, threadId, text, mode] = argv;
      if (command !== "send" || !threadId || !text) return { exitCode: 1, stderr: "usage: sandy launch-probe send <threadId> <text> [mode]" };
      try {
        const result = await sandy.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: (mode ?? "start") as "start" });
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.stack ?? error.message : String(error) };
      }
    },
  });
}
```

Target: `thr_bd7w687hid` (idle pi test thread, "track e2e #3"), pi session
`~/.sandy/pi-bridge-sessions/pi_a5e9fba2-f8a1-421d-b971-eb8fd38cadd3.jsonl`.

### Run 1: `sandy launch-probe send thr_bd7w687hid '/autopilot nosuch'`

- `threads.send` returned `{"ok":true,"delivery":"sent"}`. Thread event seq 278 `client/turn/requested` with
  `source: "tell"`, `request.method: "turn/start"`, input text `/autopilot nosuch`.
- pi ran the command. The session file gained exactly one entry, the command handler's own message, and no user
  message and no assistant message:
  `{"type":"custom_message","customType":"autopilot","content":"[autopilot] nosuch -> {\"error\":\"no autopilot nosuch in …/.pi/autopilots/nosuch.ts or /home/aemon/.pi/agent/autopilots/nosuch.ts\"}",…}`.
  The model never saw the text.
- But no turn started. sandy kept the thread `active` and after 120 s logged seq 281 `system/error`
  `provider_turn_start_timeout`: "The provider accepted a turn but did not start it within 120s. The request may be
  stalled; stopping the thread interrupts it." The thread stayed `active` until `sandy thread stop thr_bd7w687hid`
  (seq 282 `system/thread/interrupted`, then `idle`).

### Run 2: `sandy launch-probe send thr_bd7w687hid '/autopilot --report nosuch'`

The `--report` path returns from the command at once, runs the autopilot detached, and ends with
`pi.sendMessage(…, { triggerTurn: true })` ("Reply only with: ok").

- seq 283 `client/turn/requested`, seq 286 `turn/started`, seq 287 `turn/input/accepted`, seq 290 the autopilot's
  message as the turn input, seq 292–294 the model's reply `ok`, seq 296 `turn/completed`; thread `idle` within 45 s.

### Result: PASS, with one constraint

`threads.send` of a slash command makes pi run the command, not the model. A command that starts no agent run leaves
the sandy turn unstarted: the thread hangs in `active` and fails with `provider_turn_start_timeout` after 120 s. So the
v2 launch command (`/autopilot --lease <ticket> <name> <args>`) must return quickly, run the autopilot detached, and
start an agent run promptly: its first `session.step`, or, when it exits without one (stale ticket, unknown
autopilot), a short closing message with `triggerTurn: true`, as `--report` does today. This matches
candidate-1's "detached + short closing turn as today". The plugin cannot learn from `threads.send` whether the
command ran (`delivery: "sent"` either way); the lease's claim deadline (LAUNCH_GRACE_SEC) stays the only proof.

## (b) A track-guard `tool_call` hook can inject `input.ticket`, also inside codemode

Question: when a `tool_call` handler sets `event.input.ticket`, does the tool's `execute` receive it, for a
model-issued call and for a call a codemode script makes (`tools.stage_submit(...)`)?

Code path (pi 1.4.0): `AgentSession._beforeToolCall` passes the validated args object as `event.input`
(`dist/core/agent-session.js:326-345`); `prepareToolCall` validates first, then calls the hook, then executes with
that same object (`pi-agent-core/dist/agent-loop.js:487-537`), so a mutation lands and is not re-validated.
Codemode's nested calls go through `_executeNestedToolCall` → `runToolCall` with the same `_beforeToolCall`
(`agent-session.js:387-415`), with `toolCallId` `<parent>/<n>` and `parentToolCallId` set.

Proof: an SDK session with pi's faux provider, the built-in codemode extension, and an inline extension that registers
a `stage_submit` stand-in shaped like the sandy bridge's dynamic tools (JSON-schema parameters, `execute(id, params)`)
and a `tool_call` hook that sets `event.input.ticket = "run1.7"` for `stage_submit`. The faux model issues one
top-level `stage_submit`, then one `codemode` call whose script calls `tools.stage_submit`.
Run: `node probe.mjs` (script below), exit 0.

```text
hooks: stage_submit call-top (no parent); codemode call-cm (no parent); stage_submit call-cm/1 parent call-cm
seen:  call-top   params {"outputs":{"a":"top"},"ticket":"run1.7"}
       call-cm/1  params {"outputs":{"a":"nested"},"ticket":"run1.7"}
codemode nestedCalls record: arguments {"outputs":{"a":"nested"}}  (the record keeps the model's arguments, without the ticket)
top-level call got ticket: run1.7
nested codemode call got ticket: run1.7
```

### Result: PASS, with one constraint on the sandy side

The hook's mutation reaches the tool in both cases. Across the bridge, the sandy plugin validates a zod `parameters`
schema per call and hands `execute` the parsed value (SDK `PluginAgents.registerTool`, bundled types :20563-20576);
a plain `z.object` strips unknown keys, so `stage_submit`/`stage_advance` must declare `ticket` (optional, "set by
the guard") or the ticket is lost before `execute`. Not run through a live bridge here; slice 3 adds a server test
that a `ticket` argument reaches `operations`.

Probe script (`/tmp/probe-ticket/probe.mjs`):

```js
// Probe (b), sandy/track v2 slice 0: does a tool_call hook that sets input.ticket reach the tool,
// for a top-level call and for a call nested inside codemode? Runs pi's SDK with the faux provider.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PI = process.env.PI_PKG ?? "/home/aemon/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const sdk = await import(PI + "/dist/index.js");
const ai = await import(PI + "/node_modules/@earendil-works/pi-ai/dist/index.js");
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;

const dir = mkdtempSync(join(tmpdir(), "probe-ticket-"));
const seen = [];   // what stage_submit's execute received
const hooks = [];  // what the tool_call hook saw
const probeExtension = (pi) => {
  // Shaped like the sandy pi bridge's dynamic tools: JSON-schema parameters, execute(id, params).
  pi.registerTool({
    name: "stage_submit",
    label: "stage_submit",
    description: "probe stand-in for the sandy stage_submit tool",
    parameters: { type: "object", properties: { outputs: { type: "object", additionalProperties: { type: "string" } } } },
    async execute(id, params) {
      seen.push({ id, params: JSON.parse(JSON.stringify(params)) });
      return { content: [{ type: "text", text: "recorded " + JSON.stringify(params) }], details: {} };
    },
  });
  // The track-guard side: inject the ticket; the model never types it.
  pi.on("tool_call", (event) => {
    hooks.push({ toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId ?? null });
    if (event.toolName === "stage_submit") event.input.ticket = "run1.7";
    return undefined;
  });
};

const faux = ai.fauxProvider();
const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);
const model = faux.getModel();
faux.setResponses([
  ai.fauxAssistantMessage(ai.fauxToolCall("stage_submit", { outputs: { a: "top" } }, { id: "call-top" }), { stopReason: "toolUse" }),
  ai.fauxAssistantMessage(
    ai.fauxToolCall("codemode", { code: "return await tools.stage_submit({ outputs: { a: 'nested' } });" }, { id: "call-cm" }),
    { stopReason: "toolUse" },
  ),
  ai.fauxAssistantMessage("done"),
]);

const resourceLoader = new DefaultResourceLoader({
  cwd: dir,
  agentDir: dir,
  noExtensions: true,
  extensionFactories: [createCodemodeExtension({ mode: "on" }), probeExtension],
});
await resourceLoader.reload();
const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory() });
await session.bindExtensions({});
try {
  await session.prompt("probe");
  const results = session.messages.filter((m) => m.role === "toolResult").map((m) => ({ toolName: m.toolName, text: m.content.map((c) => c.text).join("\n").slice(0, 300), nestedCalls: m.nestedCalls }));
  console.log(JSON.stringify({ hooks, seen, results }, null, 2));
  const top = seen.find((s) => s.params.outputs?.a === "top");
  const nested = seen.find((s) => s.params.outputs?.a === "nested");
  console.log("top-level call got ticket:", top?.params.ticket ?? "(missing)");
  console.log("nested codemode call got ticket:", nested?.params.ticket ?? "(missing)");
  process.exitCode = top?.params.ticket === "run1.7" && nested?.params.ticket === "run1.7" ? 0 : 1;
} finally {
  session.dispose();
}
```
