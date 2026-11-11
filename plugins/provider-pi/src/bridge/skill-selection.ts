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
import { buildPiChildEnv } from "./rpc-child.js";

export interface PiSkillLaunch {
  noSkills: boolean;
  skillPaths: string[];
}

export interface ResolvePiSkillLaunchArgs {
  cwd: string;
  shellEnvOverrides: Record<string, string>;
  injectedSkillPaths: readonly string[];
  selection: SkillSelection;
  resolveSessionSkills?: typeof resolvePiSessionSkills;
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
  const sessionEnv = buildPiChildEnv(args.shellEnvOverrides);
  try {
    const skills = await resolveSessionSkills({
      cwd: args.cwd,
      agentDir: resolvePiAgentDir({
        homeDir: sessionEnv.HOME?.trim() || homedir(),
        env: sessionEnv,
      }),
      env: sessionEnv,
      launchEnv: process.env,
      extraSkillPaths: args.injectedSkillPaths,
    });
    return {
      noSkills: true,
      skillPaths: selectPiSessionSkillPaths(skills, args.selection),
    };
  } catch (error) {
    throw new Error(
      "sandy could not list Pi skills, so the skill selection cannot be applied without dropping skills you left on; the session was not started: " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}
