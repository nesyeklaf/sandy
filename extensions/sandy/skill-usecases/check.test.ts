import { test } from "node:test";
import assert from "node:assert/strict";
import { check, hasErrors, nearestSkill, type Problem } from "./check.ts";
import { migrateLinear, type Flow, type FlowNode } from "./graph.ts";
import { edit, skillNode, UX_SKILLS, uxFlow, wire } from "./ux-flow.fixture.ts";

const run = (flow: Flow) => check(flow, UX_SKILLS);

function find(problems: Problem[], pattern: RegExp): Problem {
  const hit = problems.find((problem) => pattern.test(problem.message));
  assert.ok(hit, "expected a problem matching " + String(pattern) + ", got: " + JSON.stringify(problems.map((problem) => problem.message)));
  return hit;
}

function none(problems: Problem[], pattern: RegExp): void {
  assert.equal(problems.filter((problem) => pattern.test(problem.message)).length, 0, JSON.stringify(problems.map((problem) => problem.message)));
}

const bindInput = (flow: Flow, nodeId: string, input: string, bind: [string, string] | null) =>
  edit(flow, nodeId, (node) =>
    node.kind === "skill"
      ? { ...node, inputs: node.inputs.map((item) => (item.name === input ? { ...item, bind: bind === null ? null : { nodeId: bind[0], port: bind[1] } } : item)) }
      : node,
  );

