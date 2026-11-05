import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSkill, type CompiledMachine } from "@sandy/skill-dialect";
import { machineSchema, type Machine } from "../work/track/machine.ts";
import { step, stationOf, ticketOf, type Command, type Reply, type Run } from "../work/track/run.ts";
import { migrateLinear, type Flow } from "./graph.ts";
import { fieldName, flowToSkill, skillToFlow } from "./skill-flow.ts";
import { check } from "./check.ts";
import { edit, skillNode, UX_SKILLS, uxFlow, wire } from "./ux-flow.fixture.ts";

const FIXTURES = new URL("../../../packages/skill-dialect/test/fixtures/", import.meta.url);

function machineOf(source: string): CompiledMachine {
  const parsed = parseSkill(source, "SKILL.md");
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.problems));
  if (!parsed.ok) throw new Error("unreachable");
  const valid = machineSchema.safeParse(parsed.machine);
  assert.equal(valid.success, true, valid.success ? "" : JSON.stringify(valid.error.issues));
  return parsed.machine;
}

function flowOf(source: string): Flow {
  const result = skillToFlow(source, UX_SKILLS, { useCaseId: "design" });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems));
  if (!result.ok) throw new Error("unreachable");
  return result.flow;
}

function shape(flow: Flow) {
  return {
    nodes: flow.nodes.map(({ x: _x, y: _y, ...node }) => node).sort((a, b) => a.id.localeCompare(b.id)),
    wires: flow.wires.map(({ id: _id, ...item }) => item).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

const refs = (item: { template: CompiledMachine["stages"][number]["template"] }) => item.template.flatMap((segment) => (segment.type === "ref" ? [segment.ref] : []));
const prose = (item: { template: CompiledMachine["stages"][number]["template"] }) => item.template.map((segment) => (segment.type === "text" ? segment.text : "")).join("");

const stage = (machine: CompiledMachine, id: string) => {
  const found = machine.stages.find((item) => item.id === id);
  assert.ok(found, "no stage " + id);
  return found;
};

function normalized(flow: Flow) {
  const outputIds = new Map(flow.nodes.filter((node) => node.kind === "output").map((node, index) => [node.id, "output" + index]));
  const renamed: Flow = {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.kind === "output") return { ...node, id: outputIds.get(node.id)!, label: "" };
      if (node.kind === "input") return { ...node, name: "" };
      if (node.kind === "fork") return { ...node, paths: node.paths.map((path) => ({ ...path, label: path.label.toLowerCase() })) };
      return node;
    }),
    wires: flow.wires.map((item) => ({ ...item, to: outputIds.get(item.to) ?? item.to })),
  };
  return shape(renamed);
}

test("the UX flow with its gate and fork round-trips through SKILL.md and keeps its graph", () => {
  const source = flowToSkill(uxFlow());
  machineOf(source);
  const back = flowOf(source);
  assert.equal(flowToSkill(back), source);
  assert.deepEqual(shape(flowOf(flowToSkill(back))), shape(back));
  assert.deepEqual(normalized(back), normalized(uxFlow()), "only the Input block name, fork label case and Output labels are not kept in the file");
});

for (const name of ["think-it-through", "full-control", "full-send"]) {
  test(`the ${name} fixture round-trips to the same machine`, () => {
    const source = readFileSync(new URL(name + ".md", FIXTURES), "utf8");
    const result = skillToFlow(source, [], { useCaseId: "x" });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems));
    if (!result.ok) return;
    const written = flowToSkill(result.flow);
    assert.deepEqual(machineOf(written), machineOf(source));
    assert.equal(flowToSkill(flowOf(written)), written);
  });
}

test("the UX flow becomes stages with skills, bound inputs, fork conditions and an owner gate that ends in done", () => {
  const machine = machineOf(flowToSkill(uxFlow()));
  assert.equal(machine.start ?? machine.stages[0]?.id, "frame");
  assert.deepEqual(machine.stages.map((item) => item.id), ["frame", "users", "journeys", "fork", "proto", "walk", "gate"]);
  assert.deepEqual(machine.inputs?.map((field) => field.name), ["feature", "depth"]);
  assert.deepEqual(refs(stage(machine, "frame")), ["input.feature"]);
  assert.deepEqual(refs(stage(machine, "walk")), ["journeys.journeys_md"]);
  assert.match(prose(stage(machine, "walk")), /^Use the skill ux-walkthrough\./u);
  assert.deepEqual(stage(machine, "fork").next.map((edge) => edge.to), ["walk", "proto"]);
  assert.ok(stage(machine, "fork").next.every((edge) => edge.cond !== undefined));
  const gate = stage(machine, "gate");
  assert.deepEqual(gate.gate, [{ type: "user" }]);
  assert.deepEqual(gate.outputs.map((output) => [output.name, output.by]), [["Answer", "owner"]]);
  assert.deepEqual(gate.next.map((edge) => edge.to), ["done", "journeys"]);
  assert.ok(gate.next.every((edge) => edge.cond !== undefined));
  assert.deepEqual(machine.result, [{ name: "ux_brief_md", from: "journeys.journeys_md" }]);
  assert.deepEqual(stage(machine, "frame").gate, [{ type: "outputs" }]);
});

test("an agent gate needs no owner approval and answers that all finish merge into one edge to done", () => {
  const agent = edit(uxFlow(), "gate", (node) => (node.kind === "gate" ? { ...node, owner: "agent" } : node));
  const gate = stage(machineOf(flowToSkill(agent)), "gate");
  assert.deepEqual(gate.gate, []);
  const finished = { ...uxFlow(), wires: [...uxFlow().wires.filter((item) => item.id !== "w11"), wire("w11", "gate", "out", 1)] };
  assert.deepEqual(stage(machineOf(flowToSkill(finished)), "gate").next.map((edge) => [edge.to, edge.cond?.fn]), [["done", "or"]]);
  assert.equal(flowToSkill(flowOf(flowToSkill(finished))), flowToSkill(finished));
});

