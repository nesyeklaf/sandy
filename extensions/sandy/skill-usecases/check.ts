import { formatIo, formatType, satisfies, type IoField, type IoType } from "./io.ts";
import {
  backWires,
  exitLabels,
  nodeTitle,
  orderedNodes,
  startNodes,
  wireAt,
  type Binding,
  type Flow,
  type FlowNode,
  type ForkNode,
  type GateNode,
  type InputField,
  type SkillNode,
  type Wire,
} from "./graph.ts";

export interface SkillInfo {
  name: string;
  purpose: string;
  inputs: IoField[];
  outputs: IoField[];
}

export type FixAction =
  | { kind: "use-skill"; skill: string }
  | { kind: "pick-skill" }
  | { kind: "sync-skill" }
  | { kind: "delete-node" }
  | { kind: "connect-after"; nodeId: string }
  | { kind: "bind"; input: string; source: Binding }
  | { kind: "unbind"; input: string }
  | { kind: "finish-here"; port: number }
  | { kind: "add-output"; port: number }
  | { kind: "add-path"; value: string }
  | { kind: "remove-value"; value: string }
  | { kind: "add-value"; value: string }
  | { kind: "remove-path"; port: number }
  | { kind: "label-skip"; port: number }
  | { kind: "remove-wire"; wireId: string }
  | { kind: "insert-gate"; wireId: string }
  | { kind: "override-path"; output: string }
  | { kind: "require-output"; nodeId: string; output: string }
  | { kind: "optional-input"; input: string };

export interface Fix {
  label: string;
  action: FixAction;
}

export interface Problem {
  severity: "error" | "warn";
  nodeId: string | null;
  message: string;
  fixes: Fix[];
}

export interface SourcePort {
  node: FlowNode;
  port: string;
  type: IoType;
}

export function inputFieldType(field: InputField): IoType {
  if (field.type === "choice") return { kind: "choice", values: [...field.options] };
  if (field.type === "file") return { kind: "file", path: field.path === "" ? null : field.path };
  return { kind: field.type };
}

export function sourcePort(flow: Flow, binding: Binding): SourcePort | null {
  const node = flow.nodes.find((item) => item.id === binding.nodeId);
  if (node?.kind === "skill") {
    const output = node.outputs.find((item) => item.name === binding.port);
    return output === undefined ? null : { node, port: output.name, type: output.type };
  }
  if (node?.kind === "input") {
    const field = node.fields.find((item) => item.name === binding.port);
    return field === undefined ? null : { node, port: field.name, type: inputFieldType(field) };
  }
  return null;
}

export function outputFile(output: SkillNode["outputs"][number]): string | null {
  if (output.type.kind !== "file") return output.path;
  return output.path ?? output.type.path ?? output.name;
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

export function nearestSkill(name: string, skills: readonly SkillInfo[]): SkillInfo | null {
  let best: SkillInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const skill of skills) {
    const value = distance(name, skill.name);
    if (value < bestDistance) {
      best = skill;
      bestDistance = value;
    }
  }
  return bestDistance <= Math.max(3, Math.ceil(name.length / 3)) ? best : null;
}

interface Shape {
  flow: Flow;
  byId: Map<string, FlowNode>;
  back: Set<string>;
  forward: Wire[];
  reachable: Set<string>;
  dominators: Map<string, Set<string>>;
}

function reach(wires: readonly Wire[], starts: readonly string[], direction: "down" | "up"): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const wire of wires) {
      const [from, to] = direction === "down" ? [wire.from, wire.to] : [wire.to, wire.from];
      if (from === id && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

function entryIds(flow: Flow): string[] {
  const starts = startNodes(flow);
  const hasInputs = starts.some((node) => node.kind === "input");
  return hasInputs ? starts.map((node) => node.id) : starts.slice(0, 1).map((node) => node.id);
}

function shapeOf(flow: Flow): Shape {
  const back = backWires(flow);
  const forward = flow.wires.filter((wire) => !back.has(wire.id) && wire.from !== wire.to);
  const roots = entryIds(flow);
  const reachable = new Set([...roots, ...reach(flow.wires, roots, "down")]);
  const all = flow.nodes.map((node) => node.id).filter((id) => reachable.has(id));
  const dominators = new Map<string, Set<string>>();
  for (const id of all) dominators.set(id, roots.includes(id) ? new Set([id]) : new Set(all));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of all) {
      if (roots.includes(id)) continue;
      const preds = forward.filter((wire) => wire.to === id && dominators.has(wire.from)).map((wire) => dominators.get(wire.from)!);
      if (preds.length === 0) continue;
      const next = new Set([...preds[0]!].filter((candidate) => preds.every((set) => set.has(candidate))));
      next.add(id);
      if (next.size !== dominators.get(id)!.size) {
        dominators.set(id, next);
        changed = true;
      }
    }
  }
  return { flow, byId: new Map(flow.nodes.map((node) => [node.id, node] as const)), back, forward, reachable, dominators };
}

