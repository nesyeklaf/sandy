import { DONE_STAGE, INPUT_SCOPE, outlineSkill, parseSkill, readFrontmatter, type OutlineTag, type Problem } from "@sandy/skill-dialect";
import { parseDocument } from "yaml";
import type { SkillInfo } from "./check.ts";
import { slug, uniqueId, orderedNodes, type Binding, type Flow, type FlowNode, type ForkNode, type GateNode, type InputField, type InputNode, type OutputNode, type SkillNode, type Wire } from "./graph.ts";
import { formatType, parseIoType, type IoType } from "./io.ts";

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,47}$/u;
const STAGE = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
const BIND_LINE = /^- ([^\n:]+): \{% \$([a-z0-9][a-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_]*) %\}[ \t]*$/u;
const AUTO_ID = /^[ns]\d+$/u;
const DONE_LABEL = "Done";
const OTHERWISE = "Otherwise";
export const INPUT_NODE_ID = "input";

export type Positions = Record<string, { x: number; y: number }>;

export function fieldName(text: string, taken?: Set<string>): string {
  let base = text.replace(/[^A-Za-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!/^[A-Za-z]/u.test(base)) base = "F" + base;
  base = base.slice(0, 44);
  if (taken === undefined) return base;
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = base + "_" + String(index);
  taken.add(candidate);
  return candidate;
}

export function skillName(flow: Pick<Flow, "id" | "name" | "origin">): string {
  if (flow.origin !== undefined) return flow.id;
  return STAGE.test(flow.id) && flow.id !== DONE_STAGE && flow.id !== INPUT_SCOPE ? flow.id : slug(flow.name, "flow");
}

function str(value: string): string {
  return JSON.stringify(value);
}

function tag(name: string, attrs: [string, string | number | boolean | undefined][], close: boolean): string {
  const parts = attrs.filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined).map(([key, value]) => (typeof value === "string" ? key + "=" + str(value) : key + "=" + String(value)));
  return "{% " + [name, ...parts].join(" ") + (close ? " /%}" : " %}");
}

function equals(ref: string, value: string): string {
  return "equals(" + ref + ", " + str(value) + ")";
}

function ioTypeText(type: IoType, path: string | null): string | undefined {
  if (type.kind === "file") {
    const file = path ?? type.path;
    return file === null ? "file" : "file(" + file + ")";
  }
  return type.kind === "text" ? undefined : formatType(type);
}

interface Plan {
  stageOf: Map<string, string>;
  inputRef: Map<string, string>;
  outputField: Map<string, Map<string, string>>;
}

function plan(flow: Flow, order: FlowNode[]): Plan {
  const stageOf = new Map<string, string>();
  const taken = new Set<string>([DONE_STAGE, INPUT_SCOPE]);
  for (const node of order) {
    if (node.kind === "input" || node.kind === "output") continue;
    const title = node.kind === "gate" ? node.question : node.name;
    const own = STAGE.test(node.id) && !AUTO_ID.test(node.id) && !taken.has(node.id);
    stageOf.set(node.id, own ? uniqueId(node.id, taken) : uniqueId(slug(title, node.kind), taken));
  }
  const inputRef = new Map<string, string>();
  const inputTaken = new Set<string>();
  for (const node of flow.nodes) if (node.kind === "input") for (const field of node.fields) inputRef.set(node.id + "\u0000" + field.name, "$" + INPUT_SCOPE + "." + fieldName(field.name, inputTaken));
  const outputField = new Map<string, Map<string, string>>();
  for (const node of flow.nodes) {
    if (node.kind === "skill") {
      const names = new Set<string>();
      outputField.set(node.id, new Map(node.outputs.map((output) => [output.name, fieldName(output.name, names)])));
    }
    if (node.kind === "gate") outputField.set(node.id, new Map([[node.answer, node.answer]]));
  }
  return { stageOf, inputRef, outputField };
}

function refOf(flow: Flow, p: Plan, binding: Binding): string | null {
  const node = flow.nodes.find((item) => item.id === binding.nodeId);
  if (node?.kind === "input") return p.inputRef.get(node.id + "\u0000" + binding.port) ?? null;
  const stage = p.stageOf.get(binding.nodeId);
  const field = p.outputField.get(binding.nodeId)?.get(binding.port);
  return stage === undefined || field === undefined ? null : "$" + stage + "." + field;
}

