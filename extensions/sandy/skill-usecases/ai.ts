import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import type { FlowStep, SkillRow } from "./contract.ts";
import type { UseCase } from "./usecases.ts";

const WAIT_MS = 240_000;
const MAX_SKILLS_IN_PROMPT = 250;
const DESCRIPTION_CHARS = 160;

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The AI reply contained no JSON.");
  return JSON.parse(body.slice(start, end + 1));
}

export async function askJson<Schema extends z.ZodType>(
  sandy: SandyPluginApi,
  projectId: string,
  title: string,
  prompt: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  const thread = await sandy.sdk.threads.spawn({
    projectId,
    environment: { type: "project-default" },
    prompt,
    title,
    visibility: "hidden",
  });
  try {
    await sandy.sdk.threads.wait({ threadId: thread.id, status: "idle", timeoutMs: WAIT_MS });
    const { output } = await sandy.sdk.threads.output({ threadId: thread.id });
    if (output === null) throw new Error("The AI returned no answer.");
    return schema.parse(extractJson(output));
  } finally {
    await sandy.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: false }).catch(() => undefined);
  }
}

function skillLine(skill: Pick<SkillRow, "name" | "description">, area: string | null): string {
  const description = (skill.description ?? "").replace(/\s+/gu, " ").slice(0, DESCRIPTION_CHARS);
  return "- " + skill.name + (area === null ? "" : " [" + area + "]") + ": " + description;
}

export const assignmentsReplySchema = z.object({
  assignments: z.array(z.object({ skill: z.string(), area: z.string(), reason: z.string().default("") })),
});

export function assignmentsPrompt(skills: readonly SkillRow[], useCases: readonly UseCase[], fallbackId: string): string {
  const areas = useCases.map((useCase) => "- " + useCase.id + ": " + useCase.label).join("\n");
  return [
    "Sort agent skills into use-case areas by what each skill is used for. Do not use any tools and do not read files; answer from the names and descriptions below.",
    "Existing areas (id: label):\n" + areas + "\n- " + fallbackId + ": Other (only when nothing fits)",
    "You may propose a new area with a short English label (max 4 words) when several skills fit no existing area. Reuse an existing area whenever it fits.",
    "Skills:\n" + skills.slice(0, MAX_SKILLS_IN_PROMPT).map((skill) => skillLine(skill, null)).join("\n"),
    'Reply with JSON only, no prose: {"assignments":[{"skill":"<skill name>","area":"<existing area id or new area label>","reason":"<at most 12 words>"}]} covering every skill.',
  ].join("\n\n");
}

export const flowReplySchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  rationale: z.string().default(""),
  steps: z.array(z.object({ skill: z.string(), note: z.string().default("") })),
});

export function flowPrompt(args: {
  area: string;
  goal: string;
  skills: readonly SkillRow[];
  areaLabels: ReadonlyMap<string, string>;
  areaId: string;
  current: readonly FlowStep[] | null;
}): string {
  const inArea = args.skills.filter((skill) => skill.useCaseId === args.areaId);
  const rest = args.skills.filter((skill) => skill.useCaseId !== args.areaId);
  const listed = [...inArea, ...rest].slice(0, MAX_SKILLS_IN_PROMPT);
  const lines = listed.map((skill) => skillLine(skill, args.areaLabels.get(skill.useCaseId) ?? null));
  const task =
    args.current === null
      ? "Design a flow: an ordered sequence of skills an agent or user runs one after another to reach the goal."
      : "Improve this existing flow. Fix the order, add missing skills, drop redundant ones. Current order:\n" +
        args.current.map((step, index) => String(index + 1) + ". " + step.skill + (step.note === "" ? "" : " - " + step.note)).join("\n");
  return [
    "You design workflows from a catalog of agent skills. Do not use any tools and do not read files; answer from the catalog below.",
    "Use case: " + args.area,
    "Goal: " + (args.goal.trim() === "" ? "the typical job of this use case" : args.goal.trim()),
    task,
    "Rules: use only skill names from the catalog, exactly as written; each skill at most once; 2 to 8 steps; skills in the use case area are preferred.",
    "Skill catalog (name [area]: description):\n" + lines.join("\n"),
    'Reply with JSON only, no prose: {"name":"<short flow name>","description":"<one sentence>","rationale":"<2 sentences on why this order>","steps":[{"skill":"<name>","note":"<what this step achieves, at most 15 words>"}]}',
  ].join("\n\n");
}
