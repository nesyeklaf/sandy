import { test } from "node:test";
import assert from "node:assert/strict";
import { machineSchema } from "../work/track/machine.ts";
import { check } from "./check.ts";
import { compile, slug } from "./compile.ts";
import { migrateLinear, type Flow } from "./graph.ts";
import { edit, skillNode, UX_SKILLS, uxFlow, wire } from "./ux-flow.fixture.ts";
import { desired, step, stationOf, ticketOf, type Command, type Reply, type Run } from "../work/track/run.ts";
import type { Machine } from "../work/track/machine.ts";

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
  send({ by: "agent", op: "start", source: { kind: "adhoc", machine } });
  const proposed = run().state;
  if (proposed.kind !== "proposed") throw new Error("the run did not ask for approval");
  send({ by: "system", op: "answered", runId: run().runId, ticket: null, formId: proposed.formId, approved: true });
  const submit = (outputs: Record<string, string>): Reply => send({ by: "agent", op: "submit", ticket: ticket(), outputs });
  return {
    run,
    station: () => stationOf(run()),
    submit,
    advance: (to?: string): Reply => send({ by: "agent", op: "advance", ticket: ticket(), ...(to === undefined ? {} : { to }) }),
    submitAll: () => {
      const view = stationOf(run());
      const outputs = run().machine.stages.find((item) => item.id === view?.stage)?.outputs ?? [];
      if (outputs.length > 0) submit(Object.fromEntries(outputs.map((output) => [output.name, "/work/" + output.name])));
    },
  };
}

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
  assert.deepEqual(gate.gate, [{ type: "outputs" }, { type: "user", prompt: "Keep the journeys or fix them?" }]);
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

