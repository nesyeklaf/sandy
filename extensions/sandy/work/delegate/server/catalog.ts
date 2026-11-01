// The plugin-owned agent catalog: validated entries, immutable launch snapshots, and the Policy a
// delegation runs under. The catalog is the authority on agents; `sandy work delegate agents import` reads ~/.pi/agent/agents.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { TRANSPORT_TOOLS, type Policy } from "../shared/policy.ts";

type Db = Database.Database;

export type AgentRole = "reader" | "writer";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// One catalog entry. tools is the allowlist the gate enforces; transport (codemode) and the delegate
// protocol tools are added by buildPolicy and may not be listed. models lists the model overrides a
// launch may ask for besides model.
export type AgentEntry = {
  name: string;
  version: number;
  description: string;
  body: string;
  model: string;
  thinking: ThinkingLevel;
  models?: string[];
  tools: string[];
  role: AgentRole;
};

export type AgentSnapshot = { snapshotHash: string; entry: AgentEntry };

// Tools that write: a reader role may list none of them, a writer role needs at least one.
export const WRITE_TOOLS: readonly string[] = ["bash", "write", "edit"];
// Added to every policy by buildPolicy.
export const PROTOCOL_TOOLS: readonly string[] = ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"];
// Also added to every policy: tools that only touch the child's own session: its task list (pi/work/tasks,
// its one tool tasks, or with WORK_TASKS=four Claude Code's four), which every agent keeps and the owner sees in SANDY.
export const SESSION_TOOLS: readonly string[] = ["tasks", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];

// Delegation tools would give a child a second way to spawn (depth 1): pi-subagents' tools
// (subagent, subagent_wait, subagents_enable, bash_subagent, ...) and our own sandy_delegate* tools.
export const isDelegationTool = (name: string): boolean => name.includes("subagent") || name.startsWith("sandy_delegate");

const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// Validates an untrusted value into a normalised AgentEntry (tools and models deduplicated and sorted,
// so equal content has one snapshot hash); throws an Error naming every problem.
export function validateAgentEntry(value: unknown): AgentEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("agent entry must be an object");
  const raw = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set(["name", "version", "description", "body", "model", "thinking", "models", "tools", "role"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) problems.push(`unknown field "${key}"`);
  if (!isNonEmptyString(raw.name) || !AGENT_NAME.test(raw.name)) problems.push("name must match " + AGENT_NAME.source);
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) problems.push("version must be a positive integer");
  if (!isNonEmptyString(raw.description)) problems.push("description must be a non-empty string");
  if (!isNonEmptyString(raw.body)) problems.push("body must be a non-empty string");
  if (!isNonEmptyString(raw.model)) problems.push("model must be a non-empty string");
  if (!THINKING_LEVELS.includes(raw.thinking as ThinkingLevel)) problems.push(`thinking must be one of ${THINKING_LEVELS.join("|")}`);
  if (raw.role !== "reader" && raw.role !== "writer") problems.push('role must be "reader" or "writer"');
  const stringList = (field: string, list: unknown): string[] | null => {
    if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
      problems.push(`${field} must be an array of non-empty strings`);
      return null;
    }
    return [...new Set(list)].sort();
  };
  const models = raw.models === undefined ? undefined : stringList("models", raw.models);
  const tools = stringList("tools", raw.tools);
  if (tools) {
    if (tools.length === 0) problems.push("tools must not be empty");
    for (const tool of tools) {
      if (TRANSPORT_TOOLS.includes(tool)) problems.push(`tool "${tool}" is a transport, buildPolicy adds it`);
      else if (PROTOCOL_TOOLS.includes(tool)) problems.push(`tool "${tool}" is a delegate protocol tool, buildPolicy adds it`);
      else if (isDelegationTool(tool)) problems.push(`tool "${tool}" delegates, a delegate cannot delegate`);
    }
    const writeTools = tools.filter((tool) => WRITE_TOOLS.includes(tool));
    // A reader may not list an MCP alias of a write tool either (mcp__<server>__bash etc.): the gate
    // matches exact names, so such a tool would be allowed under its full name.
    const writeAliases = tools.filter((tool) => WRITE_TOOLS.some((name) => tool.startsWith("mcp__") && tool.endsWith(`__${name}`)));
    if (raw.role === "reader" && writeAliases.length > 0) problems.push(`reader role may not have ${writeAliases.join(", ")}`);
    if (raw.role === "reader" && writeTools.length > 0) problems.push(`reader role may not have ${writeTools.join(", ")}`);
    if (raw.role === "writer" && writeTools.length === 0) problems.push(`writer role needs one of ${WRITE_TOOLS.join(", ")}`);
  }
  if (problems.length > 0) throw new Error(`invalid agent entry${isNonEmptyString(raw.name) ? ` "${raw.name}"` : ""}: ${problems.join("; ")}`);
  const entry: AgentEntry = {
    name: raw.name as string,
    version: raw.version as number,
    description: raw.description as string,
    body: raw.body as string,
    model: raw.model as string,
    thinking: raw.thinking as ThinkingLevel,
    tools: tools!,
    role: raw.role as AgentRole,
  };
  if (models) entry.models = models;
  return entry;
}

