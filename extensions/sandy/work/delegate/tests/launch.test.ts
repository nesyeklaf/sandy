import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { getDelegation, getDelegationByChild, listSlotHolders } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { sandyReasoningLevel, delegate, launchInputHash, type LaunchHost, type SpawnRequest, type TargetProject } from "../server/launch.ts";
import { formatDelegationTable, listDelegations } from "../server/list.ts";
import { delegateToolsFor, issuePolicy } from "../server/protocol.ts";
import { getAgent, getSnapshot, putAgent } from "../server/catalog.ts";

type Db = ReturnType<typeof openDb>;

// A SANDY stand-in: parent thr_parent in env_parent (git checkout on branch "feature"), pi available with
// permission mode "full". Records what the plugin sees in the ledger when it spawns.
function fakeHost(db: Db, overrides: Partial<LaunchHost> & { gitRepo?: boolean; branch?: string | null; parentMode?: string | null } = {}) {
  const spawned: { request: SpawnRequest; rowAtSpawn: ReturnType<typeof getDelegation> }[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const host: LaunchHost = {
    piProvider: async () => ({ available: true, permissionModes: ["full"] }),
    thread: async (threadId) => ({ id: threadId, projectId: "proj_test", environmentId: "env_parent" }),
    rootOf: async (threadId) => threadId,
    permissionModeOf: async () => (overrides.parentMode === undefined ? "full" : overrides.parentMode),
    environment: async () => ({ hostId: "host_test", isGitRepo: overrides.gitRepo ?? true, branchName: overrides.branch === undefined ? "feature" : overrides.branch }),
    project: async (ref) => PROJECTS.find((project) => project.id === ref || project.name === ref) ?? null,
    spawn: async (request) => {
      spawned.push({ request, rowAtSpawn: getDelegation(db, request.pluginMetadata.delegationId) });
      return { id: `thr_child${++next}` };
    },
    spawnsInFlight: new Set(),
    bindDelayMs: async () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
  };
  return { host, spawned, sleeps };
}

// Projects a writer can target: proj_repo has a checkout on the parent's host and on another one.
const PROJECTS: TargetProject[] = [
  { id: "proj_repo", name: "repo", kind: "standard", sourceHostIds: ["host_other", "host_test"], defaultHostId: "host_other" },
  { id: "proj_far", name: "far", kind: "standard", sourceHostIds: ["host_other"], defaultHostId: "host_other" },
  { id: "proj_personal", name: "Personal", kind: "personal", sourceHostIds: [], defaultHostId: null },
];

const call = (agent: string, extra: Record<string, unknown> = {}) => ({ agent, task: "find-the-config-loader", mode: "async" as const, ...extra });

test("sandyReasoningLevel: off -> none, minimal -> low, the rest unchanged", () => {
  assert.deepEqual(
    (["off", "minimal", "low", "medium", "high", "xhigh"] as const).map(sandyReasoningLevel),
    ["none", "low", "low", "medium", "high", "xhigh"],
  );
});

test("delegate: a reader is reserved before the spawn and spawned hidden on pi in the parent's environment", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db);
  const result = await delegate(db, host, "thr_parent", call("scout", { title: "[delegate-test] scout" }), DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.equal(spawned.length, 1);
  const [{ request, rowAtSpawn }] = spawned;
  assert.equal(rowAtSpawn?.state, "reserved");
  assert.equal(rowAtSpawn?.childThreadId, null);
  assert.deepEqual(request.environment, { type: "reuse", environmentId: "env_parent" });
  assert.equal(request.visibility, "hidden");
  assert.equal(request.providerId, "pi");
  assert.equal(request.parentThreadId, "thr_parent");
  assert.equal(request.permissionMode, "full");
  assert.equal(request.model, "anthropic/claude-haiku-5-5");
  assert.equal(request.reasoningLevel, "medium");
  assert.equal(request.title, "[delegate-test] scout");
  assert.deepEqual(request.pluginMetadata, { delegationId: result.launched.delegationId });
  assert.match(request.prompt, /sandy_delegate_brief/);
  assert.doesNotMatch(request.prompt, /find-the-config-loader/, "the task is not in the prompt; it comes with the brief");
  assert.deepEqual(
    { state: result.launched.status, child: result.launched.threadId, version: result.launched.agentVersion, workspace: result.launched.workspace, reasoningLevel: result.launched.reasoningLevel },
    { state: "starting", child: "thr_child1", version: 2, workspace: "parent", reasoningLevel: "medium" },
  );
  const brief = db.prepare("SELECT task FROM delegation_briefs WHERE delegation_id = ?").get(result.launched.delegationId) as { task: string };
  assert.equal(brief.task, "find-the-config-loader");
});

