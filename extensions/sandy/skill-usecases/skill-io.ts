import { applyEdits, outlineSkill, readSkillIo, type CompiledField, type OutlineTag, type SourceEdit } from "@sandy/skill-dialect";
import { formatType, parseIo, parseIoType, type IoField } from "./io.ts";

export type IoSource = "tags" | "metadata" | "none";

export interface SkillIoRead {
  inputs: IoField[];
  outputs: IoField[];
  errors: string[];
  source: IoSource;
}

export interface IoMetadata {
  inputs?: string | undefined;
  outputs?: string | undefined;
}

export type IoKey = "inputs" | "outputs";

const TAG_OF: Record<IoKey, "input" | "output"> = { inputs: "input", outputs: "output" };

function fields(compiled: readonly CompiledField[], key: IoKey, errors: string[]): IoField[] {
  return compiled.flatMap((field) => {
    const type = parseIoType(field.type ?? "text");
    if (typeof type === "string") {
      errors.push(key + ": " + field.name + ": " + type);
      return [];
    }
    return [{ name: field.name, optional: field.optional === true, type }];
  });
}

function ioTags(content: string): OutlineTag[] {
  return (outlineSkill(content)?.tags ?? []).filter((tag) => tag.name === "input" || tag.name === "output" || tag.name === "result");
}

export function readIo(content: string, metadata: IoMetadata): SkillIoRead {
  if (ioTags(content).length > 0) {
    const io = readSkillIo(content);
    const errors = io.problems.map((problem) => "line " + String(problem.line) + ": " + problem.message);
    return { inputs: fields(io.inputs, "inputs", errors), outputs: fields(io.outputs, "outputs", errors), errors, source: "tags" };
  }
  const inputs = parseIo(metadata.inputs);
  const outputs = parseIo(metadata.outputs);
  return {
    inputs: inputs.fields,
    outputs: outputs.fields,
    errors: [...inputs.errors.map((error) => "inputs: " + error), ...outputs.errors.map((error) => "outputs: " + error)],
    source: metadata.inputs === undefined && metadata.outputs === undefined ? "none" : "metadata",
  };
}

function attrText(value: string | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function ioTag(name: "input" | "output", field: IoField, description: string | undefined): string {
  const attrs: [string, string | boolean][] = [["name", field.name]];
  if (field.type.kind !== "text") attrs.push(["type", formatType(field.type)]);
  if (description !== undefined) attrs.push(["description", description]);
  if (field.optional) attrs.push(["optional", true]);
  return "{% " + [name, ...attrs.map(([key, value]) => key + "=" + attrText(value))].join(" ") + " /%}";
}

function sameField(tag: OutlineTag, field: IoField): boolean {
  const type = typeof tag.attrs.type === "string" ? tag.attrs.type.trim() : "text";
  const parsed = parseIoType(type);
  return typeof parsed !== "string" && formatType(parsed) === formatType(field.type) && (tag.attrs.optional === true) === field.optional;
}

function insertionPoint(content: string, tags: readonly OutlineTag[], bodyStart: number): { at: number; lead: string; trail: string } {
  const last = tags.filter((tag) => tag.name === "input" || tag.name === "output").at(-1);
  if (last !== undefined) return { at: last.lineEnd, lead: "", trail: "" };
  const body = content.slice(bodyStart);
  const heading = /^#[ \t]+.*$/mu.exec(body);
  const firstStage = tags.find((tag) => tag.name === "stage");
  if (heading !== null && (firstStage === undefined || bodyStart + heading.index < firstStage.start)) {
    const lineEnd = body.indexOf("\n", heading.index);
    if (lineEnd >= 0) return { at: bodyStart + lineEnd + 1, lead: "\n", trail: "" };
    return { at: content.length, lead: "\n\n", trail: "\n" };
  }
  return { at: bodyStart, lead: "", trail: "\n" };
}

export function writeIoTags(content: string, changes: Partial<Record<IoKey, readonly IoField[]>>): string {
  const outline = outlineSkill(content);
  if (outline === undefined) throw new Error("The file has no frontmatter block between --- lines.");
  const edits: SourceEdit[] = [];
  const pending: string[] = [];
  for (const key of ["inputs", "outputs"] as const) {
    const next = changes[key];
    if (next === undefined) continue;
    const name = TAG_OF[key];
    const existing = outline.tags.filter((tag) => tag.name === name);
    const results = new Set(outline.tags.filter((tag) => tag.name === "result").map((tag) => tag.attrs.name));
    const lines = next.filter((field) => key === "inputs" || !results.has(field.name)).map((field) => {
      const tag = existing.find((candidate) => candidate.attrs.name === field.name);
      if (tag !== undefined && sameField(tag, field)) return content.slice(tag.start, tag.end);
      const description = typeof tag?.attrs.description === "string" ? tag.attrs.description : undefined;
      return ioTag(name, field, description);
    });
    const [first, ...rest] = existing;
    for (const tag of rest) edits.push({ start: tag.lineStart, end: tag.lineEnd, text: "" });
    if (first !== undefined) {
      const wholeLine = first.lineEnd > first.end;
      edits.push({ start: first.lineStart, end: first.lineEnd, text: lines.map((line) => line + (wholeLine ? "\n" : "")).join(wholeLine ? "" : " ") });
    } else pending.push(...lines);
  }
  if (pending.length > 0) {
    const point = insertionPoint(content, outline.tags, outline.bodyStart);
    edits.push({ start: point.at, end: point.at, text: point.lead + pending.join("\n") + "\n" + point.trail });
  }
  return applyEdits(content, edits);
}