// Canonical JSON with a fixed key order; validateAgentEntry already sorted the lists.
const canonicalEntryJson = (entry: AgentEntry): string =>
  JSON.stringify({
    name: entry.name,
    version: entry.version,
    description: entry.description,
    body: entry.body,
    model: entry.model,
    thinking: entry.thinking,
    models: entry.models ?? null,
    tools: entry.tools,
    role: entry.role,
  });

// sha256 over the canonical JSON of a validated entry.
export function snapshotHash(entry: AgentEntry): string {
  return createHash("sha256").update(canonicalEntryJson(entry)).digest("hex");
}

// Adds an entry or replaces it with a higher version. Re-putting the same version with the same content
// is a no-op; the same version with other content or a lower version throws (a version names one content).
export function putAgent(db: Db, value: unknown, now = Date.now()): AgentEntry {
  const entry = validateAgentEntry(value);
  const hash = snapshotHash(entry);
  db.transaction(() => {
    const current = db.prepare("SELECT version, entry_hash AS entryHash FROM agents WHERE name = ?").get(entry.name) as
      | { version: number; entryHash: string }
      | undefined;
    if (current === undefined) {
      db.prepare("INSERT INTO agents (name, version, entry_json, entry_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entry.name, entry.version, canonicalEntryJson(entry), hash, now, now);
      return;
    }
    if (current.version === entry.version && current.entryHash === hash) return;
    if (entry.version <= current.version) {
      throw new Error(`agent "${entry.name}" is at version ${current.version}; a changed entry needs a higher version`);
    }
    db.prepare("UPDATE agents SET version = ?, entry_json = ?, entry_hash = ?, updated_at = ? WHERE name = ?")
      .run(entry.version, canonicalEntryJson(entry), hash, now, entry.name);
  })();
  return entry;
}

const parseEntryJson = (json: string): AgentEntry => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed.models === null) delete parsed.models;
  return validateAgentEntry(parsed);
};

export function getAgent(db: Db, name: string): AgentEntry | null {
  const row = db.prepare("SELECT entry_json AS entryJson FROM agents WHERE name = ?").get(name) as { entryJson: string } | undefined;
  return row === undefined ? null : parseEntryJson(row.entryJson);
}

export function listAgents(db: Db): AgentEntry[] {
  const rows = db.prepare("SELECT entry_json AS entryJson FROM agents ORDER BY name").all() as { entryJson: string }[];
  return rows.map((row) => parseEntryJson(row.entryJson));
}

