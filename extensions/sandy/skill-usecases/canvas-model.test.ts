import assert from "node:assert/strict";
import test from "node:test";
import { check, hasErrors, type Problem } from "./check.ts";
import { applyFix, autoBind, blockedReason, connect, deleteNode, insertNode, layout, needsLayout, record, redo, startHistory, summaryText, syncForkPaths, undo, HISTORY_LIMIT } from "./canvas-model.ts";
import { flowSchema, MAX_CHOICES, type Flow, type FlowNode } from "./graph.ts";
import { UX_SKILLS, edit, uxFlow, wire } from "./ux-flow.fixture.ts";

const skill = (name: string) => ({ kind: "skill" as const, skill: UX_SKILLS.find((item) => item.name === name)! });
const nodeOf = (flow: Flow, id: string | null): FlowNode => flow.nodes.find((node) => node.id === id)!;
const errors = (flow: Flow) => check(flow, UX_SKILLS).filter((problem) => problem.severity === "error");

function fixFor(flow: Flow, pattern: RegExp, label: RegExp): { problem: Problem; fix: Problem["fixes"][number] } {
  const problem = check(flow, UX_SKILLS).find((item) => pattern.test(item.message));
  assert.ok(problem, "no problem matches " + String(pattern));
  const fix = problem.fixes.find((item) => label.test(item.label));
  assert.ok(fix, "no fix matches " + String(label) + " in " + JSON.stringify(problem.fixes));
  return { problem, fix };
}

test("the UX fixture checks clean, so the fix tests start from a valid flow", () => {
  assert.deepEqual(errors(uxFlow()), []);
});

test("inserting on a wire splices the block in between and auto-binds its inputs", () => {
  const flow = uxFlow();
  const result = insertNode(flow, skill("prototype"), { kind: "wire", wireId: "w2" });
  const node = nodeOf(result.flow, result.nodeId);
  assert.equal(result.flow.wires.some((item) => item.id === "w2"), false);
  assert.ok(result.flow.wires.some((item) => item.from === "frame" && item.port === 0 && item.to === node.id));
  assert.ok(result.flow.wires.some((item) => item.from === node.id && item.port === 0 && item.to === "users"));
  assert.equal(node.kind, "skill");
  assert.deepEqual(node.kind === "skill" && node.inputs[0]?.bind, { nodeId: "frame", port: "frame.md" });
  assert.match(result.message, /^Inserted prototype between frame-the-problem and ux-users; bound journeys ← frame-the-problem › frame.md$/u);
});

test("auto-bind prefers an output named like the input, then the closest one", () => {
  const flow = uxFlow();
  const result = insertNode(flow, skill("ux-journeys"), { kind: "wire", wireId: "w9" });
  const node = nodeOf(result.flow, result.nodeId);
  assert.equal(node.kind, "skill");
  if (node.kind !== "skill") return;
  assert.deepEqual(node.inputs.find((input) => input.name === "frame")?.bind, { nodeId: "frame", port: "frame.md" });
  assert.deepEqual(node.inputs.find((input) => input.name === "users")?.bind, { nodeId: "walk", port: "walkthrough_report.md" });
});

test("auto-bind leaves an input unbound when nothing upstream satisfies its type", () => {
  const flow: Flow = { ...uxFlow(), nodes: [], wires: [] };
  const first = insertNode(flow, skill("ux-users"), { kind: "free", x: 0, y: 0 });
  const node = nodeOf(first.flow, first.nodeId);
  assert.deepEqual(node.kind === "skill" && node.inputs[0]?.bind, null);
  assert.equal(autoBind(first.flow, first.nodeId!).notes.length, 0);
});

test("inserting after a gate option wires that exit and stops it from finishing the run", () => {
  const flow = edit(uxFlow(), "gate", (node) => (node.kind === "gate" ? { ...node, ends: [0] } : node));
  const cut = { ...flow, wires: flow.wires.filter((item) => item.id !== "w10") };
  const result = insertNode(cut, { kind: "output" }, { kind: "after", nodeId: "gate", port: 0 });
  const out = nodeOf(result.flow, result.nodeId);
  assert.deepEqual(nodeOf(result.flow, "gate").kind === "gate" && (nodeOf(result.flow, "gate") as { ends: number[] }).ends, []);
  assert.ok(result.flow.wires.some((item) => item.from === "gate" && item.port === 0 && item.to === out.id));
  assert.deepEqual(out.kind === "output" && out.source, { nodeId: "walk", port: "walkthrough_report.md" });
  assert.match(result.message, /^Added Output after Keep the journeys or fix them\? › keep/u);
});

