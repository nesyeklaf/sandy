// Catalog administration behind `sandy work delegate agents`: set/unset of the few editable fields, export in
// the pi-subagents file format, and the text output of list, show and the import report.
import type Database from "better-sqlite3";
import { getAgent, putAgent, THINKING_LEVELS, type AgentEntry, type ThinkingLevel } from "./catalog.ts";
import type { ImportLine } from "./agent-import.ts";

type Db = Database.Database;

export const EDITABLE_FIELDS = ["model", "thinking", "models", "description"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const MODEL_SHAPE = /^[^\s/]+\/\S+$/;

const editableField = (field: string): EditableField => {
  if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) throw new Error(`field must be one of ${EDITABLE_FIELDS.join(", ")}`);
  return field as EditableField;
};

const requireAgent = (db: Db, name: string): AgentEntry => {
  const entry = getAgent(db, name);
  if (entry === null) throw new Error(`unknown agent "${name}"`);
  return entry;
};

const requireModel = (value: string): string => {
  const model = value.trim();
  if (!MODEL_SHAPE.test(model)) throw new Error(`model "${value}" must look like provider/model`);
  return model;
};

export type EditResult = { entry: AgentEntry; changed: boolean };

// Stores the edited entry at version + 1, or leaves the catalog alone when nothing differs.
function writeEdit(db: Db, current: AgentEntry, edit: Partial<Omit<AgentEntry, "models">> & { models?: string[] | undefined }): EditResult {
  const { models: _models, ...rest } = current;
  const next: Record<string, unknown> = { ...rest, ...edit, version: current.version + 1 };
  const models = "models" in edit ? edit.models : current.models;
  if (models !== undefined) next.models = models;
  const candidate = putAgentUnchecked(db, next, current);
  return candidate;
}

function putAgentUnchecked(db: Db, next: Record<string, unknown>, current: AgentEntry): EditResult {
  const { version: _version, ...nextContent } = next;
  const { version: _currentVersion, ...currentContent } = current;
  const sameContent = JSON.stringify(sorted(nextContent)) === JSON.stringify(sorted(currentContent));
  if (sameContent) return { entry: current, changed: false };
  return { entry: putAgent(db, next), changed: true };
}

const sorted = (value: Record<string, unknown>): [string, unknown][] => Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));

// set <name> <field> <value>; throws an Error naming the problem (unknown agent, field or invalid value).
export function setAgentField(db: Db, name: string, field: string, value: string): EditResult {
  const current = requireAgent(db, name);
  switch (editableField(field)) {
    case "model":
      return writeEdit(db, current, { model: requireModel(value) });
    case "thinking":
      if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error(`thinking must be one of ${THINKING_LEVELS.join("|")}`);
      return writeEdit(db, current, { thinking: value as ThinkingLevel });
    case "models": {
      const models = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
      if (models.length === 0) throw new Error("models needs at least one provider/model; use unset models to remove it");
      return writeEdit(db, current, { models: [...new Set(models.map(requireModel))].sort() });
    }
    case "description":
      if (value.trim() === "") throw new Error("description must be a non-empty string");
      return writeEdit(db, current, { description: value.trim() });
  }
}

// unset <name> <field>: models is removed, thinking goes back to medium; model and description are required.
export function unsetAgentField(db: Db, name: string, field: string): EditResult {
  const current = requireAgent(db, name);
  switch (editableField(field)) {
    case "models":
      return writeEdit(db, current, { models: undefined });
    case "thinking":
      return writeEdit(db, current, { thinking: "medium" });
    default:
      throw new Error(`${field} is required and cannot be unset; use set`);
  }
}

// A YAML scalar: plain when it is safe, else a JSON string (a YAML double-quoted scalar).
const scalar = (value: string): string => (/^[\s\-?]|\s$|[:#"'\[\]{}&*!|>%@`\n]/.test(value) ? JSON.stringify(value) : value);

// The entry as a pi-subagents agent file that parseAgentFile reads back to the same content.
export function exportAgentMarkdown(entry: AgentEntry): string {
  const lines = [
    "---",
    `name: ${entry.name}`,
    `description: ${scalar(entry.description)}`,
    `model: ${entry.model}`,
    `thinking: ${entry.thinking}`,
    `tools: ${entry.tools.join(", ")}`,
  ];
  if (entry.models) lines.push(`models: ${entry.models.join(", ")}`);
  lines.push("---", "", entry.body, "");
  return lines.join("\n");
}

const pad = (rows: string[][]): string => {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ")).join("\n") + "\n";
};

export function formatAgentList(entries: AgentEntry[]): string {
  return pad([["NAME", "VERSION", "ROLE", "MODEL", "THINKING", "TOOLS"], ...entries.map((entry) => [entry.name, String(entry.version), entry.role, entry.model, entry.thinking, entry.tools.join(",")])]);
}

export function formatAgentShow(entry: AgentEntry): string {
  const head = [`name: ${entry.name}`, `version: ${entry.version}`, `role: ${entry.role}`, `model: ${entry.model}`, `thinking: ${entry.thinking}`];
  if (entry.models) head.push(`models: ${entry.models.join(", ")}`);
  head.push(`tools: ${entry.tools.join(", ")}`, `description: ${entry.description}`, "--- body ---", entry.body);
  return head.join("\n") + "\n";
}

export function formatImportReport(lines: ImportLine[], dryRun: boolean): string {
  const prefix = dryRun ? "(dry run)\n" : "";
  if (lines.length === 0) return prefix + "no agent files found\n";
  return prefix + pad(lines.map((line) => [line.outcome, line.name ?? "-", line.version === null ? "-" : `v${line.version}`, line.file, ...(line.reason ? [line.reason] : [""])])).replace(/ +\n/g, "\n");
}
