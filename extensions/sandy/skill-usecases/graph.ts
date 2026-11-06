import { z } from "zod";
import type { IoType } from "./io.ts";

export const MAX_NODES = 80;
export const MAX_WIRES = 200;
export const MAX_CHOICES = 40;

const nodeId = z.string().min(1).max(60);
const label = z.string().trim().min(1).max(200);
const position = { x: z.number(), y: z.number() };

export const bindingSchema = z.object({ nodeId, port: z.string().min(1).max(200) });
export type Binding = z.infer<typeof bindingSchema>;

export const ioTypeSchema: z.ZodType<IoType> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({ kind: z.literal("url") }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).nullable() }),
  z.object({ kind: z.literal("choice"), values: z.array(z.string().min(1)).min(2) }),
  z.object({ kind: z.literal("raw"), text: z.string().min(1) }),
]);

const skillInputSchema = z.object({ name: label, optional: z.boolean(), type: ioTypeSchema, bind: bindingSchema.nullable() });
export type SkillInput = z.infer<typeof skillInputSchema>;

const skillOutputSchema = z.object({
  name: label,
  optional: z.boolean(),
  type: ioTypeSchema,
  path: z.string().trim().min(1).max(300).nullable(),
  description: z.string().max(400).default(""),
  byOwner: z.boolean().default(false),
});
export type SkillOutput = z.infer<typeof skillOutputSchema>;

export const skillNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("skill"),
  name: label,
  ...position,
  skill: z.string().min(1).max(200).nullable(),
  instruction: z.string().max(20000),
  inputs: z.array(skillInputSchema).max(40),
  outputs: z.array(skillOutputSchema).max(40),
  ownerApproves: z.boolean().default(false),
  requireOutputs: z.boolean().default(true),
});
export type SkillNode = z.infer<typeof skillNodeSchema>;

export const INPUT_FIELD_TYPES = ["text", "url", "file", "choice"] as const;

const inputFieldSchema = z.object({
  name: label,
  type: z.enum(INPUT_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(80)).max(MAX_CHOICES),
  prompt: z.string().max(400),
  path: z.string().max(200).default(""),
  optional: z.boolean().default(false),
});
export type InputField = z.infer<typeof inputFieldSchema>;

export const inputNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("input"),
  name: label,
  ...position,
  fields: z.array(inputFieldSchema).max(20),
});
export type InputNode = z.infer<typeof inputNodeSchema>;

export const GATE_OWNERS = ["owner", "agent", "anyone"] as const;

export const gateNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("gate"),
  question: label,
  ...position,
  owner: z.enum(GATE_OWNERS),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  material: z.array(bindingSchema).max(20),
  ends: z.array(z.number().int().min(0)).max(12),
  answer: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/u).default("Answer"),
});
export type GateNode = z.infer<typeof gateNodeSchema>;

const forkPathSchema = z.object({ label: z.string().trim().min(1).max(80), note: z.string().max(200) });
export type ForkPath = z.infer<typeof forkPathSchema>;

export const forkNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("fork"),
  name: label,
  ...position,
  choice: bindingSchema.nullable(),
  paths: z.array(forkPathSchema).min(1).max(MAX_CHOICES),
  otherwise: forkPathSchema.nullable(),
});
export type ForkNode = z.infer<typeof forkNodeSchema>;

export const outputNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("output"),
  label,
  ...position,
  source: bindingSchema.nullable(),
  deliverable: z.boolean(),
});
export type OutputNode = z.infer<typeof outputNodeSchema>;

export const flowNodeSchema = z.discriminatedUnion("kind", [skillNodeSchema, inputNodeSchema, gateNodeSchema, forkNodeSchema, outputNodeSchema]);
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const wireSchema = z.object({
  id: z.string().min(1).max(60),
  from: nodeId,
  port: z.number().int().min(0),
  to: nodeId,
  label: z.string().max(400).optional(),
  when: z.string().max(1000).optional(),
  max: z.number().int().min(1).optional(),
  exceeded: z.string().min(1).max(60).optional(),
});
export type Wire = z.infer<typeof wireSchema>;

export const flowOriginSchema = z.object({
  skillId: z.string().min(1),
  revision: z.string().min(1),
  filePath: z.string(),
  writable: z.boolean(),
});
export type FlowOrigin = z.infer<typeof flowOriginSchema>;

export const flowSchema = z
  .object({
    version: z.literal(2),
    id: z.string().min(1).max(64),
    useCaseId: z.string().min(1).max(40),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(1024),
    nodes: z.array(flowNodeSchema).max(MAX_NODES),
    wires: z.array(wireSchema).max(MAX_WIRES),
    preamble: z.string().max(20000).optional(),
    frontmatter: z.string().max(20000).optional(),
    origin: flowOriginSchema.optional(),
  })
  .superRefine((flow, ctx) => {
    const ids = new Set<string>();
    for (const node of flow.nodes) {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: 'duplicate node id "' + node.id + '"' });
      ids.add(node.id);
    }
    const wireIds = new Set<string>();
    for (const wire of flow.wires) {
      if (wireIds.has(wire.id)) ctx.addIssue({ code: "custom", message: 'duplicate wire id "' + wire.id + '"' });
      wireIds.add(wire.id);
      if (!ids.has(wire.from) || !ids.has(wire.to)) ctx.addIssue({ code: "custom", message: 'wire "' + wire.id + '" names a missing node' });
    }
  });