test("an inserted gate keeps option one on the old wire and ends the others", () => {
  const result = insertNode(uxFlow(), { kind: "gate" }, { kind: "wire", wireId: "w2" });
  const gate = nodeOf(result.flow, result.nodeId);
  assert.equal(gate.kind, "gate");
  assert.deepEqual(gate.kind === "gate" && gate.ends, [1]);
  assert.deepEqual(result.flow.wires.filter((item) => item.from === gate.id).map((item) => [item.port, item.to]), [[0, "users"]]);
});

test("Input and Output blocks are refused where they cannot go", () => {
  const flow = uxFlow();
  assert.equal(blockedReason(flow, { kind: "input" }, { kind: "after", nodeId: "frame", port: 0 }), "starts a flow");
  assert.equal(blockedReason(flow, { kind: "output" }, { kind: "wire", wireId: "w2" }), "ends a flow");
  assert.equal(blockedReason(flow, { kind: "output" }, { kind: "after", nodeId: "walk", port: 1 }), null);
  assert.equal(blockedReason(flow, { kind: "input" }, { kind: "free", x: 0, y: 0 }), null);
});

test("deleting a skill reconnects its neighbours and clears bindings to it", () => {
  const flow = deleteNode(uxFlow(), "users");
  assert.ok(flow.wires.some((item) => item.from === "frame" && item.to === "journeys"));
  const journeys = nodeOf(flow, "journeys");
  assert.deepEqual(journeys.kind === "skill" && journeys.inputs.find((input) => input.name === "users")?.bind, null);
  assert.deepEqual(errors(flow), []);
});

test("connect replaces the wire already on that port", () => {
  const flow = connect(uxFlow(), "frame", 0, "journeys");
  assert.deepEqual(flow.wires.filter((item) => item.from === "frame").map((item) => item.to), ["journeys"]);
});

test("a missing skill is fixed by using the nearest installed one", () => {
  const flow = edit(uxFlow(), "users", (node) => (node.kind === "skill" ? { ...node, skill: "ux-user", name: "ux-user" } : node));
  const { problem, fix } = fixFor(flow, /Skill not found: ux-user/u, /^Use ux-users$/u);
  const fixed = applyFix(flow, problem.nodeId, fix.action, UX_SKILLS).flow;
  assert.equal(nodeOf(fixed, "users").kind === "skill" && (nodeOf(fixed, "users") as { name: string }).name, "ux-users");
  assert.deepEqual(errors(fixed), []);
});

test("a dangling gate option is fixed by finishing the run there or adding an Output", () => {
  const flow = deleteNode(uxFlow(), "out");
  const finish = fixFor(flow, /"keep" leads nowhere/u, /^Finish here$/u);
  assert.deepEqual(errors(applyFix(flow, finish.problem.nodeId, finish.fix.action, UX_SKILLS).flow), []);
  const output = fixFor(flow, /"keep" leads nowhere/u, /^Add Output after keep$/u);
  const added = applyFix(flow, output.problem.nodeId, output.fix.action, UX_SKILLS).flow;
  assert.deepEqual(errors(added), []);
});

test("a loop without a gate is fixed by asking first", () => {
  const flow: Flow = { ...uxFlow(), wires: [...uxFlow().wires, wire("loop", "walk", "frame", 0)] };
  const broken = { ...flow, wires: flow.wires.filter((item) => item.id !== "w9") };
  const { problem, fix } = fixFor(broken, /leads back to frame-the-problem with no gate/u, /insert a gate/u);
  const fixed = applyFix(broken, problem.nodeId, fix.action, UX_SKILLS);
  const gate = nodeOf(fixed.flow, fixed.nodeId);
  assert.equal(gate.kind, "gate");
  assert.equal(check(fixed.flow, UX_SKILLS).some((item) => /no gate/u.test(item.message)), false);
  const removed = fixFor(broken, /no gate/u, /Remove the loop wire/u);
  assert.equal(applyFix(broken, removed.problem.nodeId, removed.fix.action, UX_SKILLS).flow.wires.some((item) => item.id === "loop"), false);
});

test("fork values and paths are fixed from either side", () => {
  const flow = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options: [...field.options, "huge"] } : field)) } : node));
  const add = fixFor(flow, /'huge' has no path/u, /^Add path 'huge'$/u);
  const withPath = applyFix(flow, add.problem.nodeId, add.fix.action, UX_SKILLS).flow;
  const fork = nodeOf(withPath, "fork");
  assert.deepEqual(fork.kind === "fork" && fork.paths.at(-1), { label: "huge", note: "skip" });
  assert.deepEqual(errors(withPath), []);
  const remove = fixFor(flow, /'huge' has no path/u, /^Remove value 'huge'$/u);
  assert.deepEqual(errors(applyFix(flow, remove.problem.nodeId, remove.fix.action, UX_SKILLS).flow), []);
});

