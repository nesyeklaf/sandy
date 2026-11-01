import test from "node:test";
import assert from "node:assert/strict";
import { policyHash } from "../shared/policy.ts";
import {
  buildPolicy,
  createSnapshot,
  BUILTIN_AGENTS,
  getAgent,
  getSnapshot,
  listAgents,
  putAgent,
  seedBuiltinAgents,
  snapshotHash,
  validateAgentEntry,
  type AgentEntry,
} from "../server/catalog.ts";
import { createHash } from "node:crypto";
import { migrations } from "../server/migrations.ts";
import { dueStopRequests, getStopRequest, markStopFailed } from "../server/ledger.ts";
import { openDb, TEST_WRITER_AGENT } from "./db-fixture.ts";

const reader = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "probe-reader",
  version: 1,
  description: "probe",
  body: "You read.",
  model: "anthropic/claude-haiku-5-5",
  thinking: "low",
  tools: ["read"],
  role: "reader",
  ...overrides,
});

const rejects = (value: Record<string, unknown>, pattern: RegExp) => assert.throws(() => validateAgentEntry(value), pattern);

test("migrations: one append-only statement list creating the plugin tables", () => {
  const db = openDb(":memory:", { migrate: false });
  for (const statement of migrations) db.exec(statement);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  assert.deepEqual(tables, ["agent_snapshots", "agents", "delegation_acks", "delegation_briefs", "delegation_deliveries", "delegation_markers", "delegation_stops", "delegation_turn_cursors", "delegation_wait_marks", "delegations", "pending_inputs", "questions"]);
});

// sha256 of each statement as SANDY records it in _sandy_migrations; a host that applied a statement refuses
// to load the plugin when it changes. These were applied on the slice 4b live host.
const SHIPPED_MIGRATION_HASHES = [
  "f33cdf623f2c4c376de0c393e37881ee85a54452f256949a102f3ef5ed34f0ee",
  "71fa6232dbf8066a2e73291130af03bf0748d9a96db6e62eb607a03d7503fc3f",
  "89d55f5c81f3a6792eaeca50698bf423c90f76fc50c1b2eff907f46dbab7b4f8",
];

test("migrations: the shipped statements are unchanged; a DB with delegation_stops from #3 upgrades with #4 and keeps its stop requests", () => {
  assert.deepEqual(
    migrations.slice(0, SHIPPED_MIGRATION_HASHES.length).map((statement) => createHash("sha256").update(statement).digest("hex")),
    SHIPPED_MIGRATION_HASHES,
  );
  const db = openDb(":memory:", { migrate: false });
  for (const statement of migrations.slice(0, 3)) db.exec(statement);
  db.prepare("INSERT INTO delegations (delegation_id, kind, state, root_thread_id, parent_thread_id, agent, input_hash, created_at, updated_at) VALUES ('d1', 'delegate', 'refused', 'r', 'r', 'scout', 'h', 0, 0)").run();
  db.prepare("INSERT INTO delegation_stops (child_thread_id, delegation_id, reason, requested_at, stopped_at, attempts, last_error) VALUES ('thr_open', 'd1', 'no_ack', 10, NULL, 1, 'sandy refused'), ('thr_done', 'd1', 'no_ack', 5, 6, 1, NULL)").run();
  for (const statement of migrations.slice(3)) db.exec(statement);
  assert.deepEqual(getStopRequest(db, "thr_open"), {
    childThreadId: "thr_open", delegationId: "d1", reason: "no_ack", requestedAt: 10, stoppedAt: null, attempts: 1, lastError: "sandy refused", nextAttemptAt: null,
  });
  assert.deepEqual(dueStopRequests(db, 20).map((request) => request.childThreadId), ["thr_open"], "an open request from before #4 is due at once");
  markStopFailed(db, "thr_open", "again", 120_000, 20);
  assert.deepEqual([getStopRequest(db, "thr_open")?.attempts, getStopRequest(db, "thr_open")?.nextAttemptAt], [2, 20 + 2_000]);
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'delegation_stops' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  assert.deepEqual(indexes, ["delegation_stops_delegation_idx", "delegation_stops_open_idx"]);
});

test("migrations: questions allow one open question per delegation and only the known states", () => {
  const db = openDb();
  db.prepare("INSERT INTO delegations (delegation_id, kind, state, root_thread_id, parent_thread_id, agent, input_hash, created_at, updated_at) VALUES ('d1', 'delegate', 'active', 'r', 'r', 'scout', 'h', 0, 0)").run();
  const ask = db.prepare("INSERT INTO questions (question_id, delegation_id, state, question_json, created_at, expires_at, updated_at) VALUES (?, 'd1', ?, '{}', 0, 1, 0)");
  ask.run("q1", "open");
  assert.throws(() => ask.run("q2", "open"), /UNIQUE/);
  ask.run("q3", "answered");
  assert.throws(() => ask.run("q4", "pending"), /CHECK/);
  assert.throws(() => db.prepare("UPDATE delegations SET state = 'pending' WHERE delegation_id = 'd1'").run(), /CHECK/);
});

