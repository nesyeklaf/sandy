import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_AGENTS, getAgent, listAgents, putAgent, seedBuiltinAgents, validateAgentEntry } from "../server/catalog.ts";
import { exportAgentMarkdown, formatAgentList, formatAgentShow, formatImportReport, setAgentField, unsetAgentField } from "../server/agent-admin.ts";
import { importAgentFiles, parseAgentFile } from "../server/agent-import.ts";
import { openDb } from "./db-fixture.ts";

test("builtins: scout, researcher, oracle and evidence-auditor are readers; reviewer is a writer with bash but no edit or write", () => {
  const db = openDb();
  const byName = (name: string) => getAgent(db, name)!;
  for (const name of ["scout", "researcher", "oracle", "evidence-auditor"]) assert.equal(byName(name).role, "reader", name);
  assert.deepEqual(byName("scout").tools, ["find", "grep", "ls", "read"]);
  assert.deepEqual(byName("researcher").tools, ["find", "grep", "ls", "read", "web_search"]);
  assert.deepEqual(byName("oracle").tools, ["find", "grep", "ls", "read", "web_search"]);
  assert.deepEqual([byName("scout").model, byName("scout").thinking], ["anthropic/claude-haiku-5-5", "medium"]);
  assert.deepEqual([byName("researcher").model, byName("researcher").thinking], ["anthropic/claude-sonnet-5-5", "medium"]);
  assert.deepEqual(byName("evidence-auditor").tools, ["find", "grep", "ls", "read", "web_search"]);
  assert.equal(byName("oracle").version, 2);
  assert.deepEqual([byName("oracle").model, byName("oracle").thinking, byName("oracle").models], ["anthropic/claude-opus-5-5", "medium", ["openai-codex/gpt-6.1-sol"]]);
  for (const name of ["evidence-auditor", "reviewer"]) {
    assert.deepEqual([byName(name).model, byName(name).thinking, byName(name).models], ["openai-codex/gpt-6.1-sol", "high", ["anthropic/claude-opus-5-5"]], name);
  }
  const reviewer = byName("reviewer");
  assert.equal(reviewer.role, "writer");
  assert.deepEqual(reviewer.tools, ["bash", "find", "grep", "ls", "read"]);
  assert.match(reviewer.body, /must not change files/);
  assert.match(reviewer.body, /file:line/);
  for (const entry of BUILTIN_AGENTS) {
    assert.match(entry.body, /sandy_ask_parent/, entry.name);
    assert.deepEqual(validateAgentEntry(entry), entry);
  }
});

test("seedBuiltinAgents: equal version stays, a higher builtin replaces, a higher stored version stays", () => {
  const db = openDb();
  assert.deepEqual(listAgents(db).map((entry) => entry.name), ["evidence-auditor", "implementer-low", "oracle", "researcher", "reviewer", "scout"]);
  putAgent(db, { ...getAgent(db, "oracle")!, version: 3, description: "edited" });
  seedBuiltinAgents(db);
  assert.equal(getAgent(db, "oracle")!.description, "edited");
  const old = openDb();
  old.prepare("DELETE FROM agents WHERE name = 'scout'").run();
  putAgent(old, { name: "scout", version: 1, description: "fixture", body: "old", model: "m/m", thinking: "low", tools: ["read"], role: "reader" });
  seedBuiltinAgents(old);
  assert.equal(getAgent(old, "scout")!.version, 2);
  assert.match(getAgent(old, "scout")!.body, /reconnaissance/);
  const oldOracle = openDb();
  oldOracle.prepare("DELETE FROM agents WHERE name = 'oracle'").run();
  putAgent(oldOracle, { name: "oracle", version: 1, description: "v1", body: "old", model: "openai-codex/gpt-6.1-sol", thinking: "high", models: ["anthropic/claude-opus-5-5"], tools: ["read"], role: "reader" });
  seedBuiltinAgents(oldOracle);
  assert.deepEqual([getAgent(oldOracle, "oracle")!.version, getAgent(oldOracle, "oracle")!.model], [2, "anthropic/claude-opus-5-5"]);
  const newer = openDb();
  putAgent(newer, { ...getAgent(newer, "scout")!, version: 3, body: "mine" });
  seedBuiltinAgents(newer);
  assert.equal(getAgent(newer, "scout")!.body, "mine");
});