function bindLines(flow: Flow, p: Plan, items: { name: string; bind: Binding | null }[]): string[] {
  return items.flatMap((item) => {
    const ref = item.bind === null ? null : refOf(flow, p, item.bind);
    return ref === null ? [] : ["- " + item.name.replace(/[:\n]/gu, " ") + ": {% " + ref + " %}"];
  });
}

type Edge = { to: string; when?: string; label?: string; max?: number; exceeded?: string; merged?: boolean };

function edgeTag(edge: Edge): string {
  const attrs: string[] = ["to=" + str(edge.to)];
  if (edge.when !== undefined) attrs.push("when=" + edge.when);
  if (edge.label !== undefined && edge.label !== "") attrs.push("label=" + str(edge.label));
  if (edge.max !== undefined) attrs.push("max=" + String(edge.max));
  if (edge.exceeded !== undefined) attrs.push("exceeded=" + str(edge.exceeded));
  return "{% next " + attrs.join(" ") + " /%}";
}

function targetOf(flow: Flow, p: Plan, wire: Wire): string | null {
  const node = flow.nodes.find((item) => item.id === wire.to);
  if (node === undefined || node.kind === "input") return null;
  if (node.kind === "output") return DONE_STAGE;
  return p.stageOf.get(node.id) ?? null;
}

function wireEdges(flow: Flow, p: Plan, node: FlowNode, port: number, when?: string, label?: string): Edge[] {
  return flow.wires
    .filter((wire) => wire.from === node.id && wire.port === port)
    .flatMap((wire) => {
      const to = targetOf(flow, p, wire);
      if (to === null) return [];
      const edge: Edge = { to };
      const condition = when ?? wire.when;
      if (condition !== undefined) edge.when = condition;
      const text = wire.label ?? label;
      if (text !== undefined) edge.label = text;
      if (wire.max !== undefined) edge.max = wire.max;
      if (wire.exceeded !== undefined) edge.exceeded = wire.exceeded;
      return [edge];
    });
}

function merge(edges: Edge[]): Edge[] {
  const out: Edge[] = [];
  for (const edge of edges) {
    const index = out.findIndex((item) => item.to === edge.to);
    const before = out[index];
    if (before === undefined) {
      out.push({ ...edge });
      continue;
    }
    if (before.when === undefined) continue;
    if (edge.when === undefined) {
      out[index] = { ...edge };
      continue;
    }
    if (before.when === edge.when) continue;
    const parts = before.when.startsWith("or(") && before.when.endsWith(")") && before.merged === true ? before.when.slice(3, -1) : before.when;
    out[index] = { ...before, when: "or(" + parts + ", " + edge.when + ")", merged: true, ...(before.label === undefined && edge.label !== undefined ? { label: edge.label } : {}) };
  }
  return out;
}

function forkOption(flow: Flow, fork: ForkNode, label: string): string {
  const source = fork.choice === null ? undefined : flow.nodes.find((node) => node.id === fork.choice?.nodeId);
  const field = source?.kind === "input" ? source.fields.find((item) => item.name === fork.choice?.port) : undefined;
  return field?.options.find((option) => option.toLowerCase() === label.toLowerCase()) ?? label;
}

function skillStage(flow: Flow, p: Plan, node: SkillNode, id: string): string {
  const title = node.name !== (node.skill ?? id) ? node.name : undefined;
  const lines = [tag("stage", [["id", id], ["skill", node.skill ?? undefined], ["title", title], ["gate", node.ownerApproves ? "user" : undefined]], false)];
  const gateRule = node.requireOutputs && node.outputs.some((output) => !output.optional) ? '{% gate type="outputs" /%}' : null;
  const body = node.instruction.trim() === "" ? [] : node.instruction.replace(/\n+$/u, "").split("\n");
  const firstGate = body.findIndex((line) => line.startsWith("{% gate "));
  if (gateRule !== null && firstGate >= 0) body.splice(firstGate, 0, gateRule);
  lines.push(...body);
  lines.push(...bindLines(flow, p, node.inputs));
  const fields = p.outputField.get(node.id);
  for (const output of node.outputs)
    lines.push(tag("output", [["name", fields?.get(output.name) ?? fieldName(output.name)], ["type", ioTypeText(output.type, output.path)], ["by", output.byOwner ? "owner" : undefined], ["description", output.description === "" ? undefined : output.description], ["optional", output.optional ? true : undefined]], true));
  if (gateRule !== null && firstGate < 0) lines.push(gateRule);
  lines.push(...merge(wireEdges(flow, p, node, 0)).map(edgeTag));
  lines.push("{% /stage %}");
  return lines.join("\n");
}