test("builtin seed: scout is a reader; the test writer fixture is valid", () => {
  const db = openDb();
  assert.deepEqual(listAgents(db).map((entry) => entry.name), ["evidence-auditor", "implementer-low", "oracle", "researcher", "reviewer", "scout"]);
  const scout = getAgent(db, "scout")!;
  assert.deepEqual([scout.role, scout.tools, scout.model, scout.thinking, scout.version], ["reader", ["find", "grep", "ls", "read"], "anthropic/claude-haiku-5-5", "medium", 2]);
  const implementer = getAgent(db, "implementer-low")!;
  assert.deepEqual(
    [implementer.role, implementer.tools, implementer.model, implementer.thinking],
    ["writer", ["bash", "edit", "find", "grep", "ls", "read", "write"], "anthropic/claude-haiku-5-5", "high"],
  );
  for (const entry of [...BUILTIN_AGENTS, TEST_WRITER_AGENT]) assert.deepEqual(validateAgentEntry(entry), entry);
});

test("builtin seed: idempotent, and an existing entry of the same name and version wins", () => {
  const db = openDb();
  putAgent(db, { ...getAgent(db, "scout")!, version: 3, body: "imported scout" });
  seedBuiltinAgents(db);
  assert.equal(getAgent(db, "scout")!.version, 3);
  assert.equal(listAgents(db).length, 6);
});

test("validate: a reader with bash, write or edit is rejected", () => {
  for (const tool of ["bash", "write", "edit"]) rejects(reader({ tools: ["read", tool] }), new RegExp(`reader role may not have ${tool}`));
  for (const tool of ["mcp__x__bash", "mcp__fs__write", "mcp__a__edit"]) rejects(reader({ tools: ["read", tool] }), new RegExp(`reader role may not have ${tool}`));
});

test("validate: a writer needs a write tool", () => {
  rejects(reader({ role: "writer" }), /writer role needs one of bash, write, edit/);
  assert.equal(validateAgentEntry(reader({ role: "writer", tools: ["read", "edit"] })).role, "writer");
});

test("validate: subagent tools, delegate tools, transports and protocol tools are rejected in allowlists", () => {
  for (const tool of ["subagent", "subagent_wait", "subagents_enable", "bash_subagent", "sandy_delegate", "sandy_delegate_wait"]) {
    rejects(reader({ tools: ["read", tool] }), /a delegate cannot delegate/);
  }
  rejects(reader({ tools: ["read", "codemode"] }), /"codemode" is a transport/);
  rejects(reader({ tools: ["sandy_delegate_brief"] }), /protocol tool/);
  rejects(reader({ tools: ["sandy_ask_parent"] }), /protocol tool/);
  rejects(reader({ tools: ["sandy_question_answer"] }), /protocol tool/);
});

test("validate: shape errors are reported together", () => {
  assert.throws(() => validateAgentEntry(null), /must be an object/);
  rejects(
    reader({ name: "Bad Name", version: 0, thinking: "max", role: "admin", tools: [], extra: 1 }),
    /unknown field "extra".*name must match.*version must be a positive integer.*thinking must be one of.*role must be.*tools must not be empty/,
  );
  rejects(reader({ tools: "read" }), /tools must be an array/);
  rejects(reader({ models: [""] }), /models must be an array of non-empty strings/);
});

test("snapshotHash: independent of list order, changes with content", () => {
  const a = validateAgentEntry(reader({ tools: ["read", "grep"], models: ["b/m", "a/m"] }));
  const b = validateAgentEntry(reader({ tools: ["grep", "read", "grep"], models: ["a/m", "b/m"] }));
  assert.equal(snapshotHash(a), snapshotHash(b));
  assert.notEqual(snapshotHash(a), snapshotHash(validateAgentEntry(reader({ tools: ["read", "grep"], models: ["a/m", "b/m"], body: "other" }))));
});

test("putAgent: a version names one content; snapshots stay immutable across versions", () => {
  const db = openDb();
  const v1 = putAgent(db, reader());
  putAgent(db, reader());
  assert.throws(() => putAgent(db, reader({ body: "changed" })), /needs a higher version/);
  const snapshot = createSnapshot(db, v1);
  assert.deepEqual(createSnapshot(db, v1), snapshot, "content-addressed");
  putAgent(db, reader({ version: 2, tools: ["read", "grep"] }));
  assert.throws(() => putAgent(db, reader()), /needs a higher version/);
  assert.equal(getAgent(db, "probe-reader")!.version, 2);
  assert.deepEqual(getSnapshot(db, snapshot.snapshotHash), { snapshotHash: snapshot.snapshotHash, entry: v1 });
  assert.equal(getSnapshot(db, "missing"), null);
});

test("buildPolicy: entry tools plus the protocol tools and tasks, codemode as transport", () => {
  const db = openDb();
  const snapshot = createSnapshot(db, getAgent(db, "scout") as AgentEntry);
  const policy = buildPolicy(snapshot, "dlg_1");
  assert.deepEqual(policy, {
    delegationId: "dlg_1",
    snapshotHash: snapshot.snapshotHash,
    allowTools: ["find", "grep", "ls", "read", "sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer", "tasks", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
    transportTools: ["codemode"],
  });
  assert.match(policyHash(policy), /^[0-9a-f]{64}$/);
});
