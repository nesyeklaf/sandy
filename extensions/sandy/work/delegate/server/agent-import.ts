// Import of pi-subagents agent files (~/.pi/agent/agents/*.md: YAML frontmatter + body) into the catalog.
// Pure over a Db and file texts; the CLI reads the directory (agents-cli.ts).
import type Database from "better-sqlite3";
import {
  getAgent, isDelegationTool, PROTOCOL_TOOLS, putAgent, snapshotHash, THINKING_LEVELS, validateAgentEntry, WRITE_TOOLS,
  type AgentEntry, type AgentRole, type ThinkingLevel,
} from "./catalog.ts";
import { TRANSPORT_TOOLS } from "../shared/policy.ts";

type Db = Database.Database;

// The catalog entry an agent file describes, without a version (the import assigns it).
export type ImportedAgent = Omit<AgentEntry, "version">;

export type ParseResult = { ok: true; entry: ImportedAgent } | { ok: false; name: string | null; reason: string };

// The pi-subagents tool name that a sandy child replaces with sandy_ask_parent.
const SUPERVISOR_TOOL = "contact_supervisor";

// Tools not carried into the allowlist: the transport tools and delegate protocol tools buildPolicy
// adds itself, and contact_supervisor (its replacement sandy_ask_parent is a protocol tool). notebook,
// history_search and history_read are kept: they only read or write the child's own session memory,
// and a long-running implementer needs them after its context is cut.
export const IMPORT_DROPPED_TOOLS: readonly string[] = [...TRANSPORT_TOOLS, ...PROTOCOL_TOOLS, SUPERVISOR_TOOL];

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not a JSON string: fall through to the plain strip
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
};

type Frontmatter = { fields: Map<string, string>; blockKeys: Set<string>; body: string };

// Flat `key: value` frontmatter only. Indented lines, list items and comments are skipped; a block
// scalar (`key: |`) is recorded so a used key can be rejected instead of misread.
function splitFrontmatter(text: string): Frontmatter | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  const fields = new Map<string, string>();
  const blockKeys = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (/^[|>][+-]?$/.test(match[2].trim())) blockKeys.add(match[1]);
    fields.set(match[1], unquote(match[2]));
  }
  return { fields, blockKeys, body: lines.slice(end + 1).join("\n").trim() };
}

const commaList = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");

const THINKING_SUFFIX = new Set<string>(THINKING_LEVELS);

// Maps one agent file to a catalog entry or a rejection with its reason.
export function parseAgentFile(fileName: string, text: string): ParseResult {
  const fallbackName = fileName.replace(/\.md$/, "");
  const parts = splitFrontmatter(text);
  if (parts === null) return { ok: false, name: fallbackName, reason: "no YAML frontmatter (--- ... ---)" };
  const { fields, blockKeys } = parts;
  const name = fields.get("name") || fallbackName;
  const reject = (reason: string): ParseResult => ({ ok: false, name, reason });
  const blocked = ["name", "description", "model", "thinking", "tools", "models"].filter((key) => blockKeys.has(key));
  if (blocked.length > 0) return reject(`unsupported YAML block value for ${blocked.join(", ")}`);

  const toolsField = fields.get("tools");
  if (toolsField === undefined || commaList(toolsField).length === 0) return reject("no tools listed (the allowlist is enforced, so an agent needs one)");
  const listed = commaList(toolsField);
  const delegating = listed.filter(isDelegationTool);
  if (delegating.length > 0) return reject(`delegation tool ${delegating.map((tool) => `"${tool}"`).join(", ")} in tools: a delegate cannot delegate`);
  const tools = listed.filter((tool) => !IMPORT_DROPPED_TOOLS.includes(tool));
  if (tools.length === 0) return reject("no tools left after dropping " + IMPORT_DROPPED_TOOLS.join(", "));
  const role: AgentRole = tools.some((tool) => WRITE_TOOLS.includes(tool)) ? "writer" : "reader";

  const acceptanceRole = fields.get("acceptanceRole");
  if (acceptanceRole === "writer" && role === "reader") return reject("acceptanceRole writer, but the tools give no bash, write or edit (reader)");
  if (acceptanceRole === "read-only" && role === "writer") return reject(`acceptanceRole read-only, but the tools include ${tools.filter((tool) => WRITE_TOOLS.includes(tool)).join(", ")} (writer)`);

  let model = fields.get("model") ?? "";
  let suffixThinking: string | undefined;
  const colon = model.lastIndexOf(":");
  if (colon > 0 && THINKING_SUFFIX.has(model.slice(colon + 1))) {
    suffixThinking = model.slice(colon + 1);
    model = model.slice(0, colon);
  }
  const thinking = fields.get("thinking") ?? suffixThinking ?? "medium";

  const candidate: Record<string, unknown> = {
    name,
    version: 1,
    description: fields.get("description") ?? "",
    body: parts.body.replaceAll(SUPERVISOR_TOOL, "sandy_ask_parent"),
    model,
    thinking: thinking as ThinkingLevel,
    tools,
    role,
  };
  const modelsField = fields.get("models");
  if (modelsField !== undefined && commaList(modelsField).length > 0) candidate.models = commaList(modelsField);
  try {
    const { version: _version, ...entry } = validateAgentEntry(candidate);
    return { ok: true, entry };
  } catch (error) {
    return reject((error instanceof Error ? error.message : String(error)).replace(/^invalid agent entry "[^"]*": /, ""));
  }
}

export type ImportOutcome = "imported" | "updated" | "unchanged" | "rejected";
export type ImportLine = { file: string; name: string | null; outcome: ImportOutcome; version: number | null; reason?: string };

// One report line per file, in file order. imported: new name, version 1. updated: other content than
// the stored entry, stored version + 1 (so it also goes past a version a `set` bumped). unchanged: same
// content as the stored entry, version as stored. dryRun reports the same and writes nothing.
export function importAgentFiles(db: Db, files: { file: string; text: string }[], options: { dryRun?: boolean; now?: number } = {}): ImportLine[] {
  const seen = new Map<string, string>();
  return files.map(({ file, text }): ImportLine => {
    const parsed = parseAgentFile(file, text);
    if (!parsed.ok) return { file, name: parsed.name, outcome: "rejected", version: null, reason: parsed.reason };
    const { entry } = parsed;
    const earlier = seen.get(entry.name);
    if (earlier !== undefined) return { file, name: entry.name, outcome: "rejected", version: null, reason: `name "${entry.name}" already imported from ${earlier}` };
    seen.set(entry.name, file);
    const current = getAgent(db, entry.name);
    if (current === null) {
      if (!options.dryRun) putAgent(db, { ...entry, version: 1 }, options.now);
      return { file, name: entry.name, outcome: "imported", version: 1 };
    }
    if (snapshotHash(validateAgentEntry({ ...entry, version: current.version })) === snapshotHash(current)) {
      return { file, name: entry.name, outcome: "unchanged", version: current.version };
    }
    if (!options.dryRun) putAgent(db, { ...entry, version: current.version + 1 }, options.now);
    return { file, name: entry.name, outcome: "updated", version: current.version + 1 };
  });
}
