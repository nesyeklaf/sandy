import { check, hasErrors, outputFile, sourcePort, type Problem, type SkillInfo } from "./check.ts";
import { exitLabels, inputFieldText, nodeTitle, orderedNodes, startNodes, type Binding, type Flow, type FlowNode, type ForkNode } from "./graph.ts";

export type MachineRule = { type: "outputs" } | { type: "user"; prompt: string };

export interface MachineField {
  name: string;
  description: string;
  optional: boolean;
}

export interface MachineEdge {
  to: string;
  when?: string;
}

export interface MachineStage {
  id: string;
  title: string;
  description: string;
  inputs: string[];
  outputs: MachineField[];
  gate: MachineRule[];
  next: MachineEdge[];
}

export interface Machine {
  id: string;
  title: string;
  description: string;
  start: string;
  stages: MachineStage[];
}

export type CompileResult = { ok: true; machine: Machine } | { ok: false; problems: Problem[] };

export const MAX_STAGES = 40;
export const DONE_STAGE = "done";

export function slug(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return base === "" ? fallback : base;
}

function unique(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = base + "-" + String(index);
  taken.add(candidate);
  return candidate;
}

type Exit = { label: string; target: FlowNode | null };

interface Plan {
  stageOf: Map<string, string>;
  folded: Map<string, ForkNode>;
  outputName: Map<string, string>;
}

function foldedForks(flow: Flow): Map<string, ForkNode> {
  const folded = new Map<string, ForkNode>();
  for (const node of flow.nodes) {
    if (node.kind !== "fork") continue;
    const incoming = flow.wires.filter((wire) => wire.to === node.id);
    const from = new Set(incoming.map((wire) => wire.from));
    const [only] = [...from];
    const source = only === undefined ? undefined : flow.nodes.find((item) => item.id === only);
    if (from.size !== 1 || source?.kind !== "skill" || folded.has(source.id)) continue;
    if (flow.wires.some((wire) => wire.from === source.id && wire.to !== node.id)) continue;
    folded.set(source.id, node);
  }
  return folded;
}

function planStages(flow: Flow): Plan {
  const folded = foldedForks(flow);
  const foldedIds = new Set([...folded.values()].map((fork) => fork.id));
  const taken = new Set<string>();
  const stageOf = new Map<string, string>();
  const outputName = new Map<string, string>();
  for (const node of orderedNodes(flow)) {
    if (node.kind === "input" || node.kind === "output" || foldedIds.has(node.id)) continue;
    const stage = unique(slug(nodeTitle(node), node.kind), taken);
    stageOf.set(node.id, stage);
    if (node.kind !== "skill") continue;
    const names = new Set<string>();
    for (const output of node.outputs) outputName.set(node.id + "\u0000" + output.name, unique(slug(output.name, "output"), names));
  }
  return { stageOf, folded, outputName };
}

function bindingRef(flow: Flow, plan: Plan, binding: Binding): string {
  const source = sourcePort(flow, binding);
  if (source?.node.kind === "skill") {
    const stage = plan.stageOf.get(source.node.id);
    const name = plan.outputName.get(source.node.id + "\u0000" + source.port);
    if (stage !== undefined && name !== undefined) return stage + "." + name;
  }
  return binding.port;
}

function exitsOf(flow: Flow, node: FlowNode): Exit[] {
  const byId = (id: string | undefined) => (id === undefined ? null : (flow.nodes.find((item) => item.id === id) ?? null));
  if (node.kind === "gate")
    return node.options.map((option, port) => ({ label: option, target: node.ends.includes(port) ? null : byId(flow.wires.find((wire) => wire.from === node.id && wire.port === port)?.to) }));
  if (node.kind === "fork") return exitLabels(node).map((label, port) => ({ label, target: byId(flow.wires.find((wire) => wire.from === node.id && wire.port === port)?.to) }));
  return flow.wires.filter((wire) => wire.from === node.id).map((wire) => ({ label: "", target: byId(wire.to) }));
}

function forkWhen(flow: Flow, fork: ForkNode, labels: string[]): string {
  const by = fork.choice === null ? "the choice" : (sourcePort(flow, fork.choice)?.port ?? fork.choice.port);
  return by + " is " + labels.join(" or ");
}

function routes(flow: Flow, plan: Plan, node: FlowNode, problems: Problem[]): { edges: MachineEdge[]; finishes: boolean; delivers: FlowNode[] } {
  const fork = plan.folded.get(node.id);
  const routed = fork ?? node;
  const exits = exitsOf(flow, routed);
  const groups = new Map<string, string[]>();
  const delivers: FlowNode[] = [];
  let finishes = false;
  for (const exit of exits) {
    if (exit.target === null || exit.target.kind === "output") {
      finishes = true;
      if (exit.target !== null) delivers.push(exit.target);
      continue;
    }
    const to = plan.stageOf.get(exit.target.id);
    if (to === undefined) continue;
    groups.set(to, [...(groups.get(to) ?? []), exit.label]);
  }
  if (exits.length === 0) finishes = true;
  if (routed.kind === "skill" && groups.size + (finishes && exits.length > 0 ? 1 : 0) > 1)
    problems.push({ severity: "error", nodeId: routed.id, message: nodeTitle(routed) + " leads to several blocks at once. A track runs one stage at a time: put a gate or a fork in between.", fixes: [] });
  const when = (labels: string[]) => (routed.kind === "fork" ? forkWhen(flow, routed, labels) : routed.kind === "gate" ? labels.join(" or ") : undefined);
  const branching = groups.size + (finishes ? 1 : 0) > 1;
  const edges = [...groups].map(([to, labels]) => {
    const text = branching ? when(labels) : undefined;
    return text === undefined ? { to } : { to, when: text };
  });
  return { edges, finishes, delivers };
}