test("delegate: a writer gets a managed worktree on the parent's branch, on the parent's host", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db);
  const result = await delegate(db, host, "thr_parent", call("implementer-low", { thinking: "off" }), DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.deepEqual(spawned[0].request.environment, {
    type: "host", hostId: "host_test", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature" } },
  });
  assert.equal(spawned[0].request.reasoningLevel, "none");
  assert.equal(result.launched.workspace, "worktree");
  assert.equal(result.launched.thinking, "off");
  assert.equal(result.launched.reasoningLevel, "none");
});

test("delegate: a writer without a git checkout on a branch is isolation_unavailable and takes no slot", async () => {
  for (const env of [{ gitRepo: false }, { branch: null }]) {
    const db = openDb();
    const { host, spawned } = fakeHost(db, env);
    const result = await delegate(db, host, "thr_parent", call("implementer-low"), DEFAULT_SETTINGS);
    assert.equal(!result.ok && result.refusal.code, "isolation_unavailable");
    assert.equal(spawned.length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM delegations").get() as { n: number }).n, 0);
  }
});

test("delegate: a writer with project runs in a worktree of that project, from a parent that is no git checkout", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db, { gitRepo: false });
  const result = await delegate(db, host, "thr_parent", call("implementer-low", { project: "repo" }), DEFAULT_SETTINGS);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.launched.workspace, "worktree");
  const [{ request }] = spawned;
  assert.equal(request.projectId, "proj_repo");
  assert.equal(request.parentThreadId, "thr_parent");
  assert.deepEqual(request.environment, { type: "host", hostId: "host_test", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
});

test("delegate: project with baseBranch names the base; a project without a checkout on the parent's host goes to its default host", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db);
  const result = await delegate(db, host, "thr_parent", call("implementer-low", { project: "proj_far", baseBranch: "release" }), DEFAULT_SETTINGS);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(spawned[0].request.projectId, "proj_far");
  assert.deepEqual(spawned[0].request.environment, { type: "host", hostId: "host_other", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "release" } } });
});

test("delegate: target_unavailable for an unknown or personal project, a reader with project, or baseBranch alone, and no slot is taken", async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["implementer-low", { project: "nope" }, /no project with id or name nope/],
    ["implementer-low", { project: "Personal" }, /personal project/],
    ["scout", { project: "repo" }, /reads only/],
    ["implementer-low", { baseBranch: "main" }, /baseBranch needs project/],
  ];
  for (const [agent, extra, message] of cases) {
    const db = openDb();
    const { host, spawned } = fakeHost(db);
    const result = await delegate(db, host, "thr_parent", call(agent, extra), DEFAULT_SETTINGS);
    assert.ok(!result.ok);
    assert.equal(result.refusal.code, "target_unavailable");
    assert.match((result.refusal as { message: string }).message, message);
    assert.equal(spawned.length, 0);
    assert.equal(listSlotHolders(db, "thr_parent").length, 0);
  }
});

test("delegate: the isolation_unavailable message points to project", async () => {
  const db = openDb();
  const { host } = fakeHost(db, { gitRepo: false });
  const result = await delegate(db, host, "thr_parent", call("implementer-low"), DEFAULT_SETTINGS);
  assert.ok(!result.ok && result.refusal.code === "isolation_unavailable");
  assert.match(result.refusal.message, /pass project/);
});

test("launchInputHash: unchanged without a target, different with one", () => {
  const base = call("implementer-low");
  assert.equal(launchInputHash(base), launchInputHash({ ...base, project: undefined }));
  assert.notEqual(launchInputHash(base), launchInputHash({ ...base, project: "repo" }));
  assert.notEqual(launchInputHash({ ...base, project: "repo" }), launchInputHash({ ...base, project: "repo", baseBranch: "main" }));
});

