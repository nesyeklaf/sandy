// `sandy work delegate agents ...`: thin commands over the catalog functions (catalog.ts, agent-import.ts,
// agent-admin.ts). The plugin is the catalog's authority; import reads pi-subagents agent files.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliCommand, PluginCliError } from "@sandy-sdk/plugin-sdk";
import type Database from "better-sqlite3";
import { exportAgentMarkdown, formatAgentList, formatAgentShow, formatImportReport, setAgentField, unsetAgentField, type EditResult } from "./agent-admin.ts";
import { importAgentFiles } from "./agent-import.ts";
import { getAgent, listAgents, type AgentEntry } from "./catalog.ts";

type Db = Database.Database;

export const DEFAULT_AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const readAgentDir = (dir: string): { file: string; text: string }[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new PluginCliError(`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`, { code: "agents_dir_unreadable" });
  }
  return names
    .filter((name) => name.endsWith(".md") && !name.endsWith(".chain.md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
};

const requireAgent = (db: Db, name: string): AgentEntry => {
  const entry = getAgent(db, name);
  if (entry === null) throw new PluginCliError(`unknown agent "${name}"`, { code: "unknown_agent", hint: "sandy work delegate agents list" });
  return entry;
};

const edited = (name: string, field: string, result: EditResult, verb: string): string =>
  result.changed ? `${name}: ${verb} ${field}, now version ${result.entry.version}\n` : `${name}: ${field} already ${verb === "unset" ? "unset" : "that value"}, version ${result.entry.version}\n`;

const failing = (run: () => EditResult): EditResult => {
  try {
    return run();
  } catch (error) {
    throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "invalid_agent_edit" });
  }
};

const nameArg = { name: "name", description: "Agent name", required: true } as const;

export function agentsCommands(db: Db) {
  return {
    "agents import": cliCommand({
      summary: "Import pi-subagents agent files into the catalog: one line per file (imported, updated, unchanged, rejected)",
      options: {
        dir: { type: "string", description: "Directory of agent .md files (default ~/.pi/agent/agents on the SANDY server)" },
        "dry-run": { type: "boolean", description: "Report what would happen and write nothing" },
        json: { type: "boolean", description: "Emit JSON" },
      },
      async run(input) {
        const dryRun = input.options["dry-run"] === true;
        const dir = input.options.dir ?? DEFAULT_AGENTS_DIR;
        const lines = importAgentFiles(db, readAgentDir(dir), { dryRun });
        return { exitCode: 0, stdout: input.options.json ? json({ dir, dryRun, agents: lines }) : formatImportReport(lines, dryRun) };
      },
    }),
    "agents list": cliCommand({
      summary: "List catalog agents",
      options: { json: { type: "boolean", description: "Emit JSON" } },
      async run(input) {
        const entries = listAgents(db);
        return { exitCode: 0, stdout: input.options.json ? json(entries) : formatAgentList(entries) };
      },
    }),
    "agents show": cliCommand({
      summary: "Show one catalog agent with its body",
      positionals: [nameArg],
      options: { json: { type: "boolean", description: "Emit JSON" } },
      async run(input) {
        const entry = requireAgent(db, input.positionals.name);
        return { exitCode: 0, stdout: input.options.json ? json(entry) : formatAgentShow(entry) };
      },
    }),
    "agents export": cliCommand({
      summary: "Print one catalog agent as a pi-subagents agent file (or JSON)",
      positionals: [nameArg],
      options: { json: { type: "boolean", description: "Emit the catalog entry as JSON" } },
      async run(input) {
        const entry = requireAgent(db, input.positionals.name);
        return { exitCode: 0, stdout: input.options.json ? json(entry) : exportAgentMarkdown(entry) };
      },
    }),
    "agents set": cliCommand({
      summary: "Set model, thinking, models (comma list) or description of an agent; bumps its version",
      positionals: [nameArg, { name: "field", description: "model | thinking | models | description", required: true }, { name: "value", description: "New value", required: true }],
      async run(input) {
        const { name, field, value } = input.positionals;
        return { exitCode: 0, stdout: edited(name, field, failing(() => setAgentField(db, name, field, value)), "set") };
      },
    }),
    "agents unset": cliCommand({
      summary: "Unset models (removes it) or thinking (back to medium) of an agent; bumps its version",
      positionals: [nameArg, { name: "field", description: "models | thinking", required: true }],
      async run(input) {
        const { name, field } = input.positionals;
        return { exitCode: 0, stdout: edited(name, field, failing(() => unsetAgentField(db, name, field)), "unset") };
      },
    }),
  };
}