function branchSets(shape: Shape, node: FlowNode): Set<string>[] {
  return exitLabels(node).map((_, port) => {
    const wire = shape.forward.find((item) => item.from === node.id && item.port === port);
    return wire === undefined ? new Set<string>() : new Set([wire.to, ...reach(shape.forward, [wire.to], "down")]);
  });
}

function pathGap(shape: Shape, source: FlowNode, target: FlowNode): string | null {
  if (source.kind === "input") return null;
  const dominators = shape.dominators.get(target.id);
  if (dominators === undefined || dominators.has(source.id)) return null;
  for (const branch of shape.flow.nodes) {
    if ((branch.kind !== "fork" && branch.kind !== "gate") || branch.id === source.id || branch.id === target.id) continue;
    const sets = branchSets(shape, branch);
    const labels = exitLabels(branch);
    if (!sets.some((set) => set.has(source.id)) || sets.every((set) => set.has(source.id)) || !sets.some((set) => set.has(target.id))) continue;
    const word = branch.kind === "fork" ? "path" : "option";
    const present = labels.filter((_, index) => sets[index]!.has(source.id));
    const missing = labels.filter((_, index) => !sets[index]!.has(source.id));
    return "only produced on " + word + " " + present.join(", ") + " (missing on " + missing.join(", ") + ")";
  }
  return "only produced on some paths into " + nodeTitle(target);
}

function candidates(shape: Shape, target: FlowNode, type: IoType): SourcePort[] {
  const upstream = reach(shape.flow.wires, [target.id], "up");
  const dominators = shape.dominators.get(target.id) ?? new Set<string>();
  const order = orderedNodes(shape.flow).map((node) => node.id);
  const found: SourcePort[] = [];
  for (const node of shape.flow.nodes) {
    if (node.id === target.id || !upstream.has(node.id)) continue;
    if (node.kind !== "input" && !dominators.has(node.id)) continue;
    const ports = node.kind === "skill" ? node.outputs.map((output) => ({ port: output.name, type: output.type })) : node.kind === "input" ? node.fields.map((field) => ({ port: field.name, type: inputFieldType(field) })) : [];
    for (const port of ports) if (satisfies(port.type, type)) found.push({ node, ...port });
  }
  return found.sort((a, b) => order.indexOf(b.node.id) - order.indexOf(a.node.id));
}

export function bindCandidates(flow: Flow, target: FlowNode, type: IoType): SourcePort[] {
  return candidates(shapeOf(flow), target, type);
}

function bindFix(shape: Shape, target: FlowNode, input: string, type: IoType, current: Binding | null): Fix[] {
  const alternative = candidates(shape, target, type).find((item) => current === null || item.node.id !== current.nodeId || item.port !== current.port);
  if (alternative === undefined) return [];
  return [{ label: "Bind to " + nodeTitle(alternative.node) + " › " + alternative.port, action: { kind: "bind", input, source: { nodeId: alternative.node.id, port: alternative.port } } }];
}

function checkBinding(shape: Shape, target: FlowNode, input: string, need: IoType | null, binding: Binding, problems: Problem[]): void {
  const title = nodeTitle(target);
  const source = sourcePort(shape.flow, binding);
  const error = (message: string, fixes: Fix[]) => problems.push({ severity: "error", nodeId: target.id, message, fixes });
  const unbind: Fix = { label: "Unbind", action: { kind: "unbind", input } };
  if (source === null) {
    error(title + ': "' + input + '" is bound to an output that no longer exists', [...(need === null ? [] : bindFix(shape, target, input, need, binding)), unbind]);
    return;
  }
  if (need !== null && !satisfies(source.type, need)) {
    error(
      title + ': type mismatch, "' + input + '" needs ' + formatType(need) + " but " + nodeTitle(source.node) + " › " + source.port + " makes " + formatType(source.type),
      [...bindFix(shape, target, input, need, binding), unbind],
    );
    return;
  }
  if (!reach(shape.flow.wires, [target.id], "up").has(source.node.id)) {
    error(title + ': "' + input + '" reads from ' + nodeTitle(source.node) + ", which does not run before it", [unbind]);
    return;
  }
  const gap = pathGap(shape, source.node, target);
  if (gap !== null) error(title + ': input "' + input + '" is ' + gap, need === null ? [unbind] : [...bindFix(shape, target, input, need, binding), unbind]);
}