test("a gate answer marked as an end goes to done with the other finishing answer", () => {
  const flow = uxFlow();
  const ends = edit({ ...flow, wires: flow.wires.filter((item) => item.id !== "w11") }, "gate", (node) => (node.kind === "gate" ? { ...node, ends: [1] } : node));
  assert.deepEqual(stage(machineOf(flowToSkill(ends)), "gate").next.map((edge) => [edge.to, edge.cond?.fn]), [["done", "or"]]);
});

test("a migrated linear flow becomes a chain of stages with unique ids and its notes as stage text", () => {
  const flow = migrateLinear({ id: "l", useCaseId: "u", name: "Quick plan!", description: "", steps: [{ skill: "ux-walkthrough", note: "look closely" }, { skill: "ux-walkthrough", note: "" }] });
  const source = flowToSkill(flow);
  const machine = machineOf(source);
  assert.equal(machine.id, "l");
  assert.equal(machine.title, "Quick plan!");
  assert.deepEqual(machine.stages.map((item) => [item.id, item.next.map((edge) => edge.to)]), [["ux-walkthrough", ["ux-walkthrough-2"]], ["ux-walkthrough-2", []]]);
  assert.match(prose(machine.stages[0]!), /look closely/u);
  assert.equal(flowToSkill(flowOf(source)), source);
});

test("an Input name with a dot becomes a field name the dialect accepts", () => {
  assert.equal(fieldName("feature.name"), "feature_name");
  assert.equal(fieldName("1st"), "F1st");
  const renamed = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "feature" ? { ...field, name: "feature.name" } : field)) } : node));
  const flow = edit(renamed, "frame", (node) => (node.kind === "skill" ? { ...node, inputs: node.inputs.map((input) => ({ ...input, bind: input.bind === null ? null : { ...input.bind, port: "feature.name" } })) } : node));
  assert.deepEqual(refs(stage(machineOf(flowToSkill(flow)), "frame")), ["input.feature_name"]);
});

test("an Otherwise path becomes the fork's unconditional last edge", () => {
  const flow = edit({ ...uxFlow(), wires: [...uxFlow().wires, wire("w12", "fork", "proto", 3)] }, "fork", (node) => (node.kind === "fork" ? { ...node, otherwise: { label: "Otherwise", note: "" } } : node));
  const source = flowToSkill(flow);
  const next = stage(machineOf(source), "fork").next;
  assert.equal(next.at(-1)?.to, "proto");
  assert.equal(next.at(-1)?.cond, undefined);
  assert.equal(flowToSkill(flowOf(source)), source);
});

function trackRunner(machine: Machine) {
  const ids = { newRunId: () => "run1" };
  let current: Run | null = null;
  const send = (command: Command): Reply => {
    const out = step(current, command, 1_000_000, ids);
    current = out.run === null ? null : step(out.run, { by: "system", op: "published", rev: out.run.rev }, 1_000_000, ids).run;
    return out.reply;
  };
  const run = (): Run => {
    if (current === null) throw new Error("no run");
    return current;
  };
  const ticket = (): string => {
    const now = run();
    if (now.state.kind !== "active") throw new Error("the run is not active");
    return ticketOf(now, now.state.lease);
  };
  return { send, run, ticket, station: () => stationOf(run()) };
}

test("the track engine starts a converted flow with its inputs and walks it to the owner gate", () => {
  const machine = machineSchema.parse(machineOf(flowToSkill(uxFlow())));
  const runner = trackRunner(machine);
  const started = runner.send({ by: "agent", op: "start", source: { kind: "skill", skill: "ux", machine }, inputs: { feature: "search", depth: "quick" } });
  assert.notEqual(started.kind, "refused", JSON.stringify(started));
  assert.equal(runner.station()?.stage, "frame");
});

test("a fork reached from several blocks is its own routing stage and a one-answer agent gate passes straight on", () => {
  const flow = uxFlow();
  const shared: Flow = {
    ...flow,
    wires: [...flow.wires.filter((item) => item.id !== "w4" && item.id !== "w11"), wire("w4", "journeys", "gate2"), wire("w11", "gate", "fork", 1), wire("w13", "gate2", "fork", 0)],
    nodes: [...flow.nodes, { id: "gate2", kind: "gate", question: "Ready?", x: 0, y: 0, owner: "agent", options: ["yes"], material: [], ends: [], answer: "Answer" }],
  };
  const machine = machineOf(flowToSkill(shared));
  assert.deepEqual(stage(machine, "gate2").next, [{ to: "fork" }]);
  assert.deepEqual([stage(machine, "gate2").gate, stage(machine, "gate2").outputs], [[], []]);
  assert.deepEqual(stage(machine, "fork").next.map((edge) => edge.to), ["walk", "proto"]);
  assert.deepEqual(stage(machine, "gate").next.map((edge) => edge.to), ["done", "fork"]);
});

test("a skill wired to two blocks at once is a Check error, so it never becomes a track", () => {
  const flow = uxFlow();
  const extra = { ...skillNode("extra", "ux-walkthrough"), name: "Extra", skill: null, instruction: "look around", inputs: [], outputs: [] };
  const problems = check({ ...flow, nodes: [...flow.nodes, extra], wires: [...flow.wires, wire("w12", "frame", "extra"), wire("w13", "extra", "users")] }, UX_SKILLS);
  assert.match(problems.filter((problem) => problem.severity === "error").map((problem) => problem.message).join("\n"), /frame-the-problem leads to several blocks at once/u);
});
