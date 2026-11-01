import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { issuePolicy, recordAck, storeBrief, deliverBrief } from "../server/protocol.ts";
import { authorizePanel, panelAckFailures, panelList, panelMerge, panelScope, panelSetHidden, panelWriterDetails, promptAudit, type ChildEnvironment, type PanelHost } from "../server/panel.ts";
import { branchChanges, mergeBranch } from "../host-git.ts";
import type { StatusHost } from "../server/status.ts";
import { bannerRows, fleetSegmentText, openRows } from "../panel-view.ts";

type Db = ReturnType<typeof openDb>;
const NOW = 10_000_000;

function delegation(db: Db, parent: string, child: string | null, agent = "scout"): string {
  const admitted = admit(db, { rootThreadId: parent, callerThreadId: parent, kind: "delegate", agent, inputHash: "h" + (child ?? Math.random()) }, DEFAULT_SETTINGS, NOW - 100_000);
  assert.ok(admitted.ok);
  const id = admitted.delegation.delegationId;
  if (child !== null) assert.ok(bindChild(db, id, child, NOW - 90_000).ok);
  return id;
}

const idleStatus = (threadStatus = "idle"): StatusHost => ({
  threadState: async () => ({ status: threadStatus, archived: false }),
  latestTurnEvents: async () => (threadStatus === "active" ? [{ seq: 1, type: "started", at: NOW - 1000 }] : [{ seq: 1, type: "started", at: NOW - 60_000 }, { seq: 2, type: "completed", at: NOW - 20_000, outcome: "completed" }]),
  executionOptions: async () => ({ model: "anthropic/claude-haiku-5-5", reasoningLevel: "low" }),
  usage: async () => ({ totalTokens: 1000, contextTokens: 500, contextWindow: 200_000 }),
  lastEventAt: async () => NOW - 20_000,
  latestFailure: async () => null,
  now: () => NOW,
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// A parent checkout with one commit and a child branch "delegate/w" that changes file.txt (or adds child.txt).
function repo(childChange: { file: string; text: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-merge-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "file.txt"), "base\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "base");
  sh(dir, "checkout", "-qb", "delegate/w");
  writeFileSync(join(dir, childChange.file), childChange.text);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "child work");
  sh(dir, "checkout", "-q", "main");
  return dir;
}

// PanelHost over a real repo: the parent and child share the host, the child's environment names the branch.
function hostFor(path: string, hidden: Map<string, boolean> = new Map()): PanelHost & { hiddenCalls: [string, boolean][] } {
  const envs: Record<string, ChildEnvironment> = {
    env_parent: { hostId: "host_1", path, branchName: "main", isGitRepo: true },
    env_child: { hostId: "host_1", path: path + "-wt", branchName: "delegate/w", isGitRepo: true },
  };
  const hiddenCalls: [string, boolean][] = [];
  return {
    hiddenCalls,
    threadInfo: async (threadId) => ({ hidden: hidden.get(threadId) ?? true, environmentId: threadId.startsWith("thr_parent") ? "env_parent" : "env_child" }),
    setHidden: async (threadId, value) => {
      hiddenCalls.push([threadId, value]);
      hidden.set(threadId, value);
    },
    environment: async (id) => envs[id],
    branchChanges: async (_hostId, at, branch) => branchChanges(at, branch),
    mergeBranch: async (_hostId, at, branch, message) => mergeBranch(at, branch, message),
  };
}

test("panelScope: a parent sees its own delegations, a child only its own row, another thread nothing", () => {
  const db = openDb();
  const a = delegation(db, "thr_parent", "thr_c1");
  const b = delegation(db, "thr_parent", "thr_c2");
  delegation(db, "thr_other", "thr_c3");
  const parent = panelScope(db, "thr_parent");
  assert.deepEqual(parent.rows.map((row) => row.delegationId).sort(), [a, b].sort());
  assert.equal(parent.viewedIsChild, false);
  const child = panelScope(db, "thr_c1");
  assert.deepEqual(child.rows.map((row) => row.delegationId), [a]);
  assert.equal(child.viewedIsChild, true);
  assert.equal(child.rootThreadId, "thr_parent");
  assert.deepEqual(panelScope(db, "thr_stranger").rows, []);
});

test("authorizePanel refuses a delegation of another thread and a sibling from a child's panel", () => {
  const db = openDb();
  const own = delegation(db, "thr_parent", "thr_c1");
  const sibling = delegation(db, "thr_parent", "thr_c2");
  const foreign = delegation(db, "thr_other", "thr_c3");
  assert.equal(authorizePanel(db, "thr_parent", own).ok, true);
  assert.equal(authorizePanel(db, "thr_c1", own).ok, true);
  const refused = authorizePanel(db, "thr_parent", foreign);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.refusal.code, "not_in_view");
  assert.equal(authorizePanel(db, "thr_c1", sibling).ok, false);
  assert.equal(authorizePanel(db, "thr_parent", "del_unknown").ok, false);
});

