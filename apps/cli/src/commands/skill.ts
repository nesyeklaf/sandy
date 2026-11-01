import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  SANDY_SKILL_SOURCE_IDS,
  sandySkillSourceIdSchema,
  PERSONAL_PROJECT_ID,
  type SandySkillSourceId,
} from "@sandy/domain";
import { action } from "../action.js";
import { createCliSandySdk } from "../client.js";
import { resolveMachineId, selectMachines } from "./machine.js";
import type { ContextSnapshot } from "../context-env.js";
import { renderBorderlessTable } from "../table.js";
import {
  collectOption,
  confirmDestructiveAction,
  outputJson,
  type JsonOutputOptions,
} from "./helpers.js";

interface SkillWorkspaceOptions extends JsonOutputOptions {
  environment?: string;
  project?: string;
}

interface SkillListOptions extends SkillWorkspaceOptions {
  duplicates?: boolean;
}

interface SkillDeleteOptions extends SkillWorkspaceOptions {
  yes?: boolean;
}

interface SkillUpdateOptions extends SkillWorkspaceOptions {
  file: string;
  revision: string;
}

interface SkillInstallCliSkillsOptions extends JsonOutputOptions {
  machine: string[];
}

function projectId(
  options: SkillWorkspaceOptions,
  context: ContextSnapshot,
): string {
  return options.project ?? context.projectId ?? PERSONAL_PROJECT_ID;
}

function environmentId(options: SkillWorkspaceOptions): string | null {
  return options.environment ?? null;
}

function addWorkspaceOptions(command: Command): Command {
  return command
    .option(
      "--project <id>",
      "Project ID (defaults to SANDY_PROJECT_ID or personal)",
    )
    .option("--environment <id>", "Project environment workspace")
    .option("--json", "Print machine-readable JSON output");
}

const SKILL_SOURCE_DESCRIPTIONS: Readonly<Record<SandySkillSourceId, string>> = {
  "sandy-plugins":
    "Skills that installed sandy plugins contribute, including generated plugin command skills",
  "sandy-user":
    "Skills in sandy's data directory skills folder and in SANDY_INHERITED_SKILLS_ROOTS",
  "sandy-project": "Skills in the project's .sandy/skills directory",
  shared: "Skills from the sharedSkillRoots in config.json",
};

function parseSkillSource(value: string): SandySkillSourceId {
  const parsed = sandySkillSourceIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `Unknown skill source '${value}'. Known sources: ${SANDY_SKILL_SOURCE_IDS.join(", ")}.`,
  );
}