function gateStage(flow: Flow, p: Plan, node: GateNode, id: string): string {
  const lines = [tag("stage", [["id", id], ["title", node.question], ["gate", node.owner === "agent" ? undefined : "user"]], false)];
  lines.push(...bindLines(flow, p, node.material.map((bind) => ({ name: bind.port, bind }))));
  if (node.options.length < 2) {
    const wired = wireEdges(flow, p, node, 0);
    lines.push(...merge(wired.length === 0 ? [{ to: DONE_STAGE }] : wired).map(edgeTag), "{% /stage %}");
    return lines.join("\n");
  }
  lines.push(tag("output", [["name", node.answer], ["type", "choice(" + node.options.join(", ") + ")"], ["by", node.owner === "owner" ? "owner" : undefined], ["description", node.question]], true));
  const edges: Edge[] = [];
  node.options.forEach((option, port) => {
    const when = equals("$" + id + "." + node.answer, option);
    const wired = wireEdges(flow, p, node, port, when);
    edges.push(...wired);
    if (wired.length === 0 && node.ends.includes(port)) edges.push({ to: DONE_STAGE, when });
  });
  lines.push(...merge(edges).map(edgeTag), "{% /stage %}");
  return lines.join("\n");
}

function forkStage(flow: Flow, p: Plan, node: ForkNode, id: string): string {
  const lines = [tag("stage", [["id", id], ["title", node.name]], false)];
  const ref = node.choice === null ? null : refOf(flow, p, node.choice);
  const edges: Edge[] = [];
  node.paths.forEach((path, port) => {
    const when = ref === null ? undefined : equals(ref, forkOption(flow, node, path.label));
    const wired = wireEdges(flow, p, node, port, when, path.note === "" ? undefined : path.note);
    if (wired.length > 0) edges.push(...wired);
    else edges.push({ to: DONE_STAGE, ...(when === undefined ? {} : { when }), ...(path.note === "" ? {} : { label: path.note }) });
  });
  if (node.otherwise !== null) edges.push(...wireEdges(flow, p, node, node.paths.length, undefined, node.otherwise.note === "" ? undefined : node.otherwise.note));
  lines.push(...merge(edges).map(edgeTag), "{% /stage %}");
  return lines.join("\n");
}

function inputTag(field: InputField, name: string): string {
  const type = field.type === "choice" ? "choice(" + field.options.join(", ") + ")" : field.type === "url" ? "url" : field.type === "file" ? (field.path === "" ? "file" : "file(" + field.path + ")") : undefined;
  return tag("input", [["name", name], ["type", type], ["description", field.prompt === "" ? undefined : field.prompt], ["optional", field.optional ? true : undefined]], true);
}

function frontmatter(flow: Flow, name: string): string {
  const doc = parseDocument(flow.frontmatter ?? "");
  const usable = doc.errors.length === 0 && doc.contents !== null && typeof doc.toJS() === "object";
  if (!usable) return ["name: " + name, "description: " + str(flow.description), "metadata:", '  dialect: "1"', ""].join("\n");
  doc.set("name", name);
  doc.set("description", flow.description);
  if (!doc.hasIn(["metadata", "dialect"])) doc.setIn(["metadata", "dialect"], "1");
  return doc.toString({ lineWidth: 0 });
}

function preamble(flow: Flow, name: string): string {
  if (flow.preamble !== undefined && flow.preamble.trim() !== "") {
    const text = flow.preamble.replace(/\n+$/u, "");
    return /^#[ \t]+.*$/mu.test(text) ? text.replace(/^#[ \t]+.*$/mu, "# " + flow.name) : "# " + flow.name + "\n\n" + text;
  }
  const about = flow.description.trim() === "" ? [] : [flow.description.trim(), ""];
  return ["# " + flow.name, "", ...about, "Call `stage_start({skill: " + str(name) + "})` to run this skill as a track, then follow each stage."].join("\n");
}