test("setAgentField: model, thinking, models and description are validated and bump the version", () => {
  const db = openDb();
  const set = (field: string, value: string) => setAgentField(db, "scout", field, value);
  assert.deepEqual([set("model", "anthropic/claude-sonnet-5-5").changed, getAgent(db, "scout")!.version], [true, 3]);
  assert.equal(getAgent(db, "scout")!.model, "anthropic/claude-sonnet-5-5");
  set("thinking", "high");
  assert.equal(getAgent(db, "scout")!.thinking, "high");
  set("models", "openai-codex/gpt-6.1-sol, anthropic/claude-opus-5-5");
  assert.deepEqual(getAgent(db, "scout")!.models, ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"]);
  set("description", "New words");
  assert.equal(getAgent(db, "scout")!.description, "New words");
  assert.equal(getAgent(db, "scout")!.version, 6);
});

test("setAgentField: a value equal to the stored one changes nothing and keeps the version", () => {
  const db = openDb();
  const result = setAgentField(db, "scout", "thinking", "medium");
  assert.deepEqual([result.changed, result.entry.version, getAgent(db, "scout")!.version], [false, 2, 2]);
});

test("setAgentField: refuses unknown agents, other fields and invalid values", () => {
  const db = openDb();
  assert.throws(() => setAgentField(db, "ghost", "model", "a/b"), /unknown agent "ghost"/);
  for (const field of ["tools", "body", "role", "name", "version"]) assert.throws(() => setAgentField(db, "scout", field, "x"), /field must be one of model, thinking, models, description/);
  assert.throws(() => setAgentField(db, "scout", "thinking", "max"), /thinking must be one of/);
  assert.throws(() => setAgentField(db, "scout", "model", "no-provider"), /provider\/model/);
  assert.throws(() => setAgentField(db, "scout", "models", "a/b, nope"), /provider\/model/);
  assert.throws(() => setAgentField(db, "scout", "models", " , "), /unset models/);
  assert.throws(() => setAgentField(db, "scout", "description", "  "), /description/);
  assert.equal(getAgent(db, "scout")!.version, 2, "nothing was written");
});

test("unsetAgentField: models is removed, thinking goes back to medium, model and description are required", () => {
  const db = openDb();
  assert.equal(unsetAgentField(db, "oracle", "models").changed, true);
  assert.equal(getAgent(db, "oracle")!.models, undefined);
  assert.equal(getAgent(db, "oracle")!.version, 3);
  assert.equal(unsetAgentField(db, "oracle", "models").changed, false, "already unset");
  assert.equal(unsetAgentField(db, "oracle", "thinking").entry.thinking, "medium");
  for (const field of ["model", "description"]) assert.throws(() => unsetAgentField(db, "oracle", field), /required/);
  assert.throws(() => unsetAgentField(db, "oracle", "tools"), /field must be one of/);
});

test("exportAgentMarkdown: pi-subagents file format that parses back to the same entry content", () => {
  const db = openDb();
  for (const entry of listAgents(db)) {
    const markdown = exportAgentMarkdown(entry);
    assert.match(markdown, /^---\nname: /);
    const result = parseAgentFile(`${entry.name}.md`, markdown);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    const { version: _version, ...content } = entry;
    assert.deepEqual(result.entry, content, entry.name);
  }
});

test("exportAgentMarkdown: a description with a colon survives the round trip", () => {
  const entry = validateAgentEntry({ name: "colon", version: 1, description: 'Reads: files "quickly" # fast', body: "Body.", model: "a/b", thinking: "low", tools: ["read"], role: "reader" });
  const result = parseAgentFile("colon.md", exportAgentMarkdown(entry));
  assert.ok(result.ok);
  assert.equal(result.entry.description, entry.description);
});

test("formatters: list table, show, and the import report line per file", () => {
  const db = openDb();
  const table = formatAgentList(listAgents(db));
  assert.match(table, /^NAME\s+VERSION\s+ROLE\s+MODEL\s+THINKING\s+TOOLS/);
  assert.match(table, /reviewer\s+1\s+writer\s+openai-codex\/gpt-6\.1-sol\s+high\s+bash,find,grep,ls,read/);
  const show = formatAgentShow(getAgent(db, "oracle")!);
  assert.match(show, /name: oracle/);
  assert.match(show, /models: openai-codex\/gpt-6.1-sol/);
  assert.match(show, /--- body ---\n.*oracle/s);
  const lines = importAgentFiles(db, [{ file: "x.md", text: "nothing" }]);
  assert.match(formatImportReport(lines, false), /^rejected\s+x\s+-\s+x\.md\s+.*frontmatter/m);
  assert.match(formatImportReport([{ file: "a.md", name: "a", outcome: "imported", version: 1 }], true), /^\(dry run\)\nimported\s+a\s+v1\s+a\.md/m);
  assert.match(formatImportReport([], false), /no agent files/);
});
