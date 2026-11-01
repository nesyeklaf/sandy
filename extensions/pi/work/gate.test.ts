import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallGate } from "./gate.ts";

const fakePi = () => {
  const on: string[] = [];
  return { on: (event: string) => { on.push(event); }, setActiveTools() { return this; }, events: on };
};

test("tool_call handlers run by rank, other events pass through to pi", async () => {
  const gate = new ToolCallGate();
  const pi = fakePi();
  const seen: string[] = [];
  gate.view(pi, "goal", 9).on("tool_call", () => { seen.push("goal"); });
  gate.view(pi, "track", 2).on("tool_call", async () => { seen.push("track"); });
  gate.view(pi, "delegate", 1).on("tool_call", () => { seen.push("delegate"); });
  gate.view(pi, "goal", 9).on("agent_start", () => {});
  assert.deepEqual(pi.events, ["agent_start"]);
  assert.deepEqual(gate.order(), ["delegate", "track", "goal"]);
  assert.equal(await gate.handle({ toolName: "read" }, {}), undefined);
  assert.deepEqual(seen, ["delegate", "track", "goal"]);
});

test("the first block ends the call: later handlers, the goal's bookkeeping too, never see it", async () => {
  const gate = new ToolCallGate();
  const pi = fakePi();
  let counted = 0;
  gate.view(pi, "goal", 9).on("tool_call", () => { counted++; });
  gate.view(pi, "track", 2).on("tool_call", (event: any) => (event.toolName === "bash" ? { block: true, reason: "stage forbids bash" } : undefined));
  assert.deepEqual(await gate.handle({ toolName: "bash" }, {}), { block: true, reason: "stage forbids bash" });
  assert.equal(counted, 0);
  await gate.handle({ toolName: "read" }, {});
  assert.equal(counted, 1);
});

test("a handler that throws blocks the call", async () => {
  const gate = new ToolCallGate();
  gate.view(fakePi(), "delegate", 1).on("tool_call", () => { throw new Error("policy unreadable"); });
  const result = await gate.handle({ toolName: "read" }, {});
  assert.equal(result?.block, true);
  assert.match(result!.reason, /pi\/work delegate: tool gate failed.*policy unreadable/);
});

test("the view keeps pi's own methods bound to pi", () => {
  const gate = new ToolCallGate();
  const pi = fakePi();
  assert.equal(gate.view(pi, "x", 0).setActiveTools(), pi);
});