// Stores the immutable launch copy of an entry; content-addressed, so equal content shares one row.
export function createSnapshot(db: Db, entry: AgentEntry, now = Date.now()): AgentSnapshot {
  const hash = snapshotHash(entry);
  db.prepare(
    "INSERT OR IGNORE INTO agent_snapshots (snapshot_hash, agent_name, agent_version, entry_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(hash, entry.name, entry.version, canonicalEntryJson(entry), now);
  return { snapshotHash: hash, entry };
}

export function getSnapshot(db: Db, hash: string): AgentSnapshot | null {
  const row = db.prepare("SELECT entry_json AS entryJson FROM agent_snapshots WHERE snapshot_hash = ?").get(hash) as
    | { entryJson: string }
    | undefined;
  return row === undefined ? null : { snapshotHash: hash, entry: parseEntryJson(row.entryJson) };
}

export function buildPolicy(snapshot: AgentSnapshot, delegationId: string): Policy {
  return {
    delegationId,
    snapshotHash: snapshot.snapshotHash,
    allowTools: [...new Set([...snapshot.entry.tools, ...PROTOCOL_TOOLS, ...SESSION_TOOLS])],
    transportTools: [...TRANSPORT_TOOLS],
  };
}

// The catalog's own entries. The implementer agents are not here: they come from `sandy work delegate agents import`.
// A version here replaces a stored entry of that name only when it is higher; scout is at 2 because
// an earlier fixture entry of that name was version 1.
export const BUILTIN_AGENTS: AgentEntry[] = [
  {
    name: "scout",
    version: 2,
    description: "Fast read-only recon: finds the files, entry points and facts a task needs and reports them with paths and line numbers.",
    body: [
      "You are `scout`: a read-only reconnaissance subagent.",
      "Find the files, symbols and facts the brief asks for and report them with paths and line numbers; say what you could not find.",
      "You cannot change files or run commands. If you need a decision, call `sandy_ask_parent` instead of guessing.",
    ].join("\n"),
    model: "anthropic/claude-haiku-5-5",
    thinking: "medium",
    tools: ["find", "grep", "ls", "read"],
    role: "reader",
  },
  {
    name: "researcher",
    version: 1,
    description: "Read-only research with sources: checks the code and the web, and reports findings with links and file paths.",
    body: [
      "You are `researcher`: a read-only research subagent.",
      "Answer the brief from the repository and from the web (`web_search`). Report findings with sources: URLs for web facts, file:line for code; separate what the sources say from your inference.",
      "You cannot change files or run commands. If you need a decision, call `sandy_ask_parent` instead of guessing.",
    ].join("\n"),
    model: "anthropic/claude-sonnet-5-5",
    thinking: "medium",
    tools: ["find", "grep", "ls", "read", "web_search"],
    role: "reader",
  },
  {
    name: "oracle",
    version: 2,
    description: "Read-only second opinion before acting: challenges assumptions and recommends the safest next move.",
    body: [
      "You are `oracle`: a read-only advisory subagent.",
      "Read the code and the brief, challenge the assumptions, name the risks and recommend the safest next move with reasons. You may use `web_search` for facts you need.",
      "You do not edit files or run commands and you do not make the decision: present options and a recommendation. If you need a decision to continue, call `sandy_ask_parent`.",
    ].join("\n"),
    model: "anthropic/claude-opus-5-5",
    thinking: "medium",
    models: ["openai-codex/gpt-6.1-sol"],
    tools: ["find", "grep", "ls", "read", "web_search"],
    role: "reader",
  },
  {
    name: "evidence-auditor",
    version: 1,
    description: "Audits a research report: checks each claim against its cited sources and the web and marks it supported, unsupported or contradicted.",
    body: [
      "You are `evidence-auditor`: a read-only audit subagent.",
      "Take the research report the brief names and check every claim against the sources it cites and against the web (`web_search`). Mark each claim supported, unsupported or contradicted, and give the source for the verdict: a URL for web facts, file:line for code.",
      "You do not edit files or run commands. Report the verdict list and a short summary of the claims that need fixing. If you need a decision, call `sandy_ask_parent`.",
    ].join("\n"),
    model: "openai-codex/gpt-6.1-sol",
    thinking: "high",
    models: ["anthropic/claude-opus-5-5"],
    tools: ["find", "grep", "ls", "read", "web_search"],
    role: "reader",
  },
  {
    name: "reviewer",
    version: 1,
    description: "Reviews a diff or a branch: may run tests and linters in its own worktree, never changes files.",
    body: [
      "You are `reviewer`: a review subagent that works in its own worktree on the parent's branch, so you see committed state only.",
      "Review the diff the brief names against the task: correctness, edge cases, tests, simplicity. You may run the tests and linters (`bash`) to check it.",
      "You must not change files: no edit, no write, and no shell command that modifies the tree (no formatters in write mode, no git commit or checkout).",
      "Report findings by severity, each with file:line and the reason; say clearly if you found no blockers. If you need a decision, call `sandy_ask_parent`.",
    ].join("\n"),
    model: "openai-codex/gpt-6.1-sol",
    thinking: "high",
    models: ["anthropic/claude-opus-5-5"],
    tools: ["bash", "find", "grep", "ls", "read"],
    role: "writer",
  },
];

// Adds each builtin whose name is not in the catalog, and replaces a stored entry only with a higher
// version; an equal or higher stored version (an import or a `set`) stays.
export function seedBuiltinAgents(db: Db, now = Date.now()): void {
  for (const entry of BUILTIN_AGENTS) {
    const current = getAgent(db, entry.name);
    if (current === null || current.version < entry.version) putAgent(db, entry, now);
  }
}