function checkGuaranteed(shape: Shape, target: SkillNode, input: string, need: IoType, binding: Binding, problems: Problem[]): void {
  const source = shape.byId.get(binding.nodeId);
  if (source?.kind !== "skill") return;
  const output = source.outputs.find((item) => item.name === binding.port);
  if (output === undefined || !output.optional) return;
  const alternative = candidates(shape, target, need).find((item) => item.node.kind !== "skill" || item.node.outputs.some((other) => other.name === item.port && !other.optional));
  problems.push({
    severity: "error",
    nodeId: target.id,
    message:
      target.name + ': input "' + input + '" is required, but ' + source.name + " › " + output.name + " is optional, so the run can reach " + target.name + " without it. Make the output required or the input optional.",
    fixes: [
      ...(source.skill === null ? [{ label: "Make " + output.name + " required", action: { kind: "require-output", nodeId: source.id, output: output.name } } as const] : []),
      ...(target.skill === null ? [{ label: "Make " + input + " optional", action: { kind: "optional-input", input } } as const] : []),
      ...(alternative === undefined ? [] : [{ label: "Bind to " + nodeTitle(alternative.node) + " › " + alternative.port, action: { kind: "bind", input, source: { nodeId: alternative.node.id, port: alternative.port } } } as const]),
    ],
  });
}

function bindingsOf(node: FlowNode): Binding[] {
  switch (node.kind) {
    case "skill":
      return node.inputs.flatMap((input) => (input.bind === null ? [] : [input.bind]));
    case "gate":
      return node.material;
    case "fork":
    case "output": {
      const binding = node.kind === "fork" ? node.choice : node.source;
      return binding === null ? [] : [binding];
    }
    default:
      return [];
  }
}

function checkSkill(shape: Shape, node: SkillNode, skills: readonly SkillInfo[], problems: Problem[]): void {
  if (node.skill !== null) {
    const info = skills.find((skill) => skill.name === node.skill);
    if (info === undefined) {
      const near = nearestSkill(node.skill, skills);
      problems.push({
        severity: "error",
        nodeId: node.id,
        message: node.name + ": Skill not found: " + node.skill + ". It may have been renamed or deleted.",
        fixes: [
          ...(near === null ? [] : [{ label: "Use " + near.name, action: { kind: "use-skill", skill: near.name } } as const]),
          { label: "Pick another", action: { kind: "pick-skill" } },
          { label: "Delete " + node.name, action: { kind: "delete-node" } },
        ],
      });
    } else {
      const mine = { inputs: formatIo(node.inputs), outputs: formatIo(node.outputs) };
      const theirs = { inputs: formatIo(info.inputs), outputs: formatIo(info.outputs) };
      const said = (text: string) => (text === "" ? "nothing" : text);
      const covers = (own: readonly IoField[], skill: readonly IoField[]) => skill.every((field) => own.some((item) => item.name === field.name && formatType(item.type) === formatType(field.type)));
      const extended = covers(node.outputs, info.outputs) && (node.inputs.length === 0 || covers(node.inputs, info.inputs));
      const message = extended
        ? null
        : mine.outputs !== theirs.outputs
          ? node.skill + " now outputs " + said(theirs.outputs) + ", not " + said(mine.outputs)
          : mine.inputs !== theirs.inputs
            ? node.skill + " now takes " + said(theirs.inputs) + ", not " + said(mine.inputs)
            : null;
      const relied = node.inputs.some((input) => input.bind !== null) || shape.flow.nodes.some((other) => bindingsOf(other).some((binding) => binding.nodeId === node.id));
      if (message !== null)
        problems.push({
          severity: relied ? "error" : "warn",
          nodeId: node.id,
          message: message + ". Blocks that read it need rebinding.",
          fixes: [{ label: "Rebind to " + node.skill + " as it is now", action: { kind: "sync-skill" } }],
        });
    }
  }
  for (const input of node.inputs) {
    if (input.bind !== null) {
      checkBinding(shape, node, input.name, input.type, input.bind, problems);
      if (!input.optional) checkGuaranteed(shape, node, input.name, input.type, input.bind, problems);
      continue;
    }
    if (input.optional) continue;
    const fixes = bindFix(shape, node, input.name, input.type, null);
    const fed = fixes.length > 0 ? "" : " and cannot be fed: no earlier block makes a " + formatType(input.type) + " output";
    problems.push({ severity: "error", nodeId: node.id, message: node.name + ': input "' + input.name + '" is not bound' + fed, fixes });
  }
}

