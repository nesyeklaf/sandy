import Markdoc from "@markdoc/markdoc";
import { readFrontmatter } from "./frontmatter.ts";

export type OutlineTag = {
  name: string;
  attrs: Record<string, unknown>;
  line: number;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  lineStart: number;
  lineEnd: number;
  children: OutlineTag[];
};

export type SkillOutline = {
  frontmatterEnd: number;
  bodyStart: number;
  tags: OutlineTag[];
};

type Token = {
  type: string;
  start: number;
  end: number;
  meta?: {
    tag?: string;
    attributes?: { type: string; name: string; value: unknown }[] | null;
  };
};

function wholeLines(
  source: string,
  start: number,
  end: number,
): { lineStart: number; lineEnd: number } {
  const before = source.lastIndexOf("\n", start - 1) + 1;
  const after = source.indexOf("\n", end);
  const stop = after < 0 ? source.length : after;
  const alone =
    source.slice(before, start).trim() === "" &&
    source.slice(end, stop).trim() === "";
  if (!alone) return { lineStart: start, lineEnd: end };
  return { lineStart: before, lineEnd: after < 0 ? source.length : after + 1 };
}

export function outlineSkill(source: string): SkillOutline | undefined {
  const front = readFrontmatter(source);
  if (front === undefined) return undefined;
  const body = source.slice(front.bodyStart);
  const base = front.bodyStart;
  const lineOf = (offset: number): number =>
    source.slice(0, offset).split("\n").length;
  const root: OutlineTag[] = [];
  const stack: OutlineTag[] = [];
  const into = (): OutlineTag[] =>
    stack.length === 0 ? root : stack[stack.length - 1]!.children;
  for (const token of Markdoc.parseTags(body, front.bodyLine) as Token[]) {
    if (token.type !== "tag" && token.type !== "tag_open" && token.type !== "tag_close") continue;
    const start = base + token.start;
    const end = base + token.end + 1;
    if (token.type === "tag_close") {
      const open = stack.pop();
      if (open === undefined) continue;
      open.innerEnd = start;
      open.end = end;
      open.lineEnd = wholeLines(source, start, end).lineEnd;
      continue;
    }
    const attrs: Record<string, unknown> = {};
    for (const a of token.meta?.attributes ?? []) attrs[a.name] = a.value;
    const lines = wholeLines(source, start, end);
    const tag: OutlineTag = {
      name: token.meta?.tag ?? "",
      attrs,
      line: lineOf(start),
      start,
      end,
      innerStart: token.type === "tag_open" ? Math.max(end, lines.lineEnd) : end,
      innerEnd: end,
      lineStart: lines.lineStart,
      lineEnd: lines.lineEnd,
      children: [],
    };
    into().push(tag);
    if (token.type === "tag_open") stack.push(tag);
  }
  return { frontmatterEnd: front.bodyStart, bodyStart: front.bodyStart, tags: root };
}

export type SourceEdit = { start: number; end: number; text: string };

export function applyEdits(source: string, edits: readonly SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  let limit = source.length;
  for (const edit of sorted) {
    if (edit.end > limit || edit.start > edit.end)
      throw new Error("source edits overlap");
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}