export function flowToSkill(flow: Flow): string {
  const name = skillName(flow);
  const order = orderedNodes(flow);
  const p = plan(flow, order);
  const parts: string[] = [];
  const inputs = flow.nodes.flatMap((node) => (node.kind === "input" ? node.fields.map((field) => inputTag(field, (p.inputRef.get(node.id + "\u0000" + field.name) ?? "").split(".")[1] ?? fieldName(field.name))) : []));
  if (inputs.length > 0) parts.push(inputs.join("\n"));
  for (const node of order) {
    const id = p.stageOf.get(node.id);
    if (id === undefined) continue;
    if (node.kind === "skill") parts.push(skillStage(flow, p, node, id));
    else if (node.kind === "gate") parts.push(gateStage(flow, p, node, id));
    else if (node.kind === "fork") parts.push(forkStage(flow, p, node, id));
  }
  const resultTaken = new Set<string>();
  const results = flow.nodes.flatMap((node) => {
    if (node.kind !== "output" || node.source === null) return [];
    const ref = refOf(flow, p, node.source);
    return ref === null ? [] : ["{% result name=" + str(fieldName(node.label, resultTaken)) + " from=" + ref + " /%}"];
  });
  if (results.length > 0) parts.push(results.join("\n"));
  return "---\n" + frontmatter(flow, name) + "---\n\n" + preamble(flow, name) + "\n\n" + parts.join("\n\n") + "\n";
}

type Mark = { $$mdtype?: unknown; name?: unknown; parameters?: unknown; path?: unknown };

export function valueText(value: unknown): string {
  if (typeof value === "string") return str(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(valueText).join(", ") + "]";
  if (typeof value === "object") {
    const mark = value as Mark;
    if (mark.$$mdtype === "Variable" && Array.isArray(mark.path)) return "$" + mark.path.map(String).join(".");
    if (mark.$$mdtype === "Function" && typeof mark.name === "string") {
      const params = Object.entries((mark.parameters ?? {}) as Record<string, unknown>);
      const positional = params.filter(([key]) => /^\d+$/u.test(key)).sort((a, b) => Number(a[0]) - Number(b[0]));
      const named = params.filter(([key]) => !/^\d+$/u.test(key));
      return mark.name + "(" + [...positional.map(([, item]) => valueText(item)), ...named.map(([key, item]) => key + "=" + valueText(item))].join(", ") + ")";
    }
  }
  return str(String(value));
}

function equalsAll(value: unknown): { scope: string; field: string; value: string }[] | null {
  const single = equalsOf(value);
  if (single !== null) return [single];
  if (typeof value !== "object" || value === null) return null;
  const mark = value as Mark;
  if (mark.$$mdtype !== "Function" || mark.name !== "or") return null;
  const parts = Object.values((mark.parameters ?? {}) as Record<string, unknown>).map(equalsOf);
  if (parts.length === 0 || parts.some((part) => part === null)) return null;
  const all = parts as { scope: string; field: string; value: string }[];
  return all.every((part) => part.scope === all[0]!.scope && part.field === all[0]!.field) ? all : null;
}

function equalsOf(value: unknown): { scope: string; field: string; value: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const mark = value as Mark;
  if (mark.$$mdtype !== "Function" || mark.name !== "equals") return null;
  const params = (mark.parameters ?? {}) as Record<string, unknown>;
  const ref = params["0"] as Mark | undefined;
  const literal = params["1"];
  if (Object.keys(params).length !== 2 || ref?.$$mdtype !== "Variable" || !Array.isArray(ref.path) || ref.path.length !== 2 || typeof literal !== "string") return null;
  return { scope: String(ref.path[0]), field: String(ref.path[1]), value: literal };
}

function text(tagged: OutlineTag, key: string): string | undefined {
  const value = tagged.attrs[key];
  return typeof value === "string" ? value : undefined;
}

type RawEdge = { to: string; when: unknown; label?: string; max?: number; exceeded?: string };

type StageDraft = {
  id: string;
  title: string | undefined;
  skill: string | undefined;
  userGate: boolean;
  outputsGate: boolean;
  outputs: { name: string; type: IoType; description: string; optional: boolean; by: string | undefined }[];
  edges: RawEdge[];
  binds: { name: string; stage: string; field: string }[];
  instruction: string;
};

function cut(source: string, start: number, end: number, ranges: { start: number; end: number }[]): string {
  let out = "";
  let at = start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    out += source.slice(at, range.start);
    at = Math.max(at, range.end);
  }
  return out + source.slice(at, end);
}