export type Flow = z.infer<typeof flowSchema>;

export const flowStepSchema = z.object({
  skill: z.string().min(1).max(200),
  note: z.string().max(300),
});
export type FlowStep = z.infer<typeof flowStepSchema>;

export const flowV1Schema = z.object({
  id: z.string().min(1).max(60),
  useCaseId: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400),
  steps: z.array(flowStepSchema).max(40),
});
export type FlowV1 = z.infer<typeof flowV1Schema>;

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

export function uniqueId(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = base + "-" + String(index);
  taken.add(candidate);
  return candidate;
}

const STEP_SPACING = 160;

function chainNodes(steps: readonly FlowStep[], reuse: readonly SkillNode[]): { nodes: SkillNode[]; wires: Wire[] } {
  const pool = [...reuse];
  const taken = new Set<string>();
  const nodes = steps.map((step, index): SkillNode => {
    const found = pool.findIndex((node) => node.skill === step.skill && !taken.has(node.id));
    const base = found >= 0 ? pool.splice(found, 1)[0] : undefined;
    let id = base?.id ?? "s" + String(index + 1);
    for (let n = index + 1; base === undefined && (taken.has(id) || pool.some((node) => node.id === id)); n += 1) id = "s" + String(n + 1);
    taken.add(id);
    return {
      id,
      kind: "skill",
      name: base?.name ?? step.skill,
      x: 0,
      y: index * STEP_SPACING,
      skill: step.skill,
      instruction: step.note,
      inputs: base?.inputs ?? [],
      outputs: base?.outputs ?? [],
      ownerApproves: base?.ownerApproves ?? false,
      requireOutputs: base?.requireOutputs ?? true,
    };
  });
  const wires = nodes.slice(1).map((node, index): Wire => ({ id: "w" + String(index + 1), from: nodes[index]!.id, port: 0, to: node.id }));
  return { nodes, wires };
}

export function migrateLinear(flow: FlowV1): Flow {
  return { version: 2, id: flow.id, useCaseId: flow.useCaseId, name: flow.name, description: flow.description, ...chainNodes(flow.steps, []) };
}

export function withLinearSteps(flow: Flow, steps: readonly FlowStep[]): Flow {
  const reuse = flow.nodes.filter((node): node is SkillNode => node.kind === "skill");
  return { ...flow, ...chainNodes(steps, reuse) };
}

export const storedFlowSchema = z.union([flowSchema, flowV1Schema]);
export type StoredFlow = z.infer<typeof storedFlowSchema>;

export function upgradeFlow(stored: StoredFlow): Flow {
  return "version" in stored ? stored : migrateLinear(stored);
}

export function nodeTitle(node: FlowNode): string {
  switch (node.kind) {
    case "gate":
      return node.question;
    case "output":
      return node.label;
    default:
      return node.name;
  }
}

export function exitLabels(node: FlowNode): string[] {
  if (node.kind === "gate") return [...node.options];
  if (node.kind === "fork") return [...node.paths.map((path) => path.label), ...(node.otherwise === null ? [] : [node.otherwise.label])];
  if (node.kind === "output") return [];
  return ["next"];
}

export function wireAt(flow: Flow, nodeId: string, port: number): Wire | undefined {
  return flow.wires.find((wire) => wire.from === nodeId && wire.port === port);
}

export function startNodes(flow: Flow): FlowNode[] {
  const inputs = flow.nodes.filter((node) => node.kind === "input");
  if (inputs.length > 0) return inputs;
  const targeted = new Set(flow.wires.map((wire) => wire.to));
  return flow.nodes.filter((node) => !targeted.has(node.id));
}

export function backWires(flow: Flow): Set<string> {
  const outgoing = new Map<string, Wire[]>();
  for (const wire of flow.wires) outgoing.set(wire.from, [...(outgoing.get(wire.from) ?? []), wire]);
  const state = new Map<string, "open" | "done">();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const wire of outgoing.get(id) ?? []) {
      const seen = state.get(wire.to);
      if (seen === "open") back.add(wire.id);
      else if (seen === undefined) visit(wire.to);
    }
    state.set(id, "done");
  };
  for (const node of startNodes(flow)) if (!state.has(node.id)) visit(node.id);
  for (const node of flow.nodes) if (!state.has(node.id)) visit(node.id);
  return back;
}

