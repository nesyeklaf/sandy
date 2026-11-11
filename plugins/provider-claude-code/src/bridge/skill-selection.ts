import type { ExperimentalSkillSelection as SkillSelection } from "@sandy-sdk/plugin-sdk/provider-bridge";

export interface ClaudeSkillFilter {
  skillOverrides?: Record<string, "off">;
  skills?: string[];
}

export function buildClaudeSkillFilter(args: {
  selection: SkillSelection;
  injectedPluginNames: readonly string[];
}): ClaudeSkillFilter {
  switch (args.selection.mode) {
    case "inherit":
      return {};
    case "disable":
      return args.selection.names.length === 0
        ? {}
        : {
            skillOverrides: Object.fromEntries(
              args.selection.names.map((name) => [name, "off" as const]),
            ),
          };
    case "allow-only": {
      const names = args.selection.names;
      return {
        skills: [
          ...names,
          ...args.injectedPluginNames.flatMap((plugin) =>
            names.map((name) => `${plugin}:${name}`),
          ),
        ],
      };
    }
  }
}