test("panelList carries status, model, tokens, role and visibility per row", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_c1", "implementer-low");
  storeBrief(db, id, "write it", "[delegate-test] writer");
  const list = await panelList(db, idleStatus(), hostFor("/nowhere", new Map([["thr_c1", false]])), "thr_parent");
  assert.equal(list.rows.length, 1);
  const [row] = list.rows;
  assert.equal(row.role, "writer");
  assert.equal(row.title, "[delegate-test] writer");
  assert.equal(row.model, "anthropic/claude-haiku-5-5");
  assert.equal(row.reasoningLevel, "low");
  assert.deepEqual(row.tokens, { total: 1000, context: 500, contextWindow: 200_000 });
  assert.equal(row.hidden, false);
});

// A child whose SANDY thread is in error with the given message (latestFailure), or idle when message is null.
function failingStatus(failure: { message: string | null }): StatusHost {
  return {
    ...idleStatus(),
    threadState: async () => ({ status: failure.message === null ? "idle" : "error", archived: false }),
    latestFailure: async () => (failure.message === null ? null : ({ message: failure.message } as Awaited<ReturnType<StatusHost["latestFailure"]>>)),
  };
}

test("panelAckFailures: an acknowledged failure stays in the list, leaves the banner; a new failure shows again", async () => {
  const db = openDb();
  const failing = delegation(db, "thr_parent", "thr_c1");
  const failure = { message: "provider overloaded" as string | null };
  const status = failingStatus(failure);
  const host = hostFor("/nowhere");
  const before = await panelList(db, status, host, "thr_parent");
  assert.equal(before.rows[0].status, "error");
  assert.equal(before.rows[0].acknowledged, false);
  assert.deepEqual(bannerRows(before.rows).map((row) => row.delegationId), [failing]);

  assert.deepEqual(await panelAckFailures(db, status, "thr_parent", failing, NOW), { ok: true, acknowledged: [failing] });
  const after = await panelList(db, status, host, "thr_parent");
  assert.equal(after.rows.length, 1, "the Delegates tab keeps the row");
  assert.equal(after.rows[0].acknowledged, true);
  assert.deepEqual(bannerRows(after.rows), []);
  assert.deepEqual(openRows(after.rows), []);
  assert.equal(fleetSegmentText(after.rows), "0 delegates · +1 done · Σ 1.0k");

  failure.message = "context window exceeded";
  const next = await panelList(db, status, host, "thr_parent");
  assert.equal(next.rows[0].acknowledged, false, "another failure is not covered by the old ack");
  assert.deepEqual(bannerRows(next.rows).map((row) => row.delegationId), [failing]);
});

test("panelAckFailures: a child that recovers drops its ack, so the same failure later shows again", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_c1");
  const failure = { message: "boom" as string | null };
  const status = failingStatus(failure);
  const host = hostFor("/nowhere");
  await panelAckFailures(db, status, "thr_parent", id, NOW);
  failure.message = null;
  assert.equal((await panelList(db, status, host, "thr_parent")).rows[0].acknowledged, false);
  failure.message = "boom";
  assert.equal((await panelList(db, status, host, "thr_parent")).rows[0].acknowledged, false);
});

