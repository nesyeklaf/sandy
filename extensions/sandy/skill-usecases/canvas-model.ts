import { bindCandidates, inputFieldType, outputFile, sourcePort, type FixAction, type SkillInfo, type SourcePort } from "./check.ts";
import { backWires, exitLabels, nodeTitle, wireAt, type Binding, type Flow, type FlowNode, type ForkNode, type GateNode, type SkillNode, type Wire } from "./graph.ts";
import { satisfies, type IoType } from "./io.ts";

export const NODE_W = 240;
export const NODE_H = 44;
export const PATH_W = 132;
export const GAP_X = 40;
export const GAP_Y = 64;
export const HISTORY_LIMIT = 150;

export type BlockKind = "skill" | "input" | "gate" | "fork" | "output";

export type PaletteItem = { kind: "skill"; skill: SkillInfo | null } | { kind: Exclude<BlockKind, "skill"> };

export type Placement = { kind: "free"; x: number; y: number } | { kind: "after"; nodeId: string; port: number } | { kind: "wire"; wireId: string };

export interface Edit {
  flow: Flow;
  nodeId: string | null;
  message: string;
}

export const BLOCKS: readonly { kind: Exclude<BlockKind, "skill">; title: string; purpose: string }[] = [
  { kind: "gate", title: "Gate", purpose: "Pause until someone decides; each option is an exit" },
  { kind: "input", title: "Input", purpose: "Values the run starts with, such as feature or depth" },
  { kind: "output", title: "Output", purpose: "The result the flow produces" },
  { kind: "fork", title: "Fork", purpose: "Choose a path by a value; the paths rejoin later" },
];

export const AD_HOC_SKILL = { title: "Skill", purpose: "Ad hoc step: describe what the agent should do" };

export function nodeWidth(node: FlowNode): number {
  if (node.kind !== "gate" && node.kind !== "fork") return NODE_W;
  return Math.max(NODE_W, exitLabels(node).length * PATH_W);
}

export function exitPoint(node: FlowNode, port: number): { x: number; y: number } {
  const count = Math.max(1, exitLabels(node).length);
  const width = nodeWidth(node);
  return { x: node.x + (width * (2 * port + 1)) / (2 * count), y: node.y + NODE_H };
}

export function entryPoint(node: FlowNode): { x: number; y: number } {
  return { x: node.x + nodeWidth(node) / 2, y: node.y };
}

function freshId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) if (!used.has(prefix + String(n))) return prefix + String(n);
}

function nodeIdFor(flow: Flow): string {
  return freshId(flow.nodes.map((node) => node.id), "n");
}

function wireIds(flow: Flow): (count: number) => string[] {
  return (count) => {
    const taken = flow.wires.map((wire) => wire.id);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(freshId([...taken, ...ids], "w"));
    return ids;
  };
}

export function skillIo(info: SkillInfo): Pick<SkillNode, "inputs" | "outputs"> {
  return {
    inputs: info.inputs.map((input) => ({ ...input, bind: null })),
    outputs: info.outputs.map((output) => ({ ...output, path: null })),
  };
}

export function makeNode(item: PaletteItem, id: string, x: number, y: number): FlowNode {
  const at = { id, x: Math.round(x), y: Math.round(y) };
  switch (item.kind) {
    case "skill":
      return item.skill === null
        ? { ...at, kind: "skill", name: "New skill", skill: null, instruction: "", inputs: [], outputs: [{ name: "result", optional: false, type: { kind: "text" }, path: null }] }
        : { ...at, kind: "skill", name: item.skill.name, skill: item.skill.name, instruction: "", ...skillIo(item.skill) };
    case "gate":
      return { ...at, kind: "gate", question: "Approve or reject?", owner: "owner", options: ["approve", "reject"], material: [], ends: [] };
    case "input":
      return { ...at, kind: "input", name: "Input", fields: [{ name: "value", type: "text", options: [], prompt: "What should this value be?" }] };
    case "output":
      return { ...at, kind: "output", label: "Output", source: null, deliverable: true };
    case "fork":
      return {
        ...at,
        kind: "fork",
        name: "Fork",
        choice: null,
        paths: [
          { label: "Quick", note: "" },
          { label: "Medium", note: "" },
          { label: "Deep", note: "" },
        ],
        otherwise: null,
      };
  }
}

