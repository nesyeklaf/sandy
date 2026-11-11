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

export const providerSkillSelectionSupportSchema = z
  .object({
    session: skillSelectionEnforcementSchema,
    subagents: skillSelectionEnforcementSchema,
  })
  .strict();
export type ProviderSkillSelectionSupport = z.infer<
  typeof providerSkillSelectionSupportSchema
>;

export const NOT_ENFORCED_SKILL_SELECTION_SUPPORT: ProviderSkillSelectionSupport =
  Object.freeze({ session: "not-enforced", subagents: "not-enforced" });