function stageDraft(source: string, stage: OutlineTag): StageDraft {
  const removed: { start: number; end: number }[] = [];
  const draft: StageDraft = { id: text(stage, "id") ?? "", title: text(stage, "title"), skill: text(stage, "skill"), userGate: stage.attrs.gate === "user", outputsGate: false, outputs: [], edges: [], binds: [], instruction: "" };
  const modeled = stage.children.filter((child) => child.name === "output").every((child) => typeof text(child, "name") === "string" && typeof parseIoType(text(child, "type") ?? "text") !== "string" && Object.keys(child.attrs).every((key) => ["name", "type", "description", "optional", "by"].includes(key)));
  for (const child of stage.children) {
    if (child.name === "output" && modeled) {
      const type = parseIoType(text(child, "type") ?? "text");
      if (typeof type === "string") continue;
      draft.outputs.push({ name: text(child, "name") ?? "", type, description: text(child, "description") ?? "", optional: child.attrs.optional === true, by: text(child, "by") });
      removed.push({ start: child.lineStart, end: child.lineEnd });
    } else if (child.name === "next" && child.children.length === 0 && child.end === child.innerEnd && text(child, "to") !== undefined) {
      const edge: RawEdge = { to: (text(child, "to") ?? "").trim(), when: child.attrs.when };
      const label = text(child, "label");
      if (label !== undefined) edge.label = label;
      if (typeof child.attrs.max === "number") edge.max = child.attrs.max;
      const exceeded = text(child, "exceeded");
      if (exceeded !== undefined) edge.exceeded = exceeded;
      draft.edges.push(edge);
      removed.push({ start: child.lineStart, end: child.lineEnd });
    } else if (child.name === "gate" && child.attrs.type === "outputs" && Object.keys(child.attrs).length === 1 && stage.children.find((item) => item.name === "gate") === child) {
      draft.outputsGate = true;
      removed.push({ start: child.lineStart, end: child.lineEnd });
    }
  }
  const body = cut(source, stage.innerStart, stage.innerEnd, removed);
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    const bind = BIND_LINE.exec(line);
    if (bind === null) kept.push(line);
    else draft.binds.push({ name: bind[1] ?? "", stage: bind[2] ?? "", field: bind[3] ?? "" });
  }
  draft.instruction = kept.join("\n").replace(/^\n+|\s+$/gu, "");
  return draft;
}

function isFork(draft: StageDraft): boolean {
  if (draft.skill !== undefined || draft.userGate || draft.outputsGate || draft.outputs.length > 0 || draft.binds.length > 0 || draft.instruction !== "" || draft.edges.length === 0) return false;
  const conds = draft.edges.map((edge) => (edge.when === undefined ? null : equalsAll(edge.when)));
  const scope = conds.find((cond) => cond !== null)?.[0];
  if (scope === undefined || scope.scope !== INPUT_SCOPE) return false;
  const last = conds.length - 1;
  return conds.every((cond, index) => (cond === null ? index === last && draft.edges[index]?.when === undefined : cond[0]?.scope === scope.scope && cond[0]?.field === scope.field));
}

function isGate(draft: StageDraft): boolean {
  const only = draft.outputs[0];
  if (draft.skill !== undefined || draft.outputsGate || draft.outputs.length !== 1 || only?.type.kind !== "choice" || draft.instruction !== "") return false;
  return draft.edges.every((edge) => {
    const cond = equalsAll(edge.when);
    return cond !== null && cond[0]?.scope === draft.id && cond[0]?.field === only.name;
  });
}

export type SkillFlowResult = { ok: true; flow: Flow } | { ok: false; problems: Problem[] };

export interface SkillFlowOptions {
  useCaseId: string;
  positions?: Positions;
}

