import { condRefs, describeCond, type Cond, type Scope, type Segment } from "./model.ts";
import { evaluate, parseList, parseMap } from "./values.ts";

export const ABSENT_VALUE = "(not produced yet)";

function renderValue(segment: Extract<Segment, { type: "ref" }>, scope: Scope): string {
  const value = scope[segment.ref];
  if (value === undefined || value.trim() === "") return ABSENT_VALUE;
  if (segment.list === undefined) return value.trim();
  const listRaw = scope[segment.list];
  const map = parseMap(value);
  const list = listRaw === undefined ? undefined : parseList(listRaw);
  if (!map.ok || list === undefined || !list.ok) return value.trim();
  return map.entries
    .map((e) => `- ${e.position}. ${list.items[e.position - 1] ?? "?"}: ${e.value}${e.reason === "" ? "" : ` — ${e.reason}`}`)
    .join("\n");
}

function renderSegments(segments: readonly Segment[], scope: Scope): string {
  let out = "";
  for (const segment of segments) {
    switch (segment.type) {
      case "text":
        out += segment.text;
        break;
      case "ref":
        out += renderValue(segment, scope);
        break;
      case "if":
        out += renderSegments(evaluate(segment.cond, scope) ? segment.then : segment.else, scope);
        break;
    }
  }
  return out;
}

export function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderStage(stage: { template?: Segment[]; description?: string }, scope: Scope): string {
  if (stage.template === undefined) return stage.description ?? "";
  return tidy(renderSegments(stage.template, scope));
}

function describeSegments(segments: readonly Segment[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment.type === "text") out += segment.text;
    else if (segment.type === "ref") out += `$${segment.ref}`;
    else
      out += `[if ${describeCond(segment.cond)}: ${describeSegments(segment.then).trim()}${
        segment.else.length > 0 ? ` | else: ${describeSegments(segment.else).trim()}` : ""
      }]`;
  }
  return out;
}

export function describeTemplate(segments: readonly Segment[]): string {
  return tidy(describeSegments(segments));
}

export function explainCond(cond: Cond, scope: Scope, max = 300): string {
  const operands = [...new Set(condRefs(cond))]
    .map((ref) => {
      const value = scope[ref];
      return `$${ref} = ${value === undefined ? "absent" : JSON.stringify(value.trim())}`;
    })
    .join("; ");
  const text = `${describeCond(cond)}${operands === "" ? "" : ` with ${operands}`}`;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