function checkGate(shape: Shape, node: GateNode, problems: Problem[]): void {
  for (const binding of node.material) checkBinding(shape, node, "files to show", null, binding, problems);
  node.options.forEach((option, port) => {
    if (wireAt(shape.flow, node.id, port) !== undefined || node.ends.includes(port)) return;
    problems.push({
      severity: "error",
      nodeId: node.id,
      message: node.question + ': "' + option + '" leads nowhere: the run would stop here',
      fixes: [
        { label: "Finish here", action: { kind: "finish-here", port } },
        { label: "Add Output after " + option, action: { kind: "add-output", port } },
      ],
    });
  });
}

function checkFork(shape: Shape, node: ForkNode, problems: Problem[]): void {
  const error = (message: string, fixes: Fix[] = []) => problems.push({ severity: "error", nodeId: node.id, message, fixes });
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const source = node.choice === null ? null : sourcePort(shape.flow, node.choice);
  if (node.choice === null) error(node.name + ": choose the Input value that picks the path");
  else if (source === null || source.node.kind !== "input" || source.type.kind !== "choice") error(node.name + ": the path must be picked by a choice value of an Input block");
  else {
    const values = source.type.values;
    const where = nodeTitle(source.node) + " › " + source.port;
    for (const value of values) {
      if (node.paths.some((path) => same(path.label, value)) || node.otherwise !== null) continue;
      error(source.port + " '" + value + "' has no path in " + node.name, [
        { label: "Add path '" + value + "'", action: { kind: "add-path", value } },
        { label: "Remove value '" + value + "'", action: { kind: "remove-value", value } },
      ]);
    }
    node.paths.forEach((path, port) => {
      if (values.some((value) => same(value, path.label))) return;
      error(node.name + ": path " + path.label + " can never be chosen, " + where + ' has no value "' + path.label + '"', [
        { label: "Add '" + path.label + "' to " + nodeTitle(source.node), action: { kind: "add-value", value: path.label } },
        { label: "Remove path " + path.label, action: { kind: "remove-path", port } },
      ]);
    });
  }
  const exits = [...node.paths, ...(node.otherwise === null ? [] : [node.otherwise])];
  const targets = exits.map((_, port) => wireAt(shape.flow, node.id, port)?.to ?? null);
  const downstream = targets.map((target) => (target === null ? new Set<string>() : new Set([target, ...reach(shape.forward, [target], "down")])));
  exits.forEach((path, port) => {
    const target = targets[port];
    if (target === null || target === undefined) {
      error(node.name + ': path "' + path.label + '" is not connected');
      return;
    }
    const empty = downstream.some((set, other) => other !== port && set.has(target));
    if (empty && path.note.trim() === "")
      problems.push({
        severity: "warn",
        nodeId: node.id,
        message: node.name + ': path "' + path.label + '" is empty. Name it (for example "skip"), or add a block on it.',
        fixes: [{ label: 'Label it "skip"', action: { kind: "label-skip", port } }],
      });
  });
}

function checkReach(shape: Shape, problems: Problem[]): void {
  const flow = shape.flow;
  const incoming = new Set(flow.wires.map((wire) => wire.to));
  const roots = entryIds(flow);
  const tails = flow.nodes.filter((node) => node.kind !== "output" && node.kind !== "input" && shape.reachable.has(node.id) && !flow.wires.some((wire) => wire.from === node.id));
  const tail = tails.at(-1);
  const connect = (node: FlowNode): Fix[] => [
    ...(tail === undefined || tail.id === node.id || node.kind === "input" ? [] : [{ label: "Connect after " + nodeTitle(tail), action: { kind: "connect-after", nodeId: tail.id } } as const]),
    { label: "Delete " + nodeTitle(node), action: { kind: "delete-node" } },
  ];
  for (const node of flow.nodes) {
    const title = nodeTitle(node);
    if (roots.includes(node.id)) continue;
    if (node.kind === "input") continue;
    if (node.kind === "output" && node.source !== null && shape.reachable.has(node.source.nodeId)) continue;
    if (!incoming.has(node.id)) problems.push({ severity: "error", nodeId: node.id, message: title + ": unreachable, nothing leads into it so it would never run", fixes: connect(node) });
    else if (!shape.reachable.has(node.id)) problems.push({ severity: "error", nodeId: node.id, message: title + ": unreachable from the start of the flow", fixes: connect(node) });
  }
  const entries = new Set(
    roots.flatMap((id) => {
      const node = shape.byId.get(id);
      return node?.kind === "input" ? flow.wires.filter((wire) => wire.from === id).map((wire) => wire.to) : [id];
    }),
  );
  if (entries.size > 1) problems.push({ severity: "error", nodeId: null, message: "The flow starts in " + String(entries.size) + " places. Let one Input lead to one first step.", fixes: [] });
  for (const node of flow.nodes) {
    if (flow.wires.some((wire) => wire.from === node.id)) continue;
    if (node.kind === "input" && flow.nodes.length > 1)
      problems.push({ severity: "error", nodeId: node.id, message: node.name + ": nothing follows it, so the run has no first step", fixes: [] });
    if (node.kind === "skill" && flow.nodes.some((other) => other.kind !== "skill"))
      problems.push({ severity: "warn", nodeId: node.id, message: node.name + ": nothing follows it, the run ends here", fixes: [] });
  }
}

