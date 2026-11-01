import { getAppSettings } from "@sandy/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { getPluginSkillRootContributions } from "../plugins/plugin-agent-contributions.js";
import { generatedSkillsRootPath } from "../plugins/plugin-commands-skill.js";
import {
  resolveSkillCatalogEntries,
  type ProjectInjectedSkillSource,
  type ResolvedSkillCatalogEntry,
  type SharedInjectedSkillSource,
} from "./injected-skills.js";

interface ResolveSkillCatalogSourcesArgs {
  pluginSkillSelections?: ReadonlyMap<string, ReadonlySet<string>>;
  projectSkillSources?: readonly ProjectInjectedSkillSource[];
  sharedSkillSources?: readonly SharedInjectedSkillSource[];
}

export async function resolveSkillCatalog(
  deps: Pick<
    LoggedWorkSessionDeps,
    "config" | "db" | "logger" | "skillTreeRegistry"
  >,
  args: ResolveSkillCatalogSourcesArgs = {},
): Promise<ResolvedSkillCatalogEntry[]> {
  const disabledSources = new Set(getAppSettings(deps.db).disabledSkillSources);
  return resolveSkillCatalogEntries(deps.logger, {
    additionalSkillsRootPaths: [
      ...(disabledSources.has("sandy-user")
        ? []
        : deps.config.inheritedSkillsRootPaths),
      ...(disabledSources.has("sandy-plugins")
        ? []
        : [generatedSkillsRootPath(deps.config.dataDir)]),
    ],
    dataDir: deps.config.dataDir,
    disabledSources,
    pluginSkillRoots: getPluginSkillRootContributions(),
    ...(args.pluginSkillSelections !== undefined
      ? { pluginSkillSelections: args.pluginSkillSelections }
      : {}),
    ...(args.projectSkillSources !== undefined
      ? { projectSkillSources: args.projectSkillSources }
      : {}),
    ...(args.sharedSkillSources !== undefined
      ? { sharedSkillSources: args.sharedSkillSources }
      : {}),
    skillTreeRegistry: deps.skillTreeRegistry,
  });
}