function resolve(flow: Flow, placement: Placement): { from: FlowNode; port: number; old: Wire | undefined; to: FlowNode | undefined } | null {
  if (placement.kind === "free") return null;
  const wire = placement.kind === "wire" ? flow.wires.find((item) => item.id === placement.wireId) : wireAt(flow, placement.nodeId, placement.port);
  const fromId = placement.kind === "wire" ? wire?.from : placement.nodeId;
  const from = flow.nodes.find((node) => node.id === fromId);
  if (from === undefined || (placement.kind === "wire" && wire === undefined)) return null;
  return { from, port: placement.kind === "wire" ? wire!.port : placement.port, old: wire, to: flow.nodes.find((node) => node.id === wire?.to) };
}

export function blockedReason(flow: Flow, item: PaletteItem, placement: Placement): string | null {
  if (placement.kind === "free") return null;
  if (item.kind === "input") return "starts a flow";
  const target = resolve(flow, placement);
  if (item.kind === "output" && target?.to !== undefined) return "ends a flow";
  return null;
}

function replaceNode(flow: Flow, next: FlowNode): Flow {
  return { ...flow, nodes: flow.nodes.map((node) => (node.id === next.id ? next : node)) };
}

function overlaps(a: FlowNode, b: FlowNode): boolean {
  const pad = 12;
  return a.x < b.x + nodeWidth(b) + pad && a.x + nodeWidth(a) + pad > b.x && a.y < b.y + NODE_H + pad && a.y + NODE_H + pad > b.y;
}

function stripExtension(name: string): string {
  return name.replace(/\.\w+$/u, "");
}

export function autoBind(flow: Flow, nodeId: string): { flow: Flow; notes: string[] } {
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (node === undefined) return { flow, notes: [] };
  const notes: string[] = [];
  const label = (source: SourcePort) => nodeTitle(source.node) + " › " + source.port;
  if (node.kind === "skill") {
    const used = new Set<string>();
    const inputs = node.inputs.map((input) => {
      if (input.bind !== null) return input;
      const pool = bindCandidates(flow, node, input.type);
      const rank = (source: SourcePort) => (stripExtension(source.port) === input.name ? 0 : 2) + (used.has(source.node.id + "|" + source.port) ? 1 : 0);
      const best = pool.map((source, index) => ({ source, index })).sort((a, b) => rank(a.source) - rank(b.source) || a.index - b.index)[0]?.source;
      if (best === undefined) return input;
      used.add(best.node.id + "|" + best.port);
      notes.push(input.name + " ← " + label(best));
      return { ...input, bind: { nodeId: best.node.id, port: best.port } };
    });
    return { flow: replaceNode(flow, { ...node, inputs }), notes };
  }
  if (node.kind === "output" && node.source === null) {
    const best = bindCandidates(flow, node, { kind: "file", path: null })[0];
    if (best === undefined) return { flow, notes };
    notes.push("content ← " + label(best));
    return { flow: replaceNode(flow, { ...node, source: { nodeId: best.node.id, port: best.port } }), notes };
  }
  if (node.kind === "fork" && node.choice === null) {
    const upstream = reachUp(flow, node.id);
    const choices = flow.nodes.flatMap((item) => (item.kind === "input" && upstream.has(item.id) ? item.fields.filter((field) => field.type === "choice").map((field) => ({ item, field })) : []));
    const best = choices[0];
    if (best === undefined) return { flow, notes };
    notes.push("path by " + best.field.name);
    return { flow: syncForkPaths(replaceNode(flow, { ...node, name: node.name === "Fork" ? "Fork by " + best.field.name : node.name, choice: { nodeId: best.item.id, port: best.field.name } }), node.id), notes };
  }
  return { flow, notes };
}

