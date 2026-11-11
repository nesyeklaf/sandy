import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  SANDY_SKILL_SOURCE_IDS,
  sandySkillSourceIdSchema,
  PERSONAL_PROJECT_ID,
  setSkillNamesEnabled,
  SKILL_SELECTION_GAP_LABELS,
  skillSelectionSchema,
  type SandySkillSourceId,
  type SkillSelection,
} from "@sandy/domain";
import type {
  SkillSelectionUpdateResult,
  SkillSelectionView,
} from "@sandy/server-contract";
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
  path: string;
  revision?: string;
  new?: boolean;
}

interface SkillCreateOptions extends SkillWorkspaceOptions {
  file: string;
  shared?: boolean;
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

const SKILL_SELECTION_ACTIONS = [
  "inherit",
  "disable",
  "allow-only",
  "on",
  "off",
] as const;

function nextSkillSelection(
  current: SkillSelection,
  actionName: string,
  names: readonly string[],
): SkillSelection {
  switch (actionName) {
    case "inherit":
      if (names.length > 0) {
        throw new Error("inherit takes no skill names.");
      }
      return { mode: "inherit" };
    case "disable":
    case "allow-only": {
      const parsed = skillSelectionSchema.safeParse({
        mode: actionName,
        names: [...new Set(names)],
      });
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid names.");
      }
      return parsed.data;
    }
    case "on":
    case "off":
      if (names.length === 0) {
        throw new Error(`${actionName} needs at least one skill name.`);
      }
      return setSkillNamesEnabled(current, names, actionName === "on");
    default:
      throw new Error(
        `Unknown action '${actionName}'. Expected one of: ${SKILL_SELECTION_ACTIONS.join(", ")}.`,
      );
  }
}

function describeSkillSelection(selection: SkillSelection): string {
  switch (selection.mode) {
    case "inherit":
      return "inherit: every skill the agent finds stays on";
    case "disable":
      return `disable: ${selection.names.length > 0 ? selection.names.join(", ") : "(no names)"} off, every other skill on`;
    case "allow-only":
      return `allow-only: only ${selection.names.length > 0 ? selection.names.join(", ") : "(no names)"} on, every other skill off`;
  }
}

function printSkillSelection(
  view: SkillSelectionView | SkillSelectionUpdateResult,
): void {
  console.log(`Selection  ${describeSkillSelection(view.selection)}`);
  console.log(
    renderBorderlessTable(
      {
        head: ["PROVIDER", "SESSION", "SUBAGENTS"],
        colWidths: [28, 14, 14],
        trimTrailingWhitespace: true,
      },
      view.providers.map((provider) => [
        provider.displayName,
        provider.support.session,
        provider.support.subagents,
      ]),
    ),
  );
  const gapLines = view.providers
    .filter((provider) => provider.support.gaps.length > 0)
    .map(
      (provider) =>
        `  ${provider.displayName}: ${provider.support.gaps.map((gap) => SKILL_SELECTION_GAP_LABELS[gap]).join("; ")}`,
    );
  if (gapLines.length > 0) {
    console.log("\nNot filtered by the selection:");
    for (const line of gapLines) console.log(line);
  }
  if (!("pendingThreadIds" in view) || view.pendingThreadIds.length === 0) {
    return;
  }
  console.log(
    `\n${view.pendingThreadIds.length} running thread(s) keep the previous selection until stopped; idle threads that are still loaded keep it too:`,
  );
  for (const threadId of view.pendingThreadIds) console.log(`  ${threadId}`);
  console.log("Run 'sandy thread stop <thread>' to apply it on its next message.");
}

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
              entry.writable ? "yes" : "no",
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
          console.error(`Path: ${result.filePath}`);
          console.error(`Revision: ${result.revision}`);
          if (!result.writable) console.error("Read-only");
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
    .description(
      "Replace a writable skill's SKILL.md, or with --path another file in its folder, from a local file; with --new create that file instead; symlinked skills are written at their real path",
    )
    .requiredOption("--file <path>", "Local file to upload")
    .option("--path <path>", "Skill-relative file path", "SKILL.md")
    .option(
      "--revision <sha256>",
      "Revision returned by sandy skill show --json",
    )
    .option(
      "--new",
      "Create the file at --path; fails if it already exists",
    )
    .action(
      action(async (skillId: string, options: SkillUpdateOptions) => {
        if ((options.revision === undefined) === (options.new !== true)) {
          throw new Error("Pass either --revision <sha256> or --new.");
        }
        const revision = options.revision ?? null;
        const written = await createCliSandySdk(
          getUrl(),
        ).skills.experimental_write({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
          path: options.path,
          content: await readFile(options.file, "utf8"),
          revision,
        });
        if (written.outcome === "conflict" && revision === null) {
          throw new Error(
            `${options.path} already exists. Run sandy skill show ${skillId} --path ${options.path} --json and update it with --revision.`,
          );
        }
        if (written.outcome === "conflict") {
          throw new Error(
            `Skill changed since revision ${revision}${written.currentRevision === null ? "" : ` (now ${written.currentRevision})`}. Run sandy skill show ${skillId} --path ${options.path} --json, merge, and retry.`,
          );
        }
        const result = { filePath: written.filePath, revision: written.revision };
        if (outputJson(options, result)) return;
        console.log(`Updated ${result.filePath}`);
      }),
    );

  addWorkspaceOptions(skill.command("create <name>"))
    .description(
      "Create a new skill folder with a SKILL.md from a local file, in the workspace's .sandy/skills or with --shared in the shared user root (~/.agents/skills)",
    )
    .requiredOption("--file <path>", "Local SKILL.md to upload")
    .option("--shared", "Create the skill in the shared user skill root")
    .action(
      action(async (name: string, options: SkillCreateOptions) => {
        const written = await createCliSandySdk(
          getUrl(),
        ).skills.experimental_create({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          scope: options.shared === true ? "shared-user" : "sandy-project",
          name,
          content: await readFile(options.file, "utf8"),
        });
        if (written.outcome === "conflict") {
          throw new Error(
            `A skill named ${name} already exists there. Pick another name or edit it with sandy skill update.`,
          );
        }
        const result = { filePath: written.filePath, revision: written.revision };
        if (outputJson(options, result)) return;
        console.log(`Created ${result.filePath}`);
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
    .command("selection [action] [names...]")
    .description(
      "Show or change which skills, by name, agents in sandy sessions load (inherit, disable <names...>, allow-only <names...>, on <names...>, off <names...>)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          actionName: string | undefined,
          names: string[],
          options: JsonOutputOptions,
        ) => {
          const sdk = createCliSandySdk(getUrl());
          const current = await sdk.skills.experimental_getSelection();
          if (actionName === undefined) {
            if (outputJson(options, current)) return;
            printSkillSelection(current);
            return;
          }
          const result = await sdk.skills.experimental_setSelection(
            nextSkillSelection(current.selection, actionName, names),
          );
          if (outputJson(options, result)) return;
          printSkillSelection(result);
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