test("panelAckFailures: all acks only failed rows of the viewed thread; a foreign id is refused", async () => {
  const db = openDb();
  const a = delegation(db, "thr_parent", "thr_c1");
  const b = delegation(db, "thr_parent", "thr_c2");
  const foreign = delegation(db, "thr_other", "thr_c3");
  const status: StatusHost = {
    ...idleStatus(),
    threadState: async (threadId) => ({ status: threadId === "thr_c2" ? "idle" : "error", archived: false }),
    latestFailure: async () => ({ message: "boom" }) as Awaited<ReturnType<StatusHost["latestFailure"]>>,
  };
  assert.deepEqual(await panelAckFailures(db, status, "thr_parent", undefined, NOW), { ok: true, acknowledged: [a] });
  assert.deepEqual(await panelAckFailures(db, status, "thr_parent", b, NOW), { ok: true, acknowledged: [] });
  const refused = await panelAckFailures(db, status, "thr_parent", foreign, NOW);
  assert.equal(!refused.ok && refused.refusal.code, "not_in_view");
  assert.equal((await panelList(db, status, hostFor("/nowhere"), "thr_other")).rows[0].acknowledged, false);
});

test("panelSetHidden reveals and hides the child thread, only within the viewed thread's delegations", async () => {
  const db = openDb();
  const own = delegation(db, "thr_parent", "thr_c1");
  const foreign = delegation(db, "thr_other", "thr_c3");
  const host = hostFor("/nowhere");
  assert.deepEqual(await panelSetHidden(db, host, "thr_parent", own, false), { ok: true, hidden: false });
  assert.deepEqual(await panelSetHidden(db, host, "thr_parent", own, true), { ok: true, hidden: true });
  const refused = await panelSetHidden(db, host, "thr_parent", foreign, false);
  assert.equal(refused.ok, false);
  assert.deepEqual(host.hiddenCalls, [["thr_c1", false], ["thr_c1", true]]);
  const unbound = delegation(db, "thr_parent", null);
  const notStarted = await panelSetHidden(db, host, "thr_parent", unbound, false);
  assert.equal(!notStarted.ok && notStarted.refusal.code, "not_started");
});

test("promptAudit: snapshot, requested vs active tools, bootstrap prompt, brief and acks per pi session", () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_c1");
  storeBrief(db, id, "find the config loader", "[delegate-test] scout");
  const issued = issuePolicy(db, "thr_c1", {}, NOW - 80_000);
  assert.equal(issued.status, "ok");
  if (issued.status !== "ok") return;
  const acked = recordAck(db, { threadId: "thr_c1", delegationId: id, policyHash: issued.policyHash, nonce: issued.nonce, piSessionId: "pi_s1", turn: 1 }, 120_000, NOW - 79_000);
  assert.equal(acked.ok, true);
  assert.equal(deliverBrief(db, "thr_c1", NOW - 78_000).ok, true);
  const authorized = authorizePanel(db, "thr_parent", id);
  if (!authorized.ok) return assert.fail("own delegation refused");
  const audit = promptAudit(db, authorized.row);
  assert.equal(audit.agent, "scout");
  assert.equal(audit.role, "reader");
  assert.equal(audit.policyHash, issued.policyHash);
  assert.ok(audit.activeTools.includes("sandy_delegate_brief"));
  assert.ok(!audit.requestedTools.includes("sandy_delegate_brief"));
  assert.deepEqual(audit.transportTools, ["codemode"]);
  assert.match(audit.bootstrapPrompt, new RegExp(id));
  assert.equal(audit.brief?.task, "find the config loader");
  assert.equal(audit.brief?.deliveredAt, NOW - 78_000);
  assert.ok((audit.brief?.body ?? "").length > 0);
  assert.equal(audit.sessions.length, 1);
  assert.equal(audit.sessions[0].piSessionId, "pi_s1");
  assert.deepEqual(audit.sessions[0].acks.map((ack) => [ack.turn, ack.ackedAt, ack.briefDeliveredAt]), [[1, NOW - 79_000, NOW - 78_000]]);
});