export function reachUp(flow: Flow, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const wire of flow.wires) {
      if (wire.to === id && !seen.has(wire.from)) {
        seen.add(wire.from);
        queue.push(wire.from);
      }
    }
  }
  return seen;
}

export function bindOptions(flow: Flow, nodeId: string, type: IoType | null): SourcePort[] {
  const upstream = reachUp(flow, nodeId);
  const found: SourcePort[] = [];
  for (const node of flow.nodes) {
    if (node.id === nodeId || !upstream.has(node.id)) continue;
    const ports = node.kind === "skill" ? node.outputs.map((output) => ({ port: output.name, type: output.type })) : node.kind === "input" ? node.fields.map((field) => ({ port: field.name, type: inputFieldType(field) })) : [];
    for (const port of ports) if (type === null || satisfies(port.type, type)) found.push({ node, ...port });
  }
  return found;
}

export function insertNode(flow: Flow, item: PaletteItem, placement: Placement): Edit {
  const id = nodeIdFor(flow);
  const target = resolve(flow, placement);
  if (placement.kind === "free" || target === null) {
    const x = placement.kind === "free" ? placement.x : 0;
    const y = placement.kind === "free" ? placement.y : 0;
    const node = makeNode(item, id, x, y);
    const added = { ...flow, nodes: [...flow.nodes, node] };
    const bound = autoBind(added, id);
    return { flow: bound.flow, nodeId: id, message: "Added " + nodeTitle(node) + noteText(bound.notes) };
  }
  const { from, port, old, to } = target;
  const exit = exitPoint(from, port);
  let node = makeNode(item, id, 0, 0);
  node = { ...node, x: Math.round(exit.x - nodeWidth(node) / 2), y: from.y + NODE_H + GAP_Y };
  let nodes = flow.nodes.map((other) => (other.id === from.id && other.kind === "gate" ? { ...other, ends: other.ends.filter((end) => end !== port) } : other));
  if (to !== undefined && to.y > from.y) {
    const delta = node.y + NODE_H + GAP_Y - to.y;
    if (delta > 0) nodes = nodes.map((other) => (other.y >= to.y - 1 ? { ...other, y: other.y + delta } : other));
  }
  if (node.kind === "gate") node = { ...node, ends: node.options.map((_, index) => index).filter((index) => !(to !== undefined && index === 0)) };
  const exits = to === undefined ? 0 : node.kind === "gate" ? 1 : node.kind === "output" ? 0 : exitLabels(node).length;
  const ids = wireIds(flow)(1 + exits);
  const wires = [
    ...flow.wires.filter((wire) => wire.id !== old?.id),
    { id: ids[0]!, from: from.id, port, to: id },
    ...Array.from({ length: exits }, (_, index): Wire => ({ id: ids[index + 1]!, from: id, port: index, to: to!.id })),
  ];
  const where = from.kind === "gate" || from.kind === "fork" ? " › " + exitLabels(from)[port] : "";
  let message = to !== undefined && old !== undefined ? "Inserted " + nodeTitle(node) + " between " + nodeTitle(from) + where + " and " + nodeTitle(to) : "Added " + nodeTitle(node) + " after " + nodeTitle(from) + where;
  let next: Flow = { ...flow, nodes: [...nodes, node], wires };
  if (next.nodes.some((other) => other.id !== id && overlaps(node, other))) {
    next = layout(next);
    message += " (auto-layout made room)";
  }
  const bound = autoBind(next, id);
  return { flow: bound.flow, nodeId: id, message: message + noteText(bound.notes) };
}

function noteText(notes: readonly string[]): string {
  return notes.length === 0 ? "" : "; bound " + notes.join(", ");
}

