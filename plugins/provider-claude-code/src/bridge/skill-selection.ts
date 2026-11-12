import {
  experimental_isSkillNameEnabled as isSkillNameEnabled,
  type ExperimentalSkillSelection as SkillSelection,
} from "@sandy-sdk/plugin-sdk/provider-bridge";

export interface ClaudeSkillFilter {
  skillOverrides?: Record<string, "off">;
}

export function buildClaudeSkillFilter(args: {
  selection: SkillSelection;
  nativeSkillNames: readonly string[];
}): ClaudeSkillFilter {
  const off =
    args.selection.mode === "disable"
      ? [...args.selection.names]
      : args.selection.mode === "allow-only"
        ? args.nativeSkillNames.filter(
            (name) => !isSkillNameEnabled(args.selection, name),
          )
        : [];
  return off.length === 0
    ? {}
    : {
        skillOverrides: Object.fromEntries(
          [...new Set(off)].map((name) => [name, "off" as const]),
        ),
      };
}