export function registerSkillCommands(
  program: Command,
  getUrl: () => string,
  getContext: () => ContextSnapshot,
): void {
  const skill = program
    .command("skill")
    .description("List, inspect, edit, and remove skills");

  addWorkspaceOptions(skill.command("list"))
    .description(
      "List installed and discovered skills, the agents that load each one, and its duplicates",
    )
    .option(
      "--duplicates",
      "Only list skills found more than once (same file, same content, or same name)",
    )
    .action(
      action(async (options: SkillListOptions) => {
        const listed = await createCliSandySdk(getUrl()).skills.list({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
        });
        const result =
          options.duplicates === true
            ? {
                ...listed,
                skills: listed.skills.filter(
                  (entry) => entry.duplicates.length > 0,
                ),
              }
            : listed;
        if (outputJson(options, result)) return;
        console.log(
          renderBorderlessTable(
            {
              head: [
                "ID",
                "NAME",
                "SCOPE",
                "AGENTS",
                "DUPLICATES",
                "EDITABLE",
                "PATH",
              ],
              colWidths: [72, 24, 18, 24, 12, 10, 48],
              trimTrailingWhitespace: true,
            },
            result.skills.map((entry) => [
              entry.id,
              entry.name,
              entry.scope,
              entry.providers.length > 0 ? entry.providers.join(", ") : "all",
              String(entry.duplicates.length),
              entry.manageable ? "yes" : "no",
              entry.filePath,
            ]),
          ),
        );
        if (options.duplicates !== true) return;
        for (const entry of result.skills) {
          console.log(`\n${entry.name}  ${entry.filePath}`);
          for (const duplicate of entry.duplicates) {
            console.log(
              `  ${duplicate.relation.padEnd(12)} ${duplicate.provider ?? "sandy"}  ${duplicate.filePath}`,
            );
          }
        }
      }),
    );

  addWorkspaceOptions(skill.command("show <skill-id>"))
    .description("Print an installed skill file")
    .option("--path <path>", "Skill-relative file path", "SKILL.md")
    .action(
      action(
        async (
          skillId: string,
          options: SkillWorkspaceOptions & { path: string },
        ) => {
          const result = await createCliSandySdk(getUrl()).skills.getContent({
            projectId: projectId(options, getContext()),
            environmentId: environmentId(options),
            skillId,
            path: options.path,
          });
          if (outputJson(options, result)) return;
          console.error(`Revision: ${result.revision}`);
          process.stdout.write(result.content);
        },
      ),
    );

  addWorkspaceOptions(skill.command("files <skill-id>"))
    .description("List files included in an installed skill")
    .action(
      action(async (skillId: string, options: SkillWorkspaceOptions) => {
        const result = await createCliSandySdk(getUrl()).skills.listFiles({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
        });
        if (outputJson(options, result)) return;
        for (const path of result.files) console.log(path);
        if (result.truncated) console.error("File list truncated.");
      }),
    );

  addWorkspaceOptions(skill.command("update <skill-id>"))
    .description("Replace an editable skill's SKILL.md from a local file")
    .requiredOption("--file <path>", "Local SKILL.md to upload")
    .requiredOption(
      "--revision <sha256>",
      "Revision returned by sandy skill show --json",
    )
    .action(
      action(async (skillId: string, options: SkillUpdateOptions) => {
        const result = await createCliSandySdk(getUrl()).skills.update({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
          content: await readFile(options.file, "utf8"),
          revision: options.revision,
        });
        if (outputJson(options, result)) return;
        console.log(`Updated ${result.filePath}`);
      }),
    );

  addWorkspaceOptions(skill.command("delete <skill-id>"))
    .description("Delete an editable user-owned skill")
    .option("--yes", "Skip the confirmation prompt")
    .action(
      action(async (skillId: string, options: SkillDeleteOptions) => {
        if (
          !options.yes &&
          !(await confirmDestructiveAction(
            `Delete ${skillId}? This cannot be undone.`,
          ))
        ) {
          console.log("Aborted.");
          return;
        }
        const result = await createCliSandySdk(getUrl()).skills.remove({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
        });
        if (outputJson(options, result)) return;
        console.log(`Deleted ${result.deletedPath}`);
      }),
    );

  skill
    .command("sources [source] [state]")
    .description(
      `Show or switch which sandy-owned skill sources sandy injects into agents and lists (${SANDY_SKILL_SOURCE_IDS.join(", ")}; state on or off)`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          source: string | undefined,
          state: string | undefined,
          options: JsonOutputOptions,
        ) => {
          const sdk = createCliSandySdk(getUrl());
          const config = await sdk.system.config();
          let disabled = config.generalSettings.disabledSkillSources;
          if (source !== undefined) {
            const sourceId = parseSkillSource(source);
            if (state !== "on" && state !== "off") {
              throw new Error(
                `Expected on or off after '${sourceId}', got '${state ?? ""}'.`,
              );
            }
            disabled = SANDY_SKILL_SOURCE_IDS.filter((id) =>
              id === sourceId ? state === "off" : disabled.includes(id),
            );
            await sdk.system.updateGeneralSettings({
              ...config.generalSettings,
              disabledSkillSources: disabled,
            });
          }
          const result = {
            sources: SANDY_SKILL_SOURCE_IDS.map((id) => ({
              id,
              enabled: !disabled.includes(id),
              description: SKILL_SOURCE_DESCRIPTIONS[id],
            })),
          };
          if (outputJson(options, result)) return;
          console.log(
            renderBorderlessTable(
              {
                head: ["SOURCE", "STATE", "DESCRIPTION"],
                colWidths: [14, 8, 72],
                trimTrailingWhitespace: true,
              },
              result.sources.map((entry) => [
                entry.id,
                entry.enabled ? "on" : "off",
                entry.description,
              ]),
            ),
          );
        },
      ),
    );

  skill
    .command("cli-skills-status")
    .description(
      "Show whether each machine has sandy's built-in CLI skills installed",
    )
    .option(
      "--machine <id-or-name>",
      "Machine to report on (repeatable, defaults to every persistent machine)",
      collectOption,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: SkillInstallCliSkillsOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const hosts = options.machine.length > 0 ? await sdk.hosts.list() : [];
        const hostIds =
          options.machine.length > 0
            ? options.machine.map((target) => resolveMachineId(hosts, target))
            : undefined;
        const result = await sdk.system.cliSkillsStatus(
          hostIds === undefined ? {} : { hostIds },
        );
        if (outputJson(options, result)) return;
        console.log(
          renderBorderlessTable(
            {
              head: ["MACHINE", "STATUS"],
              colWidths: [32, 16],
              trimTrailingWhitespace: true,
            },
            result.machines.map((machine) => [
              machine.hostName,
              machine.status,
            ]),
          ),
        );
      }),
    );

  skill
    .command("install-cli-skills")
    .description(
      "Install sandy's built-in CLI skills into ~/.agents/skills and ~/.claude/skills on a machine",
    )
    .option(
      "--machine <id-or-name>",
      "Machine to install onto (repeatable, defaults to every connected persistent machine)",
      collectOption,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: SkillInstallCliSkillsOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const hosts = await sdk.hosts.list();
        const hostIds =
          options.machine.length > 0
            ? options.machine.map((target) => resolveMachineId(hosts, target))
            : selectMachines(hosts, "persistent")
                .filter((host) => host.status === "connected")
                .map((host) => host.id);
        if (hostIds.length === 0) {
          throw new Error("No connected machine to install the skills onto.");
        }
        const result = await sdk.system.installCliSkills({ hostIds });
        if (outputJson(options, result)) return;
        for (const entry of result.results) {
          if (!entry.ok) {
            console.error(`${entry.hostName}: ${entry.errorMessage}`);
            continue;
          }
          for (const installation of entry.installations) {
            console.log(
              `${entry.hostName}: installed ${installation.name} to ${installation.path}`,
            );
          }
        }
        if (result.results.some((entry) => !entry.ok)) {
          throw new Error("The install failed on at least one machine.");
        }
      }),
    );
}
