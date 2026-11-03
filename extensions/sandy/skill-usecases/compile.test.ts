import { test } from "node:test";
import assert from "node:assert/strict";
import { machineSchema } from "../work/track/machine.ts";
import { check } from "./check.ts";
import { compile, slug } from "./compile.ts";
import { migrateLinear, type Flow } from "./graph.ts";
import { edit, skillNode, UX_SKILLS, uxFlow, wire } from "./ux-flow.fixture.ts";

function machineOf(flow: Flow) {
  const result = compile(flow, UX_SKILLS);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems.map((problem) => problem.message)));
  if (!result.ok) throw new Error("unreachable");
  const parsed = machineSchema.safeParse(result.machine);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  return result.machine;
}

const stage = (machine: ReturnType<typeof machineOf>, id: string) => {
  const found = machine.stages.find((item) => item.id === id);
  assert.ok(found, "no stage " + id);
  return found;
};

test("prototype B's seed flow compiles to a valid machine with the depth fork and the keep/fix loop as branches", () => {
  const machine = machineOf(uxFlow());
  assert.equal(machine.start, "frame-the-problem");
  assert.deepEqual(machine.stages.map((item) => item.id), ["frame-the-problem", "ux-users", "ux-journeys", "prototype", "ux-walkthrough", "keep-the-journeys-or-fix-them", "done"]);
  assert.deepEqual(stage(machine, "ux-journeys").next, [
    { to: "ux-walkthrough", when: "depth is Quick or Medium" },
    { to: "prototype", when: "depth is Deep" },
  ]);
  const gate = stage(machine, "keep-the-journeys-or-fix-them");
  assert.deepEqual(gate.next, [
    { to: "ux-journeys", when: "fix" },
    { to: "done", when: "keep" },
  ]);
  assert.deepEqual(gate.gate, [{ type: "user", prompt: "Keep the journeys or fix them?" }]);
  assert.deepEqual(gate.inputs, ["ux-walkthrough.walkthrough-report-md"]);
  assert.deepEqual(stage(machine, "ux-walkthrough").inputs, ["ux-journeys.journeys-md"]);
  assert.match(stage(machine, "done").description, /Deliver ux_brief.md from ux-journeys.journeys-md/u);
  const first = stage(machine, "frame-the-problem");
  assert.deepEqual(first.inputs, ["feature", "depth"]);
  assert.match(first.description, /Ask the owner first for feature: What feature should the flow design\?; depth \(quick, medium, deep\)/u);
  assert.deepEqual(first.gate, [{ type: "outputs" }]);
});

test("compile refuses a flow with Check errors and returns only the errors", () => {
  const broken = edit(uxFlow(), "out", (node) => (node.kind === "output" ? { ...node, source: null } : node));
  const result = compile(broken, UX_SKILLS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.length > 0 && result.problems.every((problem) => problem.severity === "error"));
  assert.match(result.problems[0]!.message, /choose the file this Output delivers/u);
});

test("warnings do not block compiling", () => {
  const flow = edit(uxFlow(), "fork", (node) => (node.kind === "fork" ? { ...node, paths: node.paths.map((path) => ({ ...path, note: "" })) } : node));
  machineOf(flow);
});

test("a fork reached from several blocks becomes its own routing stage", () => {
  const flow = uxFlow();
  const shared: Flow = { ...flow, wires: [...flow.wires.filter((item) => item.id !== "w4" && item.id !== "w11"), wire("w4", "journeys", "gate2"), wire("w11", "gate", "fork", 1), wire("w13", "gate2", "fork", 0)], nodes: [...flow.nodes, { id: "gate2", kind: "gate", question: "Ready?", x: 0, y: 0, owner: "agent", options: ["yes"], material: [], ends: [] }] };
  const machine = machineOf(shared);
  const fork = stage(machine, "fork-by-depth");
  assert.deepEqual(fork.inputs, ["depth"]);
  assert.deepEqual(fork.next, [
    { to: "ux-walkthrough", when: "depth is Quick or Medium" },
    { to: "prototype", when: "depth is Deep" },
  ]);
  assert.deepEqual(stage(machine, "ready").gate, [], "an agent gate needs no owner approval");
  assert.deepEqual(stage(machine, "ready").next, [{ to: "fork-by-depth" }]);
});

test("a migrated linear flow with empty IO snapshots compiles despite drift warnings", () => {
  const flow = migrateLinear({ id: "l", useCaseId: "u", name: "Quick plan!", description: "", steps: [{ skill: "ux-walkthrough", note: "look closely" }, { skill: "ux-walkthrough", note: "" }] });
  assert.deepEqual([...new Set(check(flow, UX_SKILLS).map((problem) => problem.severity))], ["warn"]);
  const machine = machineOf(flow);
  assert.equal(machine.id, "quick-plan");
  assert.deepEqual(machine.stages.map((item) => [item.id, item.next]), [["ux-walkthrough", [{ to: "ux-walkthrough-2" }]], ["ux-walkthrough-2", []]]);
  assert.match(machine.stages[0]!.description, /^look closely Use the skill ux-walkthrough\.$/u);
});

test("a stage whose every exit finishes is final and names what it delivers", () => {
  const flow = uxFlow();
  const finished: Flow = { ...flow, wires: flow.wires.filter((item) => item.id !== "w11") };
  const ends = edit(finished, "gate", (node) => (node.kind === "gate" ? { ...node, ends: [1] } : node));
  const machine = machineOf(ends);
  assert.equal(machine.stages.some((item) => item.id === "done"), false);
  const gate = stage(machine, "keep-the-journeys-or-fix-them");
  assert.deepEqual(gate.next, []);
  assert.match(gate.description, /Deliver ux_brief.md/u);
});

test("a skill wired to two blocks at once cannot become a track", () => {
  const flow = uxFlow();
  const extra = { ...skillNode("extra", "ux-walkthrough"), name: "Extra", skill: null, instruction: "look around", inputs: [], outputs: [] };
  const result = compile({ ...flow, nodes: [...flow.nodes, extra], wires: [...flow.wires, wire("w12", "frame", "extra"), wire("w13", "extra", "users")] }, UX_SKILLS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.problems.map((problem) => problem.message).join("\n"), /frame-the-problem leads to several blocks at once/u);
});

test("slug makes valid stage ids and falls back for empty names", () => {
  assert.equal(slug("Keep the journeys or fix them?", "gate"), "keep-the-journeys-or-fix-them");
  assert.equal(slug("???", "gate"), "gate");
  assert.match(slug("x".repeat(80), "s"), /^[a-z0-9][a-z0-9_-]{0,47}$/u);
});
