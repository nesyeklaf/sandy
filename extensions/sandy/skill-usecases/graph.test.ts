import { test } from "node:test";
import assert from "node:assert/strict";
import { backWires, flowSchema, linearSteps, migrateLinear, orderedNodes, storedFlowSchema, upgradeFlow, withLinearSteps } from "./graph.ts";

const v1 = { id: "f", useCaseId: "build", name: "Ship", description: "d", steps: [{ skill: "quick-plan", note: "plan it" }, { skill: "quick-send", note: "" }] };

test("migrateLinear turns each step into a skill node wired in order, note as instruction", () => {
  const flow = migrateLinear(v1);
  assert.equal(flowSchema.safeParse(flow).success, true);
  assert.deepEqual(
    flow.nodes.map((node) => (node.kind === "skill" ? [node.id, node.skill, node.instruction, node.inputs.length, node.outputs.length] : null)),
    [["s1", "quick-plan", "plan it", 0, 0], ["s2", "quick-send", "", 0, 0]],
  );
  assert.deepEqual(flow.wires, [{ id: "w1", from: "s1", port: 0, to: "s2" }]);
  assert.deepEqual(linearSteps(flow), v1.steps);
  assert.deepEqual(migrateLinear({ ...v1, steps: [] }).nodes, []);
});

test("stored flows parse in both shapes and v1 is upgraded once", () => {
  const stored = storedFlowSchema.parse(v1);
  assert.deepEqual(upgradeFlow(stored), migrateLinear(v1));
  const v2 = migrateLinear(v1);
  assert.deepEqual(upgradeFlow(storedFlowSchema.parse(v2)), v2);
});

test("the schema rejects duplicate ids and wires to missing nodes", () => {
  const flow = migrateLinear(v1);
  assert.equal(flowSchema.safeParse({ ...flow, nodes: [flow.nodes[0], flow.nodes[0]] }).success, false);
  assert.equal(flowSchema.safeParse({ ...flow, wires: [{ id: "w1", from: "s1", port: 0, to: "nope" }] }).success, false);
});

test("withLinearSteps keeps the IO snapshot of skills that stay and reorders the chain", () => {
  const flow = migrateLinear(v1);
  const first = flow.nodes[0];
  assert.equal(first?.kind, "skill");
  if (first?.kind !== "skill") return;
  first.outputs = [{ name: "Plan", optional: false, type: { kind: "file", path: "plan.md" }, path: null, description: "", byOwner: false }];
  const next = withLinearSteps(flow, [{ skill: "quick-send", note: "" }, { skill: "quick-plan", note: "again" }]);
  assert.deepEqual(linearSteps(next), [{ skill: "quick-send", note: "" }, { skill: "quick-plan", note: "again" }]);
  const kept = next.nodes.find((node) => node.id === "s1");
  assert.equal(kept?.kind === "skill" ? kept.outputs[0]?.name : null, "Plan");
});

test("orderedNodes follows forward wires and a loop back is a back wire, which makes the flow non-linear", () => {
  const flow = migrateLinear({ ...v1, steps: [{ skill: "c", note: "" }, { skill: "a", note: "" }, { skill: "b", note: "" }] });
  const shuffled = { ...flow, nodes: [flow.nodes[2]!, flow.nodes[0]!, flow.nodes[1]!] };
  assert.deepEqual(orderedNodes(shuffled).map((node) => node.id), ["s1", "s2", "s3"]);
  const looped = { ...flow, wires: [...flow.wires, { id: "back", from: "s3", port: 0, to: "s1" }] };
  assert.deepEqual([...backWires(looped)], ["back"]);
  assert.equal(linearSteps(looped), null);
});