test("a required input bound to an optional output is fixed by requiring the output or relaxing the input", () => {
  const flow = edit(uxFlow(), "frame", (node) => (node.kind === "skill" ? { ...node, skill: null, outputs: node.outputs.map((output) => ({ ...output, optional: true })) } : node));
  const looser = edit(flow, "users", (node) => (node.kind === "skill" ? { ...node, skill: null } : node));
  const required = fixFor(looser, /ux-users: input "frame" is required/u, /^Make frame.md required$/u);
  assert.deepEqual(errors(applyFix(looser, required.problem.nodeId, required.fix.action, UX_SKILLS).flow), []);
  const relaxed = fixFor(looser, /ux-users: input "frame" is required/u, /^Make frame optional$/u);
  const after = applyFix(looser, relaxed.problem.nodeId, relaxed.fix.action, UX_SKILLS).flow;
  assert.equal(errors(after).some((problem) => /ux-users: input "frame"/u.test(problem.message)), false);
});

test("an output path conflict is fixed with a free path", () => {
  const flow = edit(uxFlow(), "proto", (node) => (node.kind === "skill" ? { ...node, outputs: node.outputs.map((output) => ({ ...output, path: "journeys.md" })) } : node));
  const { problem, fix } = fixFor(flow, /both write journeys.md/u, /^Change the path of prototypes$/u);
  const fixed = applyFix(flow, problem.nodeId, fix.action, UX_SKILLS).flow;
  const proto = nodeOf(fixed, "proto");
  assert.equal(proto.kind === "skill" && proto.outputs[0]?.path, "journeys-2.md");
  assert.deepEqual(errors(fixed), []);
});

test("fork paths follow the bound choice values and keep their wires", () => {
  const flow = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options: ["deep", "quick"] } : field)) } : node));
  const synced = syncForkPaths(flow, "fork");
  const fork = nodeOf(synced, "fork");
  assert.deepEqual(fork.kind === "fork" && fork.paths.map((path) => path.label), ["Deep", "Quick"]);
  assert.deepEqual(synced.wires.filter((item) => item.from === "fork").map((item) => [item.port, item.to]).sort(), [[0, "proto"], [1, "walk"]]);
});

test("a fork follows every value an Input choice may hold and the flow stays savable", () => {
  for (const count of [13, MAX_CHOICES]) {
    const many = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options: Array.from({ length: count }, (_, index) => "p" + String(index)) } : field)) } : node));
    assert.equal(flowSchema.safeParse(many).success, true);
    const synced = syncForkPaths(many, "fork");
    const fork = nodeOf(synced, "fork");
    assert.equal(fork.kind === "fork" ? fork.paths.length : 0, count);
    assert.equal(flowSchema.safeParse(synced).success, true, "a synced fork with " + String(count) + " paths must save");
  }
});

test("a fix that would grow a choice past its limit is refused with the reason", () => {
  const full = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options: Array.from({ length: MAX_CHOICES }, (_, index) => "p" + String(index)) } : field)) } : node));
  const synced = syncForkPaths(full, "fork");
  const added = applyFix(synced, "fork", { kind: "add-value", value: "extra" }, UX_SKILLS);
  assert.equal(added.flow, synced);
  assert.match(added.message, /at most 40/u);
  const path = applyFix(synced, "fork", { kind: "add-path", value: "extra" }, UX_SKILLS);
  assert.equal(path.flow, synced);
  assert.match(path.message, /at most 40/u);
});

test("layout spreads the fixture into rows without overlap", () => {
  const flow = uxFlow();
  assert.equal(needsLayout(flow), true);
  const placed = layout(flow);
  assert.equal(needsLayout(placed), false);
  const y = (id: string) => nodeOf(placed, id).y;
  assert.ok(y("input") < y("frame") && y("frame") < y("journeys") && y("journeys") < y("fork") && y("fork") < y("walk") && y("walk") < y("gate"));
});

test("the history undoes and redoes edits and forgets the future on a new edit", () => {
  const a = uxFlow();
  const b = deleteNode(a, "users");
  const c = deleteNode(b, "proto");
  let history = record(record(startHistory(a), b), c);
  history = undo(history);
  assert.equal(history.present, b);
  history = undo(history);
  assert.equal(history.present, a);
  assert.equal(undo(history), history);
  history = redo(history);
  assert.equal(history.present, b);
  history = record(history, a);
  assert.deepEqual(history.future, []);
  assert.equal(redo(history), history);
});

test("the history keeps at most its limit of past states", () => {
  let history = startHistory(uxFlow());
  for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) history = record(history, { ...history.present, name: "v" + String(i) });
  assert.equal(history.past.length, HISTORY_LIMIT);
  assert.equal(history.present.name, "v" + String(HISTORY_LIMIT + 9));
});

test("the summary counts steps, stops and forks", () => {
  assert.equal(summaryText(uxFlow()), "9 steps · stops for you once · forks on depth");
  assert.equal(hasErrors(check(uxFlow(), UX_SKILLS)), false);
});
