import { homedir } from "node:os";
import {
  experimental_isSkillNameEnabled as isSkillNameEnabled,
  type ExperimentalSkillSelection as SkillSelection,
} from "@sandy-sdk/plugin-sdk/provider-bridge";
import { resolvePiAgentDir } from "../native-roots.js";
import {
  resolvePiSessionSkills,
  type PiSessionSkill,
} from "../pi-package-skills.js";

export interface PiSkillLaunch {
  noSkills: boolean;
  skillPaths: string[];
}

export interface ResolvePiSkillLaunchArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  injectedSkillPaths: readonly string[];
  selection: SkillSelection;
  resolveSessionSkills?: typeof resolvePiSessionSkills;
  onResolveError?: (error: unknown) => void;
}

export function selectPiSessionSkillPaths(
  skills: readonly PiSessionSkill[],
  selection: SkillSelection,
): string[] {
  return skills
    .filter((skill) => isSkillNameEnabled(selection, skill.name))
    .map((skill) => skill.filePath);
}

export async function resolvePiSkillLaunch(
  args: ResolvePiSkillLaunchArgs,
): Promise<PiSkillLaunch> {
  if (args.selection.mode === "inherit") {
    return { noSkills: false, skillPaths: [...args.injectedSkillPaths] };
  }
  const resolveSessionSkills =
    args.resolveSessionSkills ?? resolvePiSessionSkills;
  try {
    const skills = await resolveSessionSkills({
      cwd: args.cwd,
      agentDir: resolvePiAgentDir({
        homeDir: args.env.HOME?.trim() || homedir(),
        env: args.env,
      }),
      env: args.env,
      extraSkillPaths: args.injectedSkillPaths,
    });
    return {
      noSkills: true,
      skillPaths: selectPiSessionSkillPaths(skills, args.selection),
    };
  } catch (error) {
    args.onResolveError?.(error);
    return { noSkills: true, skillPaths: [...args.injectedSkillPaths] };
  }
}
