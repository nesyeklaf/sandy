import { z } from "zod";

export const SKILL_SELECTION_MAX_NAMES = 1_000;

const skillSelectionNamesSchema = z
  .array(z.string().trim().min(1).max(256))
  .max(SKILL_SELECTION_MAX_NAMES)
  .refine((names) => new Set(names).size === names.length, {
    message: "Skill names must be unique",
  });

export const skillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z
    .object({ mode: z.literal("disable"), names: skillSelectionNamesSchema })
    .strict(),
  z
    .object({
      mode: z.literal("allow-only"),
      names: skillSelectionNamesSchema,
    })
    .strict(),
]);
export type SkillSelection = z.infer<typeof skillSelectionSchema>;

export const INHERIT_SKILL_SELECTION: SkillSelection = Object.freeze({
  mode: "inherit",
});

export function isSkillNameEnabled(
  selection: SkillSelection,
  name: string,
): boolean {
  switch (selection.mode) {
    case "inherit":
      return true;
    case "disable":
      return !selection.names.includes(name);
    case "allow-only":
      return selection.names.includes(name);
  }
}

export function canonicalSkillSelection(
  selection: SkillSelection,
): SkillSelection {
  if (selection.mode === "inherit") return INHERIT_SKILL_SELECTION;
  return {
    mode: selection.mode,
    names: [...new Set(selection.names)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
}

export function setSkillNamesEnabled(
  selection: SkillSelection,
  names: readonly string[],
  enabled: boolean,
): SkillSelection {
  if (selection.mode === "inherit") {
    return enabled
      ? INHERIT_SKILL_SELECTION
      : canonicalSkillSelection({ mode: "disable", names: [...names] });
  }
  const listed = (selection.mode === "allow-only") === enabled;
  const current = new Set(selection.names);
  for (const name of names) {
    if (listed) current.add(name);
    else current.delete(name);
  }
  return canonicalSkillSelection({ mode: selection.mode, names: [...current] });
}

export function skillSelectionKey(selection: SkillSelection): string {
  return JSON.stringify(canonicalSkillSelection(selection));
}

export const SKILL_SELECTION_ENFORCEMENTS = [
  "enforced",
  "not-enforced",
  "unverified",
  "not-applicable",
] as const;
export const skillSelectionEnforcementSchema = z.enum(
  SKILL_SELECTION_ENFORCEMENTS,
);
export type SkillSelectionEnforcement = z.infer<
  typeof skillSelectionEnforcementSchema
>;

export const SKILL_SELECTION_GAPS = [
  "bundled-skills",
  "marketplace-plugin-skills",
  "extension-skills",
  "allow-only-skills-added-after-start",
] as const;
export const skillSelectionGapSchema = z.enum(SKILL_SELECTION_GAPS);
export type SkillSelectionGap = z.infer<typeof skillSelectionGapSchema>;

export const SKILL_SELECTION_GAP_LABELS: Readonly<
  Record<SkillSelectionGap, string>
> = Object.freeze({
  "bundled-skills": "skills bundled with the agent",
  "marketplace-plugin-skills": "skills from the agent's own plugins",
  "extension-skills": "skills from extensions",
  "allow-only-skills-added-after-start":
    "under allow-only, skills added after a session started",
});

export const providerSkillSelectionSupportSchema = z
  .object({
    session: skillSelectionEnforcementSchema,
    subagents: skillSelectionEnforcementSchema,
    gaps: z.array(skillSelectionGapSchema).default([]),
  })
  .strict();
export type ProviderSkillSelectionSupport = z.infer<
  typeof providerSkillSelectionSupportSchema
>;
export type ProviderSkillSelectionSupportDeclaration = z.input<
  typeof providerSkillSelectionSupportSchema
>;

export const NOT_ENFORCED_SKILL_SELECTION_SUPPORT: ProviderSkillSelectionSupport =
  Object.freeze({ session: "not-enforced", subagents: "not-enforced", gaps: [] });
