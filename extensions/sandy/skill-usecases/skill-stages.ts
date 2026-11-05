import { applyEdits, outlineSkill, parseSkill, type CompiledStage, type OutlineTag, type Problem } from "@sandy/skill-dialect";

export type TagValue = string | number | boolean;

export interface EditableTag {
  name: string;
  attrs: Record<string, TagValue>;
  line: number;
  start: number;
  end: number;
}

export interface StageView {
  id: string;
  title: string;
  line: number;
  start: number;
  end: number;
  compiled: CompiledStage | null;
  outputs: EditableTag[];
  tags: OutlineTag[];
}

export type StagesRead = { ok: true; stages: StageView[]; problems: Problem[] } | { ok: false; error: string };

function primitives(attrs: Record<string, unknown>): Record<string, TagValue> | null {
  const out: Record<string, TagValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
    out[key] = value;
  }
  return out;
}

function editable(tag: OutlineTag): EditableTag | null {
  const attrs = primitives(tag.attrs);
  return attrs === null ? null : { name: tag.name, attrs, line: tag.line, start: tag.start, end: tag.end };
}

export function readStages(source: string): StagesRead {
  const outline = outlineSkill(source);
  if (outline === undefined) return { ok: false, error: "SKILL.md has no frontmatter." };
  const parsed = parseSkill(source, "SKILL.md");
  const compiled = parsed.ok ? parsed.machine.stages : [];
  const stages = outline.tags
    .filter((tag) => tag.name === "stage" && typeof tag.attrs.id === "string")
    .map((tag): StageView => {
      const id = String(tag.attrs.id);
      return {
        id,
        title: typeof tag.attrs.title === "string" ? tag.attrs.title : id,
        line: tag.line,
        start: tag.lineStart,
        end: tag.lineEnd,
        compiled: compiled.find((stage) => stage.id === id) ?? null,
        outputs: tag.children.filter((child) => child.name === "output").flatMap((child) => editable(child) ?? []),
        tags: tag.children,
      };
    });
  return { ok: true, stages, problems: parsed.ok ? [] : parsed.problems };
}

export function formatTag(name: string, attrs: Record<string, TagValue>): string {
  const parts = Object.entries(attrs).map(([key, value]) => (typeof value === "string" ? key + "=" + JSON.stringify(value) : key + "=" + String(value)));
  return "{% " + [name, ...parts].join(" ") + " /%}";
}

export function setTag(source: string, tag: EditableTag, attrs: Record<string, TagValue>): string {
  return applyEdits(source, [{ start: tag.start, end: tag.end, text: formatTag(tag.name, attrs) }]);
}

export function stageSource(source: string, stage: StageView): string {
  return source.slice(stage.start, stage.end);
}

export function replaceStage(source: string, stage: StageView, text: string): string {
  return applyEdits(source, [{ start: stage.start, end: stage.end, text }]);
}

export function sourceProblems(source: string): Problem[] {
  const parsed = parseSkill(source, "SKILL.md");
  return parsed.ok ? [] : parsed.problems;
}