function deliverText(flow: Flow, plan: Plan, outputs: readonly FlowNode[]): string {
  return outputs
    .flatMap((node) => (node.kind === "output" ? ["Deliver " + node.label + (node.source === null ? "" : " from " + bindingRef(flow, plan, node.source)) + "."] : []))
    .join(" ");
}

function joinText(parts: readonly string[]): string {
  return parts.filter((part) => part.trim() !== "").join(" ");
}

export function compile(flow: Flow, skills: readonly SkillInfo[]): CompileResult {
  const checked = check(flow, skills);
  if (hasErrors(checked)) return { ok: false, problems: checked.filter((problem) => problem.severity === "error") };
  const plan = planStages(flow);
  const problems: Problem[] = [];
  const stages: MachineStage[] = [];
  const finishing: { stage: MachineStage; delivers: FlowNode[] }[] = [];
  const allDelivers: FlowNode[] = [];
  for (const node of orderedNodes(flow)) {
    const id = plan.stageOf.get(node.id);
    if (id === undefined) continue;
    const stage: MachineStage = { id, title: nodeTitle(node), description: "", inputs: [], outputs: [], gate: [], next: [] };
    if (node.kind === "skill") {
      stage.description = joinText([node.instruction, node.skill === null ? "" : "Use the skill " + node.skill + "."]);
      stage.inputs = node.inputs.flatMap((input) => (input.bind === null ? [] : [bindingRef(flow, plan, input.bind)]));
      stage.outputs = node.outputs.map((output) => {
        const file = outputFile(output);
        return { name: plan.outputName.get(node.id + "\u0000" + output.name)!, description: file === null || file === output.name ? output.name : output.name + ", written to " + file, optional: output.optional };
      });
      if (stage.outputs.some((output) => !output.optional)) stage.gate.push({ type: "outputs" });
    }
    if (node.kind === "gate") {
      stage.description = joinText([node.question, "Answer with one of: " + node.options.join(", ") + "."]);
      stage.inputs = node.material.map((binding) => bindingRef(flow, plan, binding));
      if (node.owner !== "agent") stage.gate.push({ type: "user", prompt: node.question });
    }
    if (node.kind === "fork") {
      const by = node.choice === null ? "the choice" : (sourcePort(flow, node.choice)?.port ?? node.choice.port);
      stage.description = "Pick the path by " + by + ".";
      if (node.choice !== null) stage.inputs = [bindingRef(flow, plan, node.choice)];
    }
    const fork = plan.folded.get(node.id);
    if (fork?.choice !== null && fork !== undefined) stage.inputs = [...new Set([...stage.inputs, bindingRef(flow, plan, fork.choice)])];
    const route = routes(flow, plan, node, problems);
    stage.next = route.edges;
    allDelivers.push(...route.delivers);
    if (route.finishes) finishing.push({ stage, delivers: route.delivers });
    stages.push(stage);
  }
  const mixed = finishing.filter((item) => item.stage.next.length > 0);
  if (mixed.length > 0) {
    const doneId = unique(DONE_STAGE, new Set(stages.map((stage) => stage.id)));
    const delivers = [...new Set(allDelivers)];
    stages.push({ id: doneId, title: "Done", description: joinText([deliverText(flow, plan, delivers), "The flow is finished."]), inputs: [], outputs: [], gate: [], next: [] });
    for (const item of mixed) {
      const routed = plan.folded.get(flow.nodes.find((node) => plan.stageOf.get(node.id) === item.stage.id)?.id ?? "") ?? flow.nodes.find((node) => plan.stageOf.get(node.id) === item.stage.id);
      const labels = routed === undefined ? [] : exitsOf(flow, routed).filter((exit) => exit.target === null || exit.target.kind === "output").map((exit) => exit.label);
      const when = routed?.kind === "fork" ? forkWhen(flow, routed, labels) : labels.join(" or ");
      item.stage.next.push(when === "" ? { to: doneId } : { to: doneId, when });
    }
  }
  for (const item of finishing) if (item.stage.next.length === 0) item.stage.description = joinText([item.stage.description, deliverText(flow, plan, item.delivers)]);
  const starts = startNodes(flow);
  const first = starts.flatMap((node) => (node.kind === "input" ? flow.wires.filter((wire) => wire.from === node.id).map((wire) => wire.to) : [node.id]))[0];
  const startStage = first === undefined ? undefined : (plan.stageOf.get(first) ?? stages[0]?.id);
  const fields = starts.flatMap((node) => (node.kind === "input" ? node.fields : []));
  const begin = stages.find((stage) => stage.id === startStage);
  if (begin !== undefined && fields.length > 0) {
    begin.description = joinText(["Ask the owner first for " + fields.map(inputFieldText).join("; ") + ".", begin.description]);
    begin.inputs = [...new Set([...fields.map((field) => field.name), ...begin.inputs])];
  }
  if (stages.length === 0 || startStage === undefined) problems.push({ severity: "error", nodeId: null, message: "The flow has no step to run.", fixes: [] });
  if (stages.length > MAX_STAGES) problems.push({ severity: "error", nodeId: null, message: "The flow compiles to " + String(stages.length) + " stages; a track holds at most " + String(MAX_STAGES) + ".", fixes: [] });
  if (problems.length > 0 || startStage === undefined) return { ok: false, problems };
  return { ok: true, machine: { id: slug(flow.name, "flow"), title: flow.name, description: flow.description, start: startStage, stages } };
}
