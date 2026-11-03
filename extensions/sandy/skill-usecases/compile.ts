import { check, hasErrors, outputFile, sourcePort, type Problem, type SkillInfo } from "./check.ts";
import { exitLabels, inputFieldText, nodeTitle, orderedNodes, startNodes, type Binding, type Flow, type FlowNode, type ForkNode, type OutputNode } from "./graph.ts";

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

type Exit = { port: number; target: FlowNode | null };

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

export function freeInputName(name: string): string {
  return name.replace(/\./gu, "·");
}

function bindingRef(flow: Flow, plan: Plan, binding: Binding): string {
  const source = sourcePort(flow, binding);
  if (source?.node.kind === "skill") {
    const stage = plan.stageOf.get(source.node.id);
    const name = plan.outputName.get(source.node.id + "\u0000" + source.port);
    if (stage !== undefined && name !== undefined) return stage + "." + name;
  }
  return freeInputName(binding.port);
}

function bindingFile(flow: Flow, binding: Binding): string {
  const source = sourcePort(flow, binding);
  if (source?.node.kind !== "skill") return source?.port ?? binding.port;
  const output = source.node.outputs.find((item) => item.name === source.port);
  return output === undefined ? source.port : (outputFile(output) ?? source.port);
}

function exitsOf(flow: Flow, node: FlowNode): Exit[] {
  const byId = (id: string | undefined) => (id === undefined ? null : (flow.nodes.find((item) => item.id === id) ?? null));
  const wired = (port: number) => byId(flow.wires.find((wire) => wire.from === node.id && wire.port === port)?.to);
  if (node.kind === "gate") return node.options.map((_, port) => ({ port, target: node.ends.includes(port) ? null : wired(port) }));
  if (node.kind === "fork") return exitLabels(node).map((_, port) => ({ port, target: wired(port) }));
  return flow.wires.filter((wire) => wire.from === node.id).map((wire) => ({ port: wire.port, target: byId(wire.to) }));
}

function forkWhen(flow: Flow, fork: ForkNode, ports: readonly number[]): string {
  const source = fork.choice === null ? null : sourcePort(flow, fork.choice);
  const by = fork.choice === null ? "the choice" : (source?.port ?? fork.choice.port);
  const named = ports.flatMap((port) => {
    const path = fork.paths[port];
    return path === undefined ? [] : [path.label];
  });
  if (!ports.includes(fork.paths.length) || fork.otherwise === null) return by + " is " + named.join(" or ");
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const values = source?.type.kind === "choice" ? source.type.values : [];
  const unmatched = values.filter((value) => !fork.paths.some((path) => same(path.label, value)));
  if (unmatched.length > 0) return by + " is " + [...named, ...unmatched].join(" or ");
  const rest = by + " is none of " + fork.paths.map((path) => path.label).join(", ");
  return named.length === 0 ? rest : by + " is " + named.join(" or ") + ", or " + rest;
}

function whenOf(flow: Flow, routed: FlowNode, ports: readonly number[]): string | undefined {
  if (routed.kind === "fork") return forkWhen(flow, routed, ports);
  if (routed.kind === "gate") return ports.flatMap((port) => (routed.options[port] === undefined ? [] : [routed.options[port]])).join(" or ");
  return undefined;
}

interface Route {
  key: string;
  to: string | null;
  output: OutputNode | null;
  ports: number[];
}

function routes(flow: Flow, plan: Plan, node: FlowNode, problems: Problem[]): { routed: FlowNode; routes: Route[] } {
  const routed = plan.folded.get(node.id) ?? node;
  const exits = exitsOf(flow, routed);
  const found = new Map<string, Route>();
  const add = (key: string, route: Omit<Route, "key" | "ports">, port: number | null) => {
    const known = found.get(key) ?? { key, ...route, ports: [] };
    if (port !== null) known.ports.push(port);
    found.set(key, known);
  };
  if (exits.length === 0) add(FINISH + "end", { to: null, output: null }, null);
  for (const exit of exits) {
    if (exit.target === null) add(FINISH + "end", { to: null, output: null }, exit.port);
    else if (exit.target.kind === "output") add(FINISH + exit.target.id, { to: null, output: exit.target }, exit.port);
    else {
      const to = plan.stageOf.get(exit.target.id);
      if (to !== undefined) add("stage:" + to, { to, output: null }, exit.port);
    }
  }
  const all = [...found.values()];
  if (routed.kind === "skill" && all.length > 1)
    problems.push({ severity: "error", nodeId: routed.id, message: nodeTitle(routed) + " leads to several blocks at once. A track runs one stage at a time: put a gate or a fork in between.", fixes: [] });
  return { routed, routes: [...all.filter((route) => route.to !== null), ...all.filter((route) => route.to === null)] };
}