export function skillToFlow(source: string, skills: readonly SkillInfo[], options: SkillFlowOptions): SkillFlowResult {
  const parsed = parseSkill(source, "SKILL.md");
  if (!parsed.ok) return { ok: false, problems: parsed.problems };
  const outline = outlineSkill(source);
  const front = readFrontmatter(source);
  if (outline === undefined || front === undefined) return { ok: false, problems: [{ file: "SKILL.md", line: 1, tag: "frontmatter", message: "the file has no frontmatter", fix: "add a --- block" }] };
  const machine = parsed.machine;
  const stages = outline.tags.filter((item) => item.name === "stage").map((item) => stageDraft(source, item));
  const firstStage = outline.tags.find((item) => item.name === "stage");
  const preambleCut = outline.tags.filter((item) => item.name === "input" && (firstStage === undefined || item.start < firstStage.start)).map((item) => ({ start: item.lineStart, end: item.lineEnd }));
  const preamble = cut(source, outline.bodyStart, firstStage?.lineStart ?? source.length, preambleCut).replace(/^\s+|\s+$/gu, "");
  const nodes: FlowNode[] = [];
  const wires: Wire[] = [];
  const inputFields: InputField[] = (machine.inputs ?? []).map((input) => {
    const type = parseIoType(input.type ?? "text");
    const base = { name: input.name, options: [], prompt: input.description ?? "", path: "", optional: input.optional === true };
    if (typeof type === "string") return { ...base, type: "text" };
    if (type.kind === "choice") return { ...base, type: "choice", options: [...type.values] };
    if (type.kind === "file") return { ...base, type: "file", path: type.path ?? "" };
    return { ...base, type: type.kind };
  });
  const startId = machine.start ?? stages[0]?.id;
  if (inputFields.length > 0) nodes.push({ id: INPUT_NODE_ID, kind: "input", name: "Inputs", x: 0, y: 0, fields: inputFields } satisfies InputNode);
  const info = (draft: StageDraft) => skills.find((item) => item.name === draft.skill);
  const portName = new Map<string, string>();
  for (const draft of stages) {
    const known = info(draft);
    for (const output of draft.outputs) portName.set(draft.id + "." + output.name, known?.outputs.find((item) => fieldName(item.name) === output.name)?.name ?? output.name);
  }
  const bindingOf = (stage: string, field: string): Binding => (stage === INPUT_SCOPE ? { nodeId: INPUT_NODE_ID, port: field } : { nodeId: stage, port: portName.get(stage + "." + field) ?? field });
  const results = machine.result ?? [];
  const outputNodes: OutputNode[] = results.map((result) => {
    const [stage = "", field = ""] = result.from.replace(/^\$/u, "").split(".");
    return { id: "result-" + result.name.toLowerCase().replace(/_/gu, "-"), kind: "output", label: result.name.replace(/_/gu, " "), x: 0, y: 0, source: bindingOf(stage, field), deliverable: true };
  });
  let doneNode: OutputNode | null = null;
  let wireCount = 0;
  const addWire = (from: string, port: number, to: string, extra: Partial<Wire> = {}) => {
    wireCount += 1;
    wires.push({ id: "w" + String(wireCount), from, port, to, ...extra });
  };
  if (inputFields.length > 0 && startId !== undefined) addWire(INPUT_NODE_ID, 0, startId);
  const doneTarget = (from: string): string => {
    const own = outputNodes.find((node) => node.source?.nodeId === from) ?? outputNodes[outputNodes.length - 1];
    if (own !== undefined) return own.id;
    doneNode ??= { id: "end", kind: "output", label: DONE_LABEL, x: 0, y: 0, source: null, deliverable: false };
    return doneNode.id;
  };
  for (const draft of stages) {
    if (isGate(draft)) {
      const answer = draft.outputs[0]!;
      const values = answer.type.kind === "choice" ? answer.type.values : [];
      const ends: number[] = [];
      const gate: GateNode = { id: draft.id, kind: "gate", question: answer.description || draft.title || draft.id, x: 0, y: 0, owner: answer.by === "owner" ? "owner" : draft.userGate ? "anyone" : "agent", options: [...values], material: draft.binds.map((bind) => bindingOf(bind.stage, bind.field)), ends, answer: answer.name };
      nodes.push(gate);
      const routes = draft.edges.flatMap((edge) => (equalsAll(edge.when) ?? []).map((cond) => ({ port: values.indexOf(cond.value), to: edge.to }))).filter((route) => route.port >= 0).sort((a, b) => a.port - b.port);
      for (const route of routes) {
        if (route.to !== DONE_STAGE) addWire(draft.id, route.port, route.to);
        else if (outputNodes.length > 0) addWire(draft.id, route.port, doneTarget(draft.id));
        else ends.push(route.port);
      }
      continue;
    }
    if (isFork(draft)) {
      const paths: ForkNode["paths"] = [];
      let otherwise: ForkNode["otherwise"] = null;
      let field = "";
      const routes: { value: string; note: string; to: string }[] = [];
      for (const edge of draft.edges) {
        const conds = equalsAll(edge.when);
        if (conds === null) otherwise = { label: OTHERWISE, note: edge.label ?? "" };
        else for (const cond of conds) {
          field = cond.field;
          routes.push({ value: cond.value, note: edge.label ?? "", to: edge.to });
        }
      }
      const options = inputFields.find((item) => item.name === field)?.options ?? [];
      const rank = (value: string) => (options.includes(value) ? options.indexOf(value) : options.length);
      routes.sort((a, b) => rank(a.value) - rank(b.value));
      for (const route of routes) {
        paths.push({ label: route.value, note: route.note });
        if (route.to !== DONE_STAGE) addWire(draft.id, paths.length - 1, route.to);
      }
      const last = draft.edges[draft.edges.length - 1];
      if (otherwise !== null && last !== undefined) addWire(draft.id, paths.length, last.to === DONE_STAGE ? doneTarget(draft.id) : last.to);
      nodes.push({ id: draft.id, kind: "fork", name: draft.title ?? draft.id, x: 0, y: 0, choice: { nodeId: INPUT_NODE_ID, port: field }, paths, otherwise });
      continue;
    }
    const known = info(draft);
    const inputs: SkillNode["inputs"] = (known?.inputs ?? []).map((input) => {
      const bind = draft.binds.find((item) => item.name === input.name);
      return { ...input, bind: bind === undefined ? null : bindingOf(bind.stage, bind.field) };
    });
    for (const bind of draft.binds) if (!inputs.some((input) => input.name === bind.name)) inputs.push({ name: bind.name, optional: false, type: { kind: "text" }, bind: bindingOf(bind.stage, bind.field) });
    const outputs: SkillNode["outputs"] = draft.outputs.map((output) => {
      const name = portName.get(draft.id + "." + output.name) ?? output.name;
      const declared = known?.outputs.find((item) => item.name === name);
      const filePath = output.type.kind === "file" ? output.type.path : null;
      const keepType = declared !== undefined && declared.type.kind === "file" && output.type.kind === "file";
      const type: IoType = keepType ? declared.type : output.type;
      const path = keepType && declared.type.kind === "file" && declared.type.path !== filePath ? filePath : null;
      return { name, optional: output.optional, type, path, description: output.description, byOwner: output.by === "owner" };
    });
    const required = outputs.some((output) => !output.optional);
    nodes.push({ id: draft.id, kind: "skill", name: draft.title ?? draft.skill ?? draft.id, x: 0, y: 0, skill: draft.skill ?? null, instruction: draft.instruction, inputs, outputs, ownerApproves: draft.userGate, requireOutputs: required ? draft.outputsGate : true });
    for (const edge of draft.edges) {
      const extra: Partial<Wire> = {};
      if (edge.when !== undefined) extra.when = valueText(edge.when);
      if (edge.label !== undefined) extra.label = edge.label;
      if (edge.max !== undefined) extra.max = edge.max;
      if (edge.exceeded !== undefined) extra.exceeded = edge.exceeded;
      addWire(draft.id, 0, edge.to === DONE_STAGE ? doneTarget(draft.id) : edge.to, extra);
    }
  }
  nodes.push(...outputNodes);
  if (doneNode !== null) nodes.push(doneNode);
  const positions = options.positions ?? {};
  const placed = nodes.map((node) => ({ ...node, ...(positions[node.id] ?? {}) }));
  const flow: Flow = {
    version: 2,
    id: machine.id,
    useCaseId: options.useCaseId,
    name: machine.title,
    description: machine.description ?? "",
    nodes: placed,
    wires,
    preamble,
    frontmatter: front.raw.endsWith("\n") ? front.raw : front.raw + "\n",
  };
  return { ok: true, flow };
}
