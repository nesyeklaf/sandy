import test from "node:test";
import assert from "node:assert/strict";
import { getAgent, listAgents, putAgent, validateAgentEntry } from "../server/catalog.ts";
import { importAgentFiles, parseAgentFile } from "../server/agent-import.ts";
import { openDb } from "./db-fixture.ts";

const agentFile = (frontmatter: Record<string, string>, body = "You are `x`. Use contact_supervisor with reason need_decision. Then contact_supervisor again."): string =>
  `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}\n`;

const base = { name: "impl-a", description: "An implementer", model: "anthropic/claude-sonnet-5-5:high", tools: "read, grep, find, ls, bash, edit, write, contact_supervisor, codemode, notebook, history_search, history_read" };

const parsed = (frontmatter: Record<string, string>, body?: string) => {
  const result = parseAgentFile("impl-a.md", agentFile(frontmatter, body));
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.entry;
};
const rejection = (frontmatter: Record<string, string>, pattern: RegExp, fileName = "impl-a.md") => {
  const result = parseAgentFile(fileName, agentFile(frontmatter));
  assert.ok(!result.ok, "expected a rejection");
  assert.match(result.reason, pattern);
};

test("parseAgentFile: name, description, body; model:level split; transport and protocol tools dropped; contact_supervisor renamed in the body", () => {
  const entry = parsed(base);
  assert.equal(entry.name, "impl-a");
  assert.equal(entry.description, "An implementer");
  assert.equal(entry.model, "anthropic/claude-sonnet-5-5");
  assert.equal(entry.thinking, "high");
  assert.deepEqual(entry.tools, ["bash", "edit", "find", "grep", "history_read", "history_search", "ls", "notebook", "read", "write"]);
  assert.equal(entry.role, "writer");
  assert.equal(entry.body, "You are `x`. Use sandy_ask_parent with reason need_decision. Then sandy_ask_parent again.");
  assert.doesNotMatch(entry.body, /contact_supervisor/);
});

test("parseAgentFile: thinking from the frontmatter wins over the model suffix; medium when neither; a colon that is no level stays in the model", () => {
  assert.equal(parsed({ ...base, thinking: "low" }).thinking, "low");
  assert.equal(parsed({ ...base, model: "anthropic/claude-sonnet-5-5" }).thinking, "medium");
  assert.equal(parsed({ ...base, model: "anthropic/claude-sonnet-5-5:high" }).model, "anthropic/claude-sonnet-5-5");
  const free = parsed({ ...base, model: "openrouter/some-model:free" });
  assert.deepEqual([free.model, free.thinking], ["openrouter/some-model:free", "medium"]);
});

test("parseAgentFile: any of bash/write/edit makes a writer, otherwise a reader", () => {
  assert.equal(parsed({ ...base, tools: "read, write" }).role, "writer");
  assert.equal(parsed({ ...base, tools: "read, edit" }).role, "writer");
  assert.equal(parsed({ ...base, tools: "read, grep, contact_supervisor" }).role, "reader");
});

test("parseAgentFile: a subagent or delegation tool rejects the agent with the tool named", () => {
  for (const tool of ["subagent", "subagent_wait", "bash_subagent", "sandy_delegate"]) {
    rejection({ ...base, tools: `read, ${tool}` }, new RegExp(`delegation tool "${tool}"`));
  }
});

test("parseAgentFile: rejections name the reason", () => {
  rejection({ ...base, tools: "" }, /no tools/);
  rejection({ ...base, tools: "codemode, contact_supervisor" }, /no tools left/);
  const { tools: _tools, ...noTools } = base;
  rejection(noTools, /no tools/);
  const { description: _description, ...noDescription } = base;
  rejection(noDescription, /description/);
  const { model: _model, ...noModel } = base;
  rejection(noModel, /model/);
  rejection({ ...base, name: "Bad Name" }, /name must match/);
  rejection({ ...base, thinking: "max" }, /thinking must be one of/);
  rejection({ ...base, acceptanceRole: "read-only" }, /acceptanceRole read-only.*writer/);
  rejection({ ...base, tools: "read, grep", acceptanceRole: "writer" }, /acceptanceRole writer.*reader/);
  rejection({ ...base, tools: "read, mcp__x__bash" }, /reader role may not have mcp__x__bash/);
  assert.ok(!parseAgentFile("empty.md", "no frontmatter here").ok);
  assert.ok(!parseAgentFile("empty.md", "---\nname: a\ndescription: d\n").ok, "unterminated frontmatter");
  assert.ok(!parseAgentFile("nobody.md", agentFile(base, "  ")).ok, "empty body");
});