export function orderedNodes(flow: Flow): FlowNode[] {
  const back = backWires(flow);
  const forward = flow.wires.filter((wire) => !back.has(wire.id));
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
  return flow.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => (layer.get(a.node.id) ?? 0) - (layer.get(b.node.id) ?? 0) || a.index - b.index)
    .map((entry) => entry.node);
}

export function linearSteps(flow: Flow): FlowStep[] | null {
  if (flow.nodes.some((node) => node.kind !== "skill" || node.skill === null)) return null;
  if (flow.wires.length !== Math.max(0, flow.nodes.length - 1) || flow.wires.some((wire) => wire.port !== 0)) return null;
  const order = orderedNodes(flow);
  for (const [index, node] of order.slice(1).entries()) {
    if (!flow.wires.some((wire) => wire.from === order[index]!.id && wire.to === node.id)) return null;
  }
  return order.flatMap((node) => (node.kind === "skill" && node.skill !== null ? [{ skill: node.skill, note: node.instruction }] : []));
}

export function flowSkillNames(flow: Flow): string[] {
  return orderedNodes(flow).flatMap((node) => (node.kind === "skill" && node.skill !== null ? [node.skill] : []));
}

export function inputFieldText(field: InputField): string {
  const choices = field.type === "choice" && field.options.length > 0 ? " (" + field.options.join(", ") + ")" : "";
  return field.name + choices + (field.prompt === "" ? "" : ": " + field.prompt);
}

function bindingText(flow: Flow, binding: Binding | null): string {
  if (binding === null) return "nothing";
  const source = flow.nodes.find((node) => node.id === binding.nodeId);
  if (source?.kind === "skill") return source.outputs.find((output) => output.name === binding.port)?.path ?? binding.port;
  return binding.port;
}

export function flowStepLines(flow: Flow, skillPrefix: "" | "/"): string[] {
  const order = orderedNodes(flow);
  const number = new Map<string, number>();
  for (const node of order) if (node.kind !== "fork") number.set(node.id, number.size + 1);
  const target = (nodeId: string, port: number): string => {
    const wire = wireAt(flow, nodeId, port);
    if (wire === undefined) return "finish";
    const next = flow.nodes.find((node) => node.id === wire.to);
    if (next === undefined) return "finish";
    if (next.kind === "fork") return "the fork " + next.name;
    return "step " + String(number.get(next.id) ?? "?");
  };
  const lines: string[] = [];
  for (const node of order) {
    const index = number.get(node.id);
    const prefix = index === undefined ? "- " : String(index) + ". ";
    switch (node.kind) {
      case "input":
        lines.push(prefix + "Ask for " + (node.fields.length === 0 ? "nothing" : node.fields.map(inputFieldText).join("; ")));
        break;
      case "skill":
        lines.push(prefix + (node.skill === null ? node.name : skillPrefix + node.skill) + (node.instruction === "" ? "" : " - " + node.instruction));
        break;
      case "gate": {
        const who = node.owner === "agent" ? "Decide yourself" : node.owner === "owner" ? "Ask me" : "Ask anyone";
        const exits = node.options.map((option, port) => option + " -> " + target(node.id, port));
        lines.push(prefix + who + ": " + node.question + " (" + exits.join(", ") + ")");
        break;
      }
      case "fork": {
        const by = node.choice === null ? "a choice" : node.choice.port;
        const exits = exitLabels(node).map((exit, port) => exit + " -> " + target(node.id, port));
        lines.push(prefix + node.name + ", by " + by + ": " + exits.join(", "));
        break;
      }
      case "output":
        lines.push(prefix + "Deliver " + node.label + " from " + bindingText(flow, node.source));
        break;
    }
  }
  return lines;
}

export function flowRunText(flow: Flow): string {
  const fallback =
    linearSteps(flow) !== null
      ? "If stage_start is not available, use each skill in this order instead and tell me when a step is done:"
      : "If stage_start is not available, follow the numbered steps instead, take the branch that each answer or value names, and tell me when a step is done:";
  if (flow.origin !== undefined)
    return [
      'Run the flow "' + flow.name + '" as a track.',
      "1. Call stage_start with skill " + JSON.stringify(flow.id) + ' and the note "Flow ' + flow.name + '", then work stage by stage with stage_status, stage_submit and stage_advance.',
      "If stage_start reports problems in the skill, tell me what to fix and stop.",
      fallback,
      ...flowStepLines(flow, "/"),
      "If a skill is not installed, follow its note instead.",
      "",
    ].join("\n");
  return [
    'Run the flow "' + flow.name + '" as a track.',
    "1. Call flow_track with flow " + JSON.stringify(flow.id) + ". It returns the flow compiled into a track machine, or the problems that keep it from running.",
    '2. Call stage_start with that machine and the note "Flow ' + flow.name + '", then work stage by stage with stage_status, stage_submit and stage_advance.',
    "If flow_track reports problems, tell me what to fix and stop.",
    fallback,
    ...flowStepLines(flow, "/"),
    "If a skill is not installed, follow its note instead.",
    "",
  ].join("\n");
}