function checkLoops(shape: Shape, problems: Problem[]): void {
  for (const wire of shape.flow.wires) {
    if (!shape.back.has(wire.id) && wire.from !== wire.to) continue;
    const down = new Set([wire.to, ...reach(shape.forward, [wire.to], "down")]);
    const up = new Set([wire.from, ...reach(shape.forward, [wire.from], "up")]);
    const loop = [...down].filter((id) => up.has(id));
    if (wire.max !== undefined) continue;
    if (loop.some((id) => { const item = shape.byId.get(id); return item?.kind === "gate" || (item?.kind === "skill" && item.ownerApproves); })) continue;
    const from = shape.byId.get(wire.from);
    const to = shape.byId.get(wire.to);
    if (from === undefined || to === undefined) continue;
    problems.push({
      severity: "error",
      nodeId: from.id,
      message: nodeTitle(from) + " leads back to " + nodeTitle(to) + " with no gate, so the flow would repeat forever. Only a gate can send it back.",
      fixes: [
        { label: "Remove the loop wire", action: { kind: "remove-wire", wireId: wire.id } },
        { label: "Ask first (insert a gate)", action: { kind: "insert-gate", wireId: wire.id } },
      ],
    });
  }
}

function checkPaths(shape: Shape, problems: Problem[]): void {
  const writers: { node: SkillNode; output: string; file: string }[] = [];
  for (const node of orderedNodes(shape.flow)) {
    if (node.kind !== "skill") continue;
    for (const output of node.outputs) {
      const file = outputFile(output);
      if (file !== null) writers.push({ node, output: output.name, file });
    }
  }
  writers.forEach((later, index) => {
    const earlier = writers.slice(0, index).find((item) => item.file === later.file && item.node.id !== later.node.id && reach(shape.forward, [item.node.id], "down").has(later.node.id));
    if (earlier === undefined) return;
    problems.push({
      severity: "error",
      nodeId: later.node.id,
      message: later.node.name + " and " + earlier.node.name + " both write " + later.file + ", so " + later.node.name + " would overwrite it. Give one of them another path.",
      fixes: [{ label: "Change the path of " + later.output, action: { kind: "override-path", output: later.output } }],
    });
  });
}

export function check(flow: Flow, skills: readonly SkillInfo[]): Problem[] {
  const problems: Problem[] = [];
  if (flow.nodes.length === 0) return [{ severity: "error", nodeId: null, message: "The flow is empty.", fixes: [] }];
  if (entryIds(flow).length === 0) problems.push({ severity: "error", nodeId: null, message: "Every block has something leading into it, so nothing starts the flow. Add an Input block.", fixes: [] });
  const shape = shapeOf(flow);
  for (const node of flow.nodes) {
    if (node.kind === "skill") checkSkill(shape, node, skills, problems);
    if (node.kind === "skill" && flow.wires.filter((wire) => wire.from === node.id && wire.when === undefined).length > 1)
      problems.push({ severity: "error", nodeId: node.id, message: node.name + " leads to several blocks at once. A track runs one step at a time, so chain them or put a Fork in between.", fixes: [] });
    if (node.kind === "gate") checkGate(shape, node, problems);
    if (node.kind === "fork") checkFork(shape, node, problems);
    if (node.kind === "output") {
      if (node.source === null) problems.push({ severity: "error", nodeId: node.id, message: node.label + ": choose the file this Output delivers", fixes: [] });
      else if (flow.wires.some((wire) => wire.to === node.id)) checkBinding(shape, node, "content", null, node.source, problems);
      else if (sourcePort(flow, node.source) === null) problems.push({ severity: "error", nodeId: node.id, message: node.label + ": delivers an output that no longer exists", fixes: [] });
    }
  }
  checkReach(shape, problems);
  checkLoops(shape, problems);
  checkPaths(shape, problems);
  return problems;
}