test("panelWriterDetails lists the child branch's commits and files; a reader is refused", async () => {
  const db = openDb();
  const dir = repo({ file: "child.txt", text: "new\n" });
  try {
    const writer = delegation(db, "thr_parent", "thr_c1", "implementer-low");
    const reader = delegation(db, "thr_parent", "thr_c2", "scout");
    const details = await panelWriterDetails(db, hostFor(dir), "thr_parent", writer);
    assert.ok(details.ok);
    if (!details.ok) return;
    assert.equal(details.details.branch, "delegate/w");
    assert.equal(details.details.base, "main");
    assert.equal(details.details.commits.length, 1);
    assert.deepEqual(details.details.files, [{ status: "A", path: "child.txt" }]);
    const refused = await panelWriterDetails(db, hostFor(dir), "thr_parent", reader);
    assert.equal(!refused.ok && refused.refusal.code, "not_a_writer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panelMerge: clean merge --no-ff into the parent's branch, then up_to_date", async () => {
  const db = openDb();
  const dir = repo({ file: "child.txt", text: "new\n" });
  try {
    const writer = delegation(db, "thr_parent", "thr_c1", "implementer-low");
    const merged = await panelMerge(db, idleStatus(), hostFor(dir), "thr_parent", writer);
    assert.ok(merged.ok);
    if (!merged.ok) return;
    assert.equal(merged.result.status, "merged");
    assert.equal(sh(dir, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length, 3, "a merge commit (--no-ff)");
    assert.equal(sh(dir, "status", "--porcelain").trim(), "");
    const again = await panelMerge(db, idleStatus(), hostFor(dir), "thr_parent", writer);
    assert.equal(again.ok && again.result.status, "up_to_date");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panelMerge: a conflict is aborted and reported, the checkout is left clean", async () => {
  const db = openDb();
  const dir = repo({ file: "file.txt", text: "child\n" });
  try {
    writeFileSync(join(dir, "file.txt"), "parent\n");
    sh(dir, "commit", "-qam", "parent work");
    const head = sh(dir, "rev-parse", "HEAD").trim();
    const writer = delegation(db, "thr_parent", "thr_c1", "implementer-low");
    const merged = await panelMerge(db, idleStatus(), hostFor(dir), "thr_parent", writer);
    assert.ok(merged.ok);
    if (!merged.ok || merged.result.status !== "conflict") return assert.fail("expected a conflict");
    assert.deepEqual(merged.result.files, ["file.txt"]);
    assert.equal(merged.result.clean, true);
    assert.equal(sh(dir, "status", "--porcelain").trim(), "");
    assert.equal(sh(dir, "rev-parse", "HEAD").trim(), head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panelMerge refuses a dirty checkout without touching it, and a running child", async () => {
  const db = openDb();
  const dir = repo({ file: "child.txt", text: "new\n" });
  try {
    writeFileSync(join(dir, "file.txt"), "uncommitted\n");
    const writer = delegation(db, "thr_parent", "thr_c1", "implementer-low");
    const merged = await panelMerge(db, idleStatus(), hostFor(dir), "thr_parent", writer);
    assert.ok(merged.ok);
    assert.equal(merged.ok && merged.result.status, "dirty");
    assert.equal(sh(dir, "status", "--porcelain").trim(), "M file.txt");
    const running = await panelMerge(db, idleStatus("active"), hostFor(dir), "thr_parent", writer);
    assert.equal(!running.ok && running.refusal.code, "still_running");
    const foreign = await panelMerge(db, idleStatus(), hostFor(dir), "thr_other", writer);
    assert.equal(!foreign.ok && foreign.refusal.code, "not_in_view");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