const withoutWire = (flow: Flow, id: string): Flow => ({ ...flow, wires: flow.wires.filter((item) => item.id !== id) });
const fork = (flow: Flow, change: (node: Extract<FlowNode, { kind: "fork" }>) => FlowNode) => edit(flow, "fork", (node) => (node.kind === "fork" ? change(node) : node));
const depthOptions = (flow: Flow, options: string[]) =>
  edit(flow, "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options } : field)) } : node));

test("prototype B's seed flow checks clean", () => {
  assert.deepEqual(run(uxFlow()), []);
});

test("an empty flow is an error", () => {
  const problems = run({ ...uxFlow(), nodes: [], wires: [] });
  find(problems, /flow is empty/u);
  assert.equal(hasErrors(problems), true);
});

test("a flow where every block has an incoming wire has no start", () => {
  const loop = migrateLinear({ id: "l", useCaseId: "u", name: "L", description: "", steps: [{ skill: "ux-users", note: "" }, { skill: "prototype", note: "" }] });
  find(run({ ...loop, wires: [...loop.wires, wire("back", "s2", "s1")] }), /nothing starts the flow/u);
  none(run(loop), /nothing starts the flow/u);
});

test("a missing skill is an error with the nearest skill as fix", () => {
  const flow = edit(uxFlow(), "users", (node) => (node.kind === "skill" ? { ...node, skill: "ux-user" } : node));
  const problem = find(run(flow), /Skill not found: ux-user\./u);
  assert.deepEqual(problem.fixes[0], { label: "Use ux-users", action: { kind: "use-skill", skill: "ux-users" } });
  assert.equal(nearestSkill("zzzzzzzzzzzz", UX_SKILLS), null);
  none(run(uxFlow()), /Skill not found/u);
});

test("an ad hoc skill block needs no installed skill", () => {
  const flow = edit(uxFlow(), "users", (node) => (node.kind === "skill" ? { ...node, skill: null, instruction: "interview two users" } : node));
  none(run(flow), /Skill not found/u);
});

test("a skill whose IO changed since the snapshot asks for a rebind", () => {
  const flow = edit(uxFlow(), "proto", (node) => (node.kind === "skill" ? { ...node, outputs: [{ name: "mock", optional: false, type: { kind: "file", path: null }, path: null, description: "", byOwner: false }] } : node));
  const problem = find(run(flow), /prototype now outputs prototypes: file, not mock: file/u);
  assert.equal(problem.fixes[0]?.action.kind, "sync-skill");
  assert.equal(problem.severity, "error");
  const unbound = edit(flow, "proto", (node) => (node.kind === "skill" ? { ...node, inputs: node.inputs.map((input) => ({ ...input, bind: null, optional: true })) } : node));
  assert.equal(find(run(unbound), /prototype now outputs/u).severity, "warn");
});

test("a required input that is not bound is an error with the nearest matching output as fix", () => {
  const problem = find(run(bindInput(uxFlow(), "users", "frame", null)), /ux-users: input "frame" is not bound$/u);
  assert.deepEqual(problem.fixes[0]?.action, { kind: "bind", input: "frame", source: { nodeId: "frame", port: "frame.md" } });
  none(run(bindInput(uxFlow(), "journeys", "users", null)), /not bound/u);
});

test("a required input that nothing upstream can feed says so", () => {
  const flow = bindInput(uxFlow(), "frame", "feature", null);
  const cut = edit(flow, "input", (node) => (node.kind === "input" ? { ...node, fields: [] } : node));
  find(run(cut), /"feature" is not bound and cannot be fed: no earlier block makes a text output/u);
});

test("a binding to an output that no longer exists is an error", () => {
  find(run(bindInput(uxFlow(), "users", "frame", ["frame", "gone.md"])), /bound to an output that no longer exists/u);
});

test("a binding whose type does not satisfy the input is an error", () => {
  const problems = run(bindInput(uxFlow(), "proto", "journeys", ["input", "feature"]));
  const problem = find(problems, /type mismatch, "journeys" needs file but Run settings › feature makes text/u);
  assert.deepEqual(problem.fixes[0]?.action, { kind: "bind", input: "journeys", source: { nodeId: "journeys", port: "journeys.md" } });
});

test("a binding to a block that runs later is an error", () => {
  find(run(bindInput(uxFlow(), "users", "frame", ["walk", "walkthrough_report.md"])), /reads from ux-walkthrough, which does not run before it/u);
});

test("a binding to an output made on only some fork paths is an error naming the paths", () => {
  const problems = run(bindInput(uxFlow(), "walk", "artifact", ["proto", "prototypes"]));
  find(problems, /input "artifact" is only produced on path Deep \(missing on Quick, Medium\)/u);
});

const adHoc = (flow: Flow, id: string, change: (node: Extract<FlowNode, { kind: "skill" }>) => FlowNode) => edit(flow, id, (node) => (node.kind === "skill" ? change({ ...node, skill: null }) : node));

test("a required input bound to an optional output is an error with fixes on both sides", () => {
  const flow = adHoc(uxFlow(), "frame", (node) => ({ ...node, outputs: node.outputs.map((output) => ({ ...output, optional: true })) }));
  const problem = find(run(flow), /ux-users: input "frame" is required, but frame-the-problem › frame.md is optional/u);
  assert.equal(problem.severity, "error");
  assert.equal(problem.nodeId, "users");
  assert.deepEqual(problem.fixes.map((fix) => fix.action), [{ kind: "require-output", nodeId: "frame", output: "frame.md" }]);
  const both = adHoc(flow, "users", (node) => node);
  assert.deepEqual(
    find(run(both), /ux-users: input "frame" is required/u).fixes.map((fix) => fix.label),
    ["Make frame.md required", "Make frame optional"],
  );
  none(run(adHoc(flow, "users", (node) => ({ ...node, inputs: node.inputs.map((input) => ({ ...input, optional: true })) }))), /ux-users: input "frame" is required/u);
});

test("a gate option with no wire and no finish is an error; finishing there passes", () => {
  const cut = withoutWire(uxFlow(), "w10");
  const problem = find(run(cut), /"keep" leads nowhere/u);
  assert.deepEqual(problem.fixes.map((fix) => fix.action.kind), ["finish-here", "add-output"]);
  const finished = edit(cut, "gate", (node) => (node.kind === "gate" ? { ...node, ends: [0] } : node));
  none(run(finished), /leads nowhere/u);
});

test("a fork needs a choice value of an Input block", () => {
  find(run(fork(uxFlow(), (node) => ({ ...node, choice: null }))), /choose the Input value that picks the path/u);
  find(run(fork(uxFlow(), (node) => ({ ...node, choice: { nodeId: "frame", port: "frame.md" } }))), /picked by a choice value of an Input block/u);
});

test("a choice value without a path is an error unless the fork has an otherwise path", () => {
  const flow = depthOptions(uxFlow(), ["quick", "medium", "deep", "huge"]);
  const problem = find(run(flow), /depth 'huge' has no path in Fork by depth/u);
  assert.deepEqual(problem.fixes.map((fix) => fix.action.kind), ["add-path", "remove-value"]);
  const otherwise = fork(flow, (node) => ({ ...node, otherwise: { label: "Other", note: "skip" } }));
  none(run({ ...otherwise, wires: [...otherwise.wires, wire("w12", "fork", "walk", 3)] }), /has no path/u);
});

test("a fork path that no value can pick is an error", () => {
  const problem = find(run(depthOptions(uxFlow(), ["quick", "medium"])), /path Deep can never be chosen, Run settings › depth has no value "Deep"/u);
  assert.deepEqual(problem.fixes.map((fix) => fix.action.kind), ["add-value", "remove-path"]);
});

test("a fork path without a wire is an error", () => {
  find(run(withoutWire(uxFlow(), "w7")), /path "Deep" is not connected/u);
});

test("an empty fork path without a name is a warning", () => {
  const flow = fork(uxFlow(), (node) => ({ ...node, paths: node.paths.map((path, index) => (index === 0 ? { ...path, note: "" } : path)) }));
  const problem = find(run(flow), /path "Quick" is empty/u);
  assert.equal(problem.severity, "warn");
  assert.equal(hasErrors(run(flow)), false);
});

test("a block nothing leads into is unreachable, with a connect fix", () => {
  const flow = { ...uxFlow(), nodes: [...uxFlow().nodes, skillNode("lonely", "ux-users", { frame: ["frame", "frame.md"] })] };
  const problem = find(run(flow), /ux-users: unreachable, nothing leads into it/u);
  assert.equal(problem.nodeId, "lonely");
  assert.equal(problem.fixes.at(-1)?.action.kind, "delete-node");
});

test("a cycle cut off from the start is unreachable", () => {
  const flow = uxFlow();
  const island = { ...flow, nodes: [...flow.nodes, skillNode("a", "ux-walkthrough"), skillNode("b", "ux-walkthrough")], wires: [...flow.wires, wire("x1", "a", "b"), wire("x2", "b", "a")] };
  find(run(island), /unreachable from the start of the flow/u);
});

test("an input that leads to two first steps starts the flow in two places", () => {
  const flow = uxFlow();
  find(run({ ...flow, wires: [...flow.wires, wire("w12", "input", "users")] }), /starts in 2 places/u);
});

test("an Input with nothing after it is an error", () => {
  const flow = uxFlow();
  find(run(withoutWire(flow, "w1")), /Run settings: nothing follows it/u);
});

test("a skill with nothing after it in a branching flow is a warning", () => {
  const problem = find(run(withoutWire(uxFlow(), "w9")), /ux-walkthrough: nothing follows it, the run ends here/u);
  assert.equal(problem.severity, "warn");
  const linear = migrateLinear({ id: "l", useCaseId: "u", name: "L", description: "", steps: [{ skill: "ux-users", note: "" }] });
  none(run(linear), /nothing follows it/u);
});

test("a loop without a gate is an error; a loop through a gate passes", () => {
  const linear = migrateLinear({ id: "l", useCaseId: "u", name: "L", description: "", steps: [{ skill: "ux-walkthrough", note: "" }, { skill: "ux-walkthrough", note: "" }] });
  const flow: Flow = { ...linear, nodes: [{ id: "input", kind: "input", name: "Start", x: 0, y: 0, fields: [] }, ...linear.nodes], wires: [wire("in", "input", "s1"), ...linear.wires, wire("back", "s2", "s1")] };
  const problem = find(run(flow), /leads back to ux-walkthrough with no gate/u);
  assert.deepEqual(problem.fixes.map((fix) => fix.action), [{ kind: "remove-wire", wireId: "back" }, { kind: "insert-gate", wireId: "back" }]);
  none(run(uxFlow()), /with no gate/u);
});

test("two blocks writing the same file are an error only when one runs after the other", () => {
  const overwrite = edit(uxFlow(), "proto", (node) => (node.kind === "skill" ? { ...node, outputs: node.outputs.map((output) => ({ ...output, path: "journeys.md" })) } : node));
  const problem = find(run(overwrite), /prototype and ux-journeys both write journeys.md/u);
  assert.deepEqual(problem.fixes[0]?.action, { kind: "override-path", output: "prototypes" });
  const parallel: Flow = {
    ...uxFlow(),
    nodes: [
      { id: "input", kind: "input", name: "Start", x: 0, y: 0, fields: [{ name: "mode", type: "choice", options: ["a", "b"], prompt: "" }] },
      { id: "fork", kind: "fork", name: "By mode", x: 0, y: 0, choice: { nodeId: "input", port: "mode" }, paths: [{ label: "a", note: "" }, { label: "b", note: "" }], otherwise: null },
      skillNode("one", "prototype"),
      skillNode("two", "prototype"),
      { id: "out", kind: "output", label: "Result", x: 0, y: 0, source: { nodeId: "one", port: "prototypes" }, deliverable: true },
    ],
    wires: [wire("w1", "input", "fork"), wire("w2", "fork", "one", 0), wire("w3", "fork", "two", 1), wire("w4", "one", "out"), wire("w5", "two", "out")],
  };
  none(run(parallel), /both write/u);
});

test("an Output without a source is an error", () => {
  find(run(edit(uxFlow(), "out", (node) => (node.kind === "output" ? { ...node, source: null } : node))), /ux_brief.md: choose the file this Output delivers/u);
});