test("a stage whose every exit finishes in the same Output is final and names what it delivers", () => {
  const flow = uxFlow();
  const finished: Flow = { ...flow, wires: [...flow.wires.filter((item) => item.id !== "w11"), wire("w11", "gate", "out", 1)] };
  const machine = machineOf(finished);
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

function twoOutputs(): Flow {
  const flow = uxFlow();
  const gated = edit({ ...flow, wires: flow.wires.filter((item) => item.id !== "w11") }, "gate", (node) => (node.kind === "gate" ? { ...node, options: ["brief", "report"] } : node));
  return {
    ...gated,
    nodes: [...gated.nodes, { id: "out2", kind: "output", label: "report.md", x: 0, y: 0, source: { nodeId: "walk", port: "walkthrough_report.md" }, deliverable: true }],
    wires: [...gated.wires, wire("w12", "gate", "out2", 1)],
  };
}

test("gate answers that lead to different Outputs reach separate done stages that each deliver only their own file", () => {
  const machine = machineOf(twoOutputs());
  const gate = stage(machine, "keep-the-journeys-or-fix-them");
  assert.deepEqual(gate.next, [
    { to: "done-ux-brief-md", when: "brief" },
    { to: "done-report-md", when: "report" },
  ]);
  assert.doesNotMatch(gate.description, /Deliver/u);
  const brief = stage(machine, "done-ux-brief-md");
  assert.match(brief.description, /Deliver ux_brief.md from ux-journeys.journeys-md/u);
  assert.doesNotMatch(brief.description, /report.md/u);
  const report = stage(machine, "done-report-md");
  assert.match(report.description, /Deliver report.md from ux-walkthrough.walkthrough-report-md/u);
  assert.doesNotMatch(report.description, /ux_brief/u);
  assert.deepEqual([brief.next, report.next], [[], []]);
});

test("an answer that finishes without an Output does not deliver the file of another answer", () => {
  const flow = uxFlow();
  const ends = edit({ ...flow, wires: flow.wires.filter((item) => item.id !== "w11") }, "gate", (node) => (node.kind === "gate" ? { ...node, ends: [1] } : node));
  const machine = machineOf(ends);
  assert.deepEqual(stage(machine, "keep-the-journeys-or-fix-them").next, [
    { to: "done-ux-brief-md", when: "keep" },
    { to: "done", when: "fix" },
  ]);
  assert.doesNotMatch(stage(machine, "done").description, /Deliver/u);
  assert.match(stage(machine, "done-ux-brief-md").description, /Deliver ux_brief.md/u);
});

test("an owner gate asks the agent to submit each file to show, so the approval form lists them", () => {
  const gate = stage(machineOf(uxFlow()), "keep-the-journeys-or-fix-them");
  assert.deepEqual(gate.outputs.map((output) => [output.name, output.optional]), [["walkthrough-report-md", false]]);
  assert.match(gate.outputs[0]!.description, /walkthrough_report.md/u);
  assert.deepEqual(gate.gate, [{ type: "outputs" }, { type: "user", prompt: "Keep the journeys or fix them?" }]);
  const agentGate = stage(machineOf(edit(uxFlow(), "gate", (node) => (node.kind === "gate" ? { ...node, owner: "agent" } : node))), "keep-the-journeys-or-fix-them");
  assert.deepEqual([agentGate.outputs, agentGate.gate], [[], []]);
});

test("the gate approval form of a compiled flow shows the files to show", () => {
  const machine = machineOf(uxFlow());
  const runner = trackRunner(machine);
  for (const to of ["ux-users", "ux-journeys", "ux-walkthrough", "keep-the-journeys-or-fix-them"]) {
    runner.submitAll();
    assert.equal(runner.advance(to).kind, "entered");
  }
  runner.submit({ "walkthrough-report-md": "/work/walkthrough_report.md: two issues found" });
  assert.equal(runner.advance("done").kind, "pending");
  const ask = desired(runner.run()).find((effect) => effect.kind === "ask");
  assert.ok(ask !== undefined && ask.kind === "ask");
  assert.match(JSON.stringify(ask.form.payload), /walkthrough-report-md.*\/work\/walkthrough_report.md: two issues found/u);
});

test("an Input name with a dot compiles to an input the track cannot mistake for a stage output", () => {
  const renamed = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "feature" ? { ...field, name: "feature.name" } : field)) } : node));
  const flow = edit(renamed, "frame", (node) => (node.kind === "skill" ? { ...node, inputs: node.inputs.map((input) => ({ ...input, bind: input.bind === null ? null : { ...input.bind, port: "feature.name" } })) } : node));
  assert.deepEqual(check(flow, UX_SKILLS), []);
  const first = stage(machineOf(flow), "frame-the-problem");
  assert.deepEqual(first.inputs, ["feature·name", "depth"]);
});

test("an Otherwise path compiles to the choice values no other path names", () => {
  const huge = edit(uxFlow(), "input", (node) => (node.kind === "input" ? { ...node, fields: node.fields.map((field) => (field.name === "depth" ? { ...field, options: [...field.options, "huge"] } : field)) } : node));
  const flow = edit({ ...huge, wires: [...huge.wires, wire("w12", "fork", "walk", 3)] }, "fork", (node) => (node.kind === "fork" ? { ...node, otherwise: { label: "Otherwise", note: "skip" } } : node));
  assert.deepEqual(stage(machineOf(flow), "ux-journeys").next, [
    { to: "ux-walkthrough", when: "depth is Quick or Medium or huge" },
    { to: "prototype", when: "depth is Deep" },
  ]);
  const covered = edit({ ...uxFlow(), wires: [...uxFlow().wires, wire("w12", "fork", "proto", 3)] }, "fork", (node) => (node.kind === "fork" ? { ...node, otherwise: { label: "Otherwise", note: "" } } : node));
  const next = stage(machineOf(covered), "ux-journeys").next;
  assert.deepEqual(next[1], { to: "prototype", when: "depth is Deep, or depth is none of Quick, Medium, Deep" });
  assert.equal(next.some((edge) => edge.when?.includes("Otherwise")), false);
});

test("slug makes valid stage ids and falls back for empty names", () => {
  assert.equal(slug("Keep the journeys or fix them?", "gate"), "keep-the-journeys-or-fix-them");
  assert.equal(slug("???", "gate"), "gate");
  assert.match(slug("x".repeat(80), "s"), /^[a-z0-9][a-z0-9_-]{0,47}$/u);
});