test("parseAgentFile: acceptanceRole that agrees is accepted; the name falls back to the file name; quotes and unknown keys are tolerated", () => {
  assert.equal(parsed({ ...base, acceptanceRole: "writer" }).role, "writer");
  assert.equal(parsed({ ...base, tools: "read, grep", acceptanceRole: "read-only" }).role, "reader");
  const { name: _name, ...noName } = base;
  const result = parseAgentFile("from-file.md", agentFile({ ...noName, description: '"Quoted: description"', defaultReads: "context.md, plan.md", systemPromptMode: "replace" }));
  assert.ok(result.ok);
  assert.deepEqual([result.entry.name, result.entry.description], ["from-file", "Quoted: description"]);
});

test("importAgentFiles: imported at version 1, unchanged on a rerun, updated at version + 1 when the content changes", () => {
  const db = openDb();
  const files = [{ file: "impl-a.md", text: agentFile(base) }];
  assert.deepEqual(importAgentFiles(db, files), [{ file: "impl-a.md", name: "impl-a", outcome: "imported", version: 1 }]);
  assert.equal(getAgent(db, "impl-a")!.version, 1);
  assert.deepEqual(importAgentFiles(db, files), [{ file: "impl-a.md", name: "impl-a", outcome: "unchanged", version: 1 }]);
  const changed = [{ file: "impl-a.md", text: agentFile({ ...base, description: "A better implementer" }) }];
  assert.deepEqual(importAgentFiles(db, changed), [{ file: "impl-a.md", name: "impl-a", outcome: "updated", version: 2 }]);
  assert.equal(getAgent(db, "impl-a")!.description, "A better implementer");
  assert.deepEqual(importAgentFiles(db, changed)[0].outcome, "unchanged");
});

test("importAgentFiles: a changed import goes past a higher stored version (a set bumped it); equal content is unchanged whatever the version", () => {
  const db = openDb();
  importAgentFiles(db, [{ file: "impl-a.md", text: agentFile(base) }]);
  putAgent(db, { ...getAgent(db, "impl-a")!, version: 5, models: ["anthropic/claude-opus-5-5"] });
  const lines = importAgentFiles(db, [{ file: "impl-a.md", text: agentFile(base) }]);
  assert.deepEqual(lines.map((line) => [line.outcome, line.version]), [["updated", 6]], "the stored models differ from the file's content");
  putAgent(db, { ...getAgent(db, "impl-a")!, version: 9 });
  assert.deepEqual(importAgentFiles(db, [{ file: "impl-a.md", text: agentFile(base) }]).map((line) => [line.outcome, line.version]), [["unchanged", 9]]);
});

test("importAgentFiles: a rejected agent is reported with its reason and writes nothing", () => {
  const db = openDb();
  const before = listAgents(db).length;
  const lines = importAgentFiles(db, [{ file: "bad.md", text: agentFile({ ...base, name: "bad", tools: "read, subagent" }) }]);
  assert.equal(lines[0].outcome, "rejected");
  assert.equal(lines[0].name, "bad");
  assert.equal(lines[0].version, null);
  assert.match(lines[0].reason!, /delegation tool "subagent"/);
  assert.equal(listAgents(db).length, before);
});

test("importAgentFiles: dry run reports the same outcomes and writes nothing; a duplicate name is rejected", () => {
  const db = openDb();
  const files = [
    { file: "a.md", text: agentFile({ ...base, name: "impl-a" }) },
    { file: "b.md", text: agentFile({ ...base, name: "impl-b" }) },
    { file: "c.md", text: agentFile({ ...base, name: "impl-a", description: "again" }) },
  ];
  const dry = importAgentFiles(db, files, { dryRun: true });
  assert.deepEqual(dry.map((line) => [line.file, line.outcome]), [["a.md", "imported"], ["b.md", "imported"], ["c.md", "rejected"]]);
  assert.match(dry[2].reason!, /already imported from a\.md/);
  assert.equal(getAgent(db, "impl-a"), null);
  const real = importAgentFiles(db, files);
  assert.deepEqual(real.map((line) => line.outcome), dry.map((line) => line.outcome));
  assert.equal(getAgent(db, "impl-b")!.version, 1);
});

test("importAgentFiles: every imported entry is a valid catalog entry", () => {
  const db = openDb();
  importAgentFiles(db, [{ file: "impl-a.md", text: agentFile(base) }]);
  const entry = getAgent(db, "impl-a")!;
  assert.deepEqual(validateAgentEntry(entry), entry);
});