function withoutBindingsTo(node: FlowNode, removed: string): FlowNode {
  const keep = (binding: Binding | null) => (binding !== null && binding.nodeId === removed ? null : binding);
  switch (node.kind) {
    case "skill":
      return { ...node, inputs: node.inputs.map((input) => ({ ...input, bind: keep(input.bind) })) };
    case "gate":
      return { ...node, material: node.material.filter((binding) => binding.nodeId !== removed) };
    case "fork":
      return { ...node, choice: keep(node.choice) };
    case "output":
      return { ...node, source: keep(node.source) };
    default:
      return node;
  }
}

export function deleteNode(flow: Flow, nodeId: string): Flow {
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (node === undefined) return flow;
  const incoming = flow.wires.filter((wire) => wire.to === nodeId && wire.from !== nodeId);
  const outgoing = flow.wires.filter((wire) => wire.from === nodeId && wire.to !== nodeId);
  let wires = flow.wires.filter((wire) => wire.from !== nodeId && wire.to !== nodeId);
  const after = outgoing[0];
  if (node.kind === "skill" && outgoing.length === 1 && after !== undefined) {
    const make = wireIds({ ...flow, wires })(incoming.length);
    incoming.forEach((wire, index) => {
      if (wire.from === after.to || wires.some((other) => other.from === wire.from && other.port === wire.port)) return;
      wires = [...wires, { id: make[index]!, from: wire.from, port: wire.port, to: after.to }];
    });
  }
  return { ...flow, nodes: flow.nodes.filter((item) => item.id !== nodeId).map((item) => withoutBindingsTo(item, nodeId)), wires };
}

export function removeWire(flow: Flow, wireId: string): Flow {
  return { ...flow, wires: flow.wires.filter((wire) => wire.id !== wireId) };
}

