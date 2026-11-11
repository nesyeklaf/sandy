import {
  experimental_isSkillNameEnabled as isSkillNameEnabled,
  type ExperimentalSkillSelection as SkillSelection,
} from "@sandy-sdk/plugin-sdk/provider-bridge";

export interface CodexListedSkill {
  name: string;
  path: string;
  enabled: boolean;
}

type CodexSkillConfigEntry =
  | { name: string; enabled: false }
  | { path: string; enabled: false };

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function formatEntry(entry: CodexSkillConfigEntry): string {
  return "name" in entry
    ? `{name=${tomlString(entry.name)},enabled=false}`
    : `{path=${tomlString(entry.path)},enabled=false}`;
}

export function codexSkillConfigEntries(
  selection: SkillSelection,
  listed: readonly CodexListedSkill[] | null,
): CodexSkillConfigEntry[] | null {
  switch (selection.mode) {
    case "inherit":
      return [];
    case "disable": {
      const userDisabled = (listed ?? [])
        .filter((skill) => !skill.enabled)
        .map((skill) => ({ path: skill.path, enabled: false as const }));
      return [
        ...selection.names.map((name) => ({ name, enabled: false as const })),
        ...userDisabled,
      ];
    }
    case "allow-only":
      if (listed === null) return null;
      return listed
        .filter(
          (skill) => !skill.enabled || !isSkillNameEnabled(selection, skill.name),
        )
        .map((skill) => ({ path: skill.path, enabled: false as const }));
  }
}

export function codexSkillConfigArgs(
  entries: readonly CodexSkillConfigEntry[],
): string[] {
  if (entries.length === 0) return [];
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = "name" in entry ? `name:${entry.name}` : `path:${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return ["-c", `skills.config=[${unique.map(formatEntry).join(",")}]`];
}