const FINISH = "finish:";

function deliverText(flow: Flow, plan: Plan, output: OutputNode | null): string {
  if (output === null) return "";
  return "Deliver " + output.label + (output.source === null ? "" : " from " + bindingRef(flow, plan, output.source)) + ".";
}

function joinText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => (/[.!?:]$/u.test(part) ? part : part + "."))
    .join(" ");
}

export function compile(flow: Flow, skills: readonly SkillInfo[]): CompileResult {
  const checked = check(flow, skills);
  if (hasErrors(checked)) return { ok: false, problems: checked.filter((problem) => problem.severity === "error") };
  const plan = planStages(flow);
  const problems: Problem[] = [];
  const stages: MachineStage[] = [];
  const pending: { stage: MachineStage; routed: FlowNode; route: Route }[] = [];
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
      if (node.owner !== "agent") {
        const names = new Set<string>();
        stage.outputs = node.material.map((binding) => {
          const file = bindingFile(flow, binding);
          return { name: unique(slug(file, "file"), names), description: "Show the owner " + file + " from " + bindingRef(flow, plan, binding) + ": its path and what to look at", optional: false };
        });
        if (stage.outputs.length > 0) {
          stage.description = joinText([stage.description, "Before you ask, submit each file to show so the owner sees it in the approval form."]);
          stage.gate.push({ type: "outputs" });
        }
        stage.gate.push({ type: "user", prompt: node.question });
      }
    }
    if (node.kind === "fork") {
      const by = node.choice === null ? "the choice" : (sourcePort(flow, node.choice)?.port ?? node.choice.port);
      stage.description = "Pick the path by " + by + ".";
      if (node.choice !== null) stage.inputs = [bindingRef(flow, plan, node.choice)];
    }
    const fork = plan.folded.get(node.id);
    if (fork?.choice !== null && fork !== undefined) stage.inputs = [...new Set([...stage.inputs, bindingRef(flow, plan, fork.choice)])];
    const routing = routes(flow, plan, node, problems);
    const branching = routing.routes.length > 1;
    for (const route of routing.routes) {
      if (route.to === null) {
        if (branching) pending.push({ stage, routed: routing.routed, route });
        else stage.description = joinText([stage.description, deliverText(flow, plan, route.output)]);
        continue;
      }
      const when = branching ? whenOf(flow, routing.routed, route.ports) : undefined;
      stage.next.push(when === undefined ? { to: route.to } : { to: route.to, when });
    }
    stages.push(stage);
  }
  const finishes = [...new Map(pending.map((item) => [item.route.key, item.route.output] as const))];
  const taken = new Set(stages.map((stage) => stage.id));
  const doneOf = new Map<string, string>();
  for (const [key, output] of finishes) {
    const id = finishes.length === 1 || output === null ? unique(DONE_STAGE, taken) : unique(slug(DONE_STAGE + " " + output.label, DONE_STAGE), taken);
    doneOf.set(key, id);
    const title = finishes.length === 1 || output === null ? "Done" : "Done: " + output.label;
    stages.push({ id, title, description: joinText([deliverText(flow, plan, output), "The flow is finished."]), inputs: [], outputs: [], gate: [], next: [] });
  }
  for (const item of pending) {
    const to = doneOf.get(item.route.key)!;
    const when = whenOf(flow, item.routed, item.route.ports);
    item.stage.next.push(when === undefined || when === "" ? { to } : { to, when });
  }
  const starts = startNodes(flow);
  const first = starts.flatMap((node) => (node.kind === "input" ? flow.wires.filter((wire) => wire.from === node.id).map((wire) => wire.to) : [node.id]))[0];
  const startStage = first === undefined ? undefined : (plan.stageOf.get(first) ?? stages[0]?.id);
  const fields = starts.flatMap((node) => (node.kind === "input" ? node.fields : []));
  const begin = stages.find((stage) => stage.id === startStage);
  if (begin !== undefined && fields.length > 0) {
    begin.description = joinText(["Ask the owner first for " + fields.map(inputFieldText).join("; ") + ".", begin.description]);
    begin.inputs = [...new Set([...fields.map((field) => freeInputName(field.name)), ...begin.inputs])];
  }
  if (stages.length === 0 || startStage === undefined) problems.push({ severity: "error", nodeId: null, message: "The flow has no step to run.", fixes: [] });
  if (stages.length > MAX_STAGES) problems.push({ severity: "error", nodeId: null, message: "The flow compiles to " + String(stages.length) + " stages; a track holds at most " + String(MAX_STAGES) + ".", fixes: [] });
  if (problems.length > 0 || startStage === undefined) return { ok: false, problems };
  return { ok: true, machine: { id: slug(flow.name, "flow"), title: flow.name, description: flow.description, start: startStage, stages } };
}