test("delegate: provider_unsupported when pi is missing or unavailable, or the parent's permission mode is not pi's", async () => {
  const cases: Parameters<typeof fakeHost>[1][] = [
    { piProvider: async () => null },
    { piProvider: async () => ({ available: false, permissionModes: ["full"] }) },
    { parentMode: "accept-edits" },
    { parentMode: null },
  ];
  for (const overrides of cases) {
    const db = openDb();
    const { host, spawned } = fakeHost(db, overrides);
    const result = await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
    assert.equal(!result.ok && result.refusal.code, "provider_unsupported");
    assert.equal(spawned.length, 0);
  }
});

test("delegate: the child's permission mode is the parent's", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db, { parentMode: "auto", piProvider: async () => ({ available: true, permissionModes: ["auto", "full"] }) });
  assert.ok((await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS)).ok);
  assert.equal(spawned[0].request.permissionMode, "auto");
});

test("delegate: async spawns the child with parentNotifications auto, wait mode with off", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db);
  assert.ok((await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS)).ok);
  assert.ok((await delegate(db, host, "thr_parent", call("scout", { mode: "wait", task: "other" }), DEFAULT_SETTINGS)).ok);
  assert.deepEqual(spawned.map((entry) => entry.request.parentNotifications), ["auto", "off"]);
  const marked = db.prepare("SELECT d.client_request_id AS c, m.delegation_id AS id FROM delegation_wait_marks m JOIN delegations d USING (delegation_id)").all();
  assert.equal(marked.length, 1, "only the wait-mode delegation is marked for the watchdog");
  assert.equal((marked[0] as { id: string }).id, (db.prepare("SELECT delegation_id AS id FROM delegations ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id);
});

test("delegate: during a delayed bind the child is already marked and its policy is pending, never denied", async () => {
  const db = openDb();
  let during: { tools: string[]; policy: string } | null = null;
  const { host } = fakeHost(db, {
    bindDelayMs: async () => 5_000,
    sleep: async () => {
      during = { tools: delegateToolsFor(db, "thr_child1", { delegationId: lastId() }), policy: issuePolicy(db, "thr_child1", { delegationId: lastId() }).status };
    },
  });
  const lastId = () => (db.prepare("SELECT delegation_id AS id FROM delegations ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
  const result = await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.deepEqual(during, { tools: ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"], policy: "pending" });
  assert.equal(getDelegationByChild(db, "thr_child1")?.state, "starting");
  assert.equal(issuePolicy(db, "thr_child1", {}).status, "ok");
});

test("delegate: a spawn SANDY rejects (4xx) ends the reserved row in error and frees its slot", async () => {
  const db = openDb();
  const { host } = fakeHost(db, { spawn: async () => { throw Object.assign(new Error("invalid model"), { status: 400 }); } });
  const result = await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
  assert.ok(!result.ok && result.refusal.code === "spawn_failed");
  assert.equal(getDelegation(db, (result.refusal as { delegationId: string }).delegationId)?.state, "error");
});

test("delegate: a spawn whose result is lost (timeout, 5xx) keeps the reservation and its slot for the watchdog; a retry does not spawn again", async () => {
  for (const error of [new Error("request timed out"), Object.assign(new Error("bad gateway"), { status: 502 })]) {
    const db = openDb();
    let spawns = 0;
    const { host } = fakeHost(db, { spawn: async () => { spawns++; throw error; } });
    const result = await delegate(db, host, "thr_parent", call("scout", { clientRequestId: "r1" }), DEFAULT_SETTINGS);
    assert.ok(!result.ok && result.refusal.code === "spawn_unconfirmed", error.message);
    const delegationId = (result.refusal as { delegationId: string }).delegationId;
    assert.deepEqual([getDelegation(db, delegationId)?.state, getDelegation(db, delegationId)?.childThreadId], ["reserved", null], error.message);
    assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [delegationId], error.message);
    const retry = await delegate(db, host, "thr_parent", call("scout", { clientRequestId: "r1" }), DEFAULT_SETTINGS);
    assert.ok(retry.ok && retry.launched.reused && retry.launched.delegationId === delegationId, error.message);
    assert.equal(spawns, 1, `${error.message}: never spawned again`);
  }
});

test("delegate: ledger refusals pass through, a retried clientRequestId does not spawn again", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db);
  assert.equal((await delegate(db, host, "thr_parent", call("nobody"), DEFAULT_SETTINGS) as { refusal: { code: string } }).refusal.code, "unknown_agent");
  const first = await delegate(db, host, "thr_parent", call("scout", { clientRequestId: "r1" }), DEFAULT_SETTINGS);
  const retry = await delegate(db, host, "thr_parent", call("scout", { clientRequestId: "r1" }), DEFAULT_SETTINGS);
  assert.ok(first.ok && retry.ok);
  assert.equal(retry.launched.delegationId, first.launched.delegationId);
  assert.equal(retry.launched.reused, true);
  assert.equal(spawned.length, 1);
  // The child itself is refused: depth 1.
  const nested = await delegate(db, host, "thr_child1", call("scout"), DEFAULT_SETTINGS);
  assert.equal(!nested.ok && nested.refusal.code, "nested_delegation");
});

test("listDelegations / formatDelegationTable: newest first, with the SANDY reasoning level and ack state", async () => {
  const db = openDb();
  const { host } = fakeHost(db);
  await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
  await delegate(db, host, "thr_other", call("implementer-low", { thinking: "minimal" }), DEFAULT_SETTINGS);
  const all = listDelegations(db, { limit: 10 });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((entry) => [entry.agent, entry.reasoningLevel, entry.ackedAt]), [["implementer-low", "low", null], ["scout", "medium", null]]);
  assert.deepEqual(listDelegations(db, { parentThreadId: "thr_parent", limit: 10 }).map((entry) => entry.agent), ["scout"]);
  const table = formatDelegationTable(all).split("\n");
  assert.match(table[0], /^DELEGATION\s+STATE\s+AGENT\s+PARENT\s+CHILD\s+MODEL\s+REASONING\s+ACKED\s+BRIEF\s+STOP\s+CREATED$/);
  assert.match(table[1], /implementer-low.*thr_other.*thr_child2.*low\s+no\s+no\s+-\s/);
  assert.equal(formatDelegationTable([]), "no delegations\n");
});

test("delegate: a catalog update to a writer during the root lookup spawns in a worktree, never in the parent's checkout", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db, {
    rootOf: async (threadId) => {
      putAgent(db, { ...getAgent(db, "scout")!, version: 3, tools: ["read", "edit", "write", "bash"], role: "writer" });
      return threadId;
    },
  });
  const result = await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
  assert.ok(result.ok);
  const row = getDelegation(db, result.launched.delegationId)!;
  assert.equal(getSnapshot(db, row.snapshotHash!)!.entry.role, "writer");
  assert.deepEqual(spawned[0].request.environment, {
    type: "host", hostId: "host_test", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature" } },
  });
  assert.equal(result.launched.workspace, "worktree");
});

test("delegate: a catalog update to a writer during the root lookup is refused when the parent cannot give a worktree, and frees its slot", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db, {
    gitRepo: false,
    rootOf: async (threadId) => {
      putAgent(db, { ...getAgent(db, "scout")!, version: 3, tools: ["read", "edit", "write", "bash"], role: "writer" });
      return threadId;
    },
  });
  const result = await delegate(db, host, "thr_parent", call("scout"), DEFAULT_SETTINGS);
  assert.ok(!result.ok);
  assert.equal(result.refusal.code, "isolation_unavailable");
  assert.equal(spawned.length, 0);
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
});

test("delegate: a catalog update to a reader during the root lookup spawns in the parent's environment", async () => {
  const db = openDb();
  const { host, spawned } = fakeHost(db, {
    rootOf: async (threadId) => {
      putAgent(db, { ...getAgent(db, "implementer-low")!, version: getAgent(db, "implementer-low")!.version + 1, tools: ["read"], role: "reader" });
      return threadId;
    },
  });
  const result = await delegate(db, host, "thr_parent", call("implementer-low"), DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.deepEqual(spawned[0].request.environment, { type: "reuse", environmentId: "env_parent" });
  assert.equal(result.launched.workspace, "parent");
});