export function connect(flow: Flow, fromId: string, port: number, toId: string): Flow {
  if (fromId === toId) return flow;
  const kept = flow.wires.filter((wire) => !(wire.from === fromId && wire.port === port));
  const id = freshId(flow.wires.map((wire) => wire.id), "w");
  const nodes = flow.nodes.map((node) => (node.id === fromId && node.kind === "gate" ? { ...node, ends: node.ends.filter((end) => end !== port) } : node));
  return { ...flow, nodes, wires: [...kept, { id, from: fromId, port, to: toId }] };
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function forkValues(flow: Flow, fork: ForkNode): string[] | null {
  if (fork.choice === null) return null;
  const source = sourcePort(flow, fork.choice);
  return source?.node.kind === "input" && source.type.kind === "choice" ? source.type.values : null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function syncForkPaths(flow: Flow, forkId: string): Flow {
  const fork = flow.nodes.find((node): node is ForkNode => node.id === forkId && node.kind === "fork");
  if (fork === undefined) return flow;
  const values = forkValues(flow, fork);
  if (values === null || values.length === 0) return flow;
  const previous = fork.paths;
  const paths = values.map((value) => previous.find((path) => same(path.label, value)) ?? { label: capitalize(value), note: "" });
  const mapPort = (port: number): number | null => {
    if (port >= previous.length) return fork.otherwise === null ? null : paths.length;
    const label = previous[port]!.label;
    const index = paths.findIndex((path) => same(path.label, label));
    return index < 0 ? null : index;
  };
  const wires = flow.wires.flatMap((wire) => {
    if (wire.from !== forkId) return [wire];
    const port = mapPort(wire.port);
    return port === null ? [] : [{ ...wire, port }];
  });
  return { ...replaceNode(flow, { ...fork, paths }), wires };
}

function addForkPath(flow: Flow, fork: ForkNode, value: string): Flow {
  const index = fork.paths.length;
  const wired = fork.paths.map((path, port) => ({ path, wire: wireAt(flow, fork.id, port) })).filter((entry) => entry.wire !== undefined);
  const ref = wired.find((entry) => entry.path.note.trim() !== "") ?? wired.at(-1);
  const shifted = flow.wires.map((wire) => (wire.from === fork.id && wire.port >= index ? { ...wire, port: wire.port + 1 } : wire));
  const next = replaceNode({ ...flow, wires: shifted }, { ...fork, paths: [...fork.paths, { label: value, note: ref === undefined ? "" : "skip" }] });
  return ref?.wire === undefined ? next : connect(next, fork.id, index, ref.wire.to);
}

function removeExit(flow: Flow, nodeId: string, port: number): Flow {
  const wires = flow.wires.flatMap((wire) => {
    if (wire.from !== nodeId) return [wire];
    if (wire.port === port) return [];
    return [wire.port > port ? { ...wire, port: wire.port - 1 } : wire];
  });
  const nodes = flow.nodes.map((node): FlowNode => {
    if (node.id !== nodeId) return node;
    if (node.kind === "fork") return { ...node, paths: node.paths.filter((_, index) => index !== port) };
    if (node.kind === "gate") return { ...node, options: node.options.filter((_, index) => index !== port), ends: node.ends.filter((end) => end !== port).map((end) => (end > port ? end - 1 : end)) };
    return node;
  });
  return { ...flow, nodes, wires };
}

export function removePath(flow: Flow, forkId: string, port: number): Flow {
  const fork = flow.nodes.find((node) => node.id === forkId);
  if (fork?.kind !== "fork" || fork.paths.length <= 1 || port >= fork.paths.length) return flow;
  return removeExit(flow, forkId, port);
}

export function removeGateOption(flow: Flow, gateId: string, port: number): Flow {
  const gate = flow.nodes.find((node) => node.id === gateId);
  if (gate?.kind !== "gate" || gate.options.length <= 1) return flow;
  return removeExit(flow, gateId, port);
}

function editChoiceValues(flow: Flow, fork: ForkNode, change: (values: string[]) => string[]): Flow {
  const binding = fork.choice;
  if (binding === null) return flow;
  const nodes = flow.nodes.map((node): FlowNode => {
    if (node.id !== binding.nodeId || node.kind !== "input") return node;
    return { ...node, fields: node.fields.map((field) => (field.name === binding.port && field.type === "choice" ? { ...field, options: change(field.options) } : field)) };
  });
  return { ...flow, nodes };
}

export function syncSkill(node: SkillNode, info: SkillInfo): SkillNode {
  const inputs = info.inputs.map((input) => {
    const before = node.inputs.find((item) => item.name === input.name);
    return { ...input, bind: before?.bind ?? null };
  });
  const outputs = info.outputs.map((output) => ({ ...output, path: node.outputs.find((item) => item.name === output.name)?.path ?? null }));
  return { ...node, inputs, outputs };
}

function freePath(flow: Flow, file: string): string {
  const taken = new Set(flow.nodes.flatMap((node) => (node.kind === "skill" ? node.outputs.map(outputFile).filter((item): item is string => item !== null) : [])));
  const match = /^(.*?)(\.[^./]+)?$/u.exec(file);
  const base = match?.[1] ?? file;
  const extension = match?.[2] ?? "";
  for (let n = 2; ; n += 1) {
    const candidate = base + "-" + String(n) + extension;
    if (!taken.has(candidate)) return candidate;
  }
}

function setBinding(node: FlowNode, input: string, binding: Binding | null, flow: Flow): FlowNode {
  switch (node.kind) {
    case "skill":
      return { ...node, inputs: node.inputs.map((item) => (item.name === input ? { ...item, bind: binding } : item)) };
    case "output":
      return { ...node, source: binding };
    case "fork":
      return { ...node, choice: binding };
    case "gate": {
      if (binding !== null) return { ...node, material: [...node.material, binding] };
      const upstream = reachUp(flow, node.id);
      return { ...node, material: node.material.filter((item) => sourcePort(flow, item) !== null && upstream.has(item.nodeId)) };
    }
    default:
      return node;
  }
}

export function applyFix(flow: Flow, nodeId: string | null, action: FixAction, skills: readonly SkillInfo[]): Edit {
  const node = flow.nodes.find((item) => item.id === nodeId);
  const done = (next: Flow, message: string, selected: string | null = nodeId): Edit => ({ flow: next, nodeId: selected, message });
  if (node === undefined) return done(flow, "Nothing to fix");
  switch (action.kind) {
    case "use-skill": {
      const info = skills.find((skill) => skill.name === action.skill);
      if (node.kind !== "skill" || info === undefined) return done(flow, "Skill " + action.skill + " is not installed");
      const name = node.name === node.skill ? info.name : node.name;
      return done(replaceNode(flow, syncSkill({ ...node, name, skill: info.name }, info)), "Now uses " + info.name);
    }
    case "pick-skill":
      return done(flow, "Pick another skill for " + nodeTitle(node));
    case "sync-skill": {
      const info = skills.find((skill) => skill.name === (node.kind === "skill" ? node.skill : null));
      if (node.kind !== "skill" || info === undefined) return done(flow, "Skill not found");
      return done(replaceNode(flow, syncSkill(node, info)), "Rebound " + node.name + " to " + info.name + " as it is now");
    }
    case "delete-node":
      return done(deleteNode(flow, node.id), "Deleted " + nodeTitle(node), null);
    case "connect-after": {
      const tail = flow.nodes.find((item) => item.id === action.nodeId);
      return done(connect(flow, action.nodeId, 0, node.id), "Connected " + (tail === undefined ? "" : nodeTitle(tail)) + " → " + nodeTitle(node));
    }
    case "bind":
      return done(replaceNode(flow, setBinding(node, action.input, action.source, flow)), "Bound " + action.input);
    case "unbind":
      return done(replaceNode(flow, setBinding(node, action.input, null, flow)), "Unbound " + action.input);
    case "finish-here":
      if (node.kind !== "gate") return done(flow, "Only a gate option can finish the run");
      return done(replaceNode(flow, { ...node, ends: [...node.ends.filter((end) => end !== action.port), action.port] }), '"' + (node.options[action.port] ?? "") + '" now finishes the run');
    case "add-output": {
      const edit = insertNode(flow, { kind: "output" }, { kind: "after", nodeId: node.id, port: action.port });
      return edit;
    }
    case "add-path":
      if (node.kind !== "fork") return done(flow, "Not a fork");
      return done(addForkPath(flow, node, action.value), "Added path '" + action.value + "'");
    case "remove-value":
      if (node.kind !== "fork") return done(flow, "Not a fork");
      return done(editChoiceValues(flow, node, (values) => values.filter((value) => !same(value, action.value))), "Removed value '" + action.value + "'");
    case "add-value":
      if (node.kind !== "fork") return done(flow, "Not a fork");
      return done(editChoiceValues(flow, node, (values) => [...values, action.value.toLowerCase()]), "Added '" + action.value + "' to the choice");
    case "remove-path":
      return done(removePath(flow, node.id, action.port), "Removed a path");
    case "label-skip": {
      if (node.kind !== "fork") return done(flow, "Not a fork");
      const label = (path: ForkNode["paths"][number], index: number) => (index === action.port ? { ...path, note: "skip" } : path);
      const otherwise = node.otherwise !== null && action.port === node.paths.length ? { ...node.otherwise, note: "skip" } : node.otherwise;
      return done(replaceNode(flow, { ...node, paths: node.paths.map(label), otherwise }), 'Labelled the path "skip"');
    }
    case "remove-wire":
      return done(removeWire(flow, action.wireId), "Removed the loop wire");
    case "insert-gate": {
      const wire = flow.wires.find((item) => item.id === action.wireId);
      const to = flow.nodes.find((item) => item.id === wire?.to);
      if (wire === undefined || to === undefined) return done(flow, "The wire is gone");
      const edit = insertNode(flow, { kind: "gate" }, { kind: "wire", wireId: wire.id });
      const gate = edit.flow.nodes.find((item): item is GateNode => item.id === edit.nodeId && item.kind === "gate");
      if (gate === undefined) return edit;
      const asked: GateNode = { ...gate, question: "Repeat " + nodeTitle(to) + "?", options: ["repeat", "stop"], ends: [1] };
      return { ...edit, flow: replaceNode(edit.flow, asked), message: "Inserted a gate that asks before repeating " + nodeTitle(to) };
    }
    case "override-path": {
      if (node.kind !== "skill") return done(flow, "Not a skill");
      const output = node.outputs.find((item) => item.name === action.output);
      const file = output === undefined ? null : outputFile(output);
      if (output === undefined || file === null) return done(flow, "Output not found");
      const path = freePath(flow, file);
      return done(replaceNode(flow, { ...node, outputs: node.outputs.map((item) => (item === output ? { ...item, path } : item)) }), action.output + " now writes " + path);
    }
  }
}

export function layout(flow: Flow): Flow {
  if (flow.nodes.length === 0) return flow;
  const back = backWires(flow);
  const forward = flow.wires.filter((wire) => !back.has(wire.id) && wire.from !== wire.to);
  const layer = new Map<string, number>(flow.nodes.map((node) => [node.id, 0]));
  for (let round = 0; round < flow.nodes.length; round += 1) {
    let changed = false;
    for (const wire of forward) {
      const next = (layer.get(wire.from) ?? 0) + 1;
      if ((layer.get(wire.to) ?? 0) < next) {
        layer.set(wire.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const placed = new Map<string, FlowNode>();
  const deepest = Math.max(...layer.values());
  for (let level = 0; level <= deepest; level += 1) {
    const items = flow.nodes
      .map((node, index) => {
        const parents = forward.filter((wire) => wire.to === node.id && placed.has(wire.from));
        const want = parents.length === 0 ? null : parents.reduce((sum, wire) => sum + exitPoint(placed.get(wire.from)!, wire.port).x, 0) / parents.length - nodeWidth(node) / 2;
        return { node, index, want };
      })
      .filter((item) => layer.get(item.node.id) === level)
      .sort((a, b) => (a.want ?? 1e9 + a.index) - (b.want ?? 1e9 + b.index));
    let cursor = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      const x = item.want === null ? (cursor === Number.NEGATIVE_INFINITY ? 0 : cursor) : Math.max(item.want, cursor);
      const node = { ...item.node, x: Math.round(x), y: level * (NODE_H + GAP_Y) };
      placed.set(node.id, node);
      cursor = node.x + nodeWidth(node) + GAP_X;
    }
  }
  return { ...flow, nodes: flow.nodes.map((node) => placed.get(node.id) ?? node) };
}

export function needsLayout(flow: Flow): boolean {
  return flow.nodes.length > 1 && flow.nodes.some((node, index) => flow.nodes.some((other, j) => j > index && overlaps(node, other)));
}

export function summaryText(flow: Flow): string {
  const count = flow.nodes.length;
  const gates = flow.nodes.filter((node) => node.kind === "gate" && node.owner === "owner").length;
  const forks = flow.nodes.flatMap((node) => (node.kind === "fork" ? [node.choice?.port ?? "a choice"] : []));
  const stops = gates === 0 ? "never stops for you" : "stops for you " + (gates === 1 ? "once" : gates === 2 ? "twice" : String(gates) + " times");
  return [String(count) + " step" + (count === 1 ? "" : "s"), stops, ...(forks.length === 0 ? [] : ["forks on " + forks.join(" and ")])].join(" · ");
}

export interface History {
  past: Flow[];
  present: Flow;
  future: Flow[];
}

export function startHistory(flow: Flow): History {
  return { past: [], present: flow, future: [] };
}

export function record(history: History, next: Flow): History {
  if (next === history.present) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}
