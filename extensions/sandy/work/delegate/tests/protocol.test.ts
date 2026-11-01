import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, getDelegation, listSlotHolders, transition } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { policyHash } from "../shared/policy.ts";
import { briefToolsLine, delegateToolsFor, deliverBrief, issuePolicy, recordAck, storeBrief, type PolicyAnswer } from "../server/protocol.ts";

const reserve = (db: ReturnType<typeof openDb>, agent = "scout", caller = "thr_parent") => {
  const result = admit(db, { rootThreadId: caller, callerThreadId: caller, kind: "delegate", agent, inputHash: agent }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  storeBrief(db, result.delegation.delegationId, "find the config loader", "[delegate-test] scout");
  return result.delegation.delegationId;
};

const launched = (db: ReturnType<typeof openDb>, child = "thr_child") => {
  const delegationId = reserve(db);
  assert.ok(bindChild(db, delegationId, child).ok);
  return delegationId;
};

const ok = (answer: PolicyAnswer) => {
  assert.equal(answer.status, "ok");
  return answer as Extract<PolicyAnswer, { status: "ok" }>;
};

test("delegateToolsFor: any binding or delegation metadata gets the marker (metadata restricts), plain threads get sandy_delegate", () => {
  const db = openDb();
  const pending = reserve(db);
  assert.deepEqual(delegateToolsFor(db, "thr_new", { delegationId: pending }), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  assert.deepEqual(delegateToolsFor(db, "thr_plain", {}), ["sandy_delegate", "sandy_delegate_wait", "sandy_delegate_send", "sandy_delegate_stop", "sandy_delegate_status"]);
  assert.deepEqual(delegateToolsFor(db, "thr_plain", { delegationId: "dlg_unknown" }), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  assert.equal(issuePolicy(db, "thr_plain", { delegationId: "dlg_unknown" }).status, "denied");
  assert.ok(bindChild(db, pending, "thr_new").ok);
  assert.deepEqual(delegateToolsFor(db, "thr_new", {}), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  // Metadata naming a row bound to another thread still gates this thread; its policy is denied.
  assert.deepEqual(delegateToolsFor(db, "thr_other", { delegationId: pending }), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  assert.equal(issuePolicy(db, "thr_other", { delegationId: pending }).status, "denied");
  assert.ok(transition(db, pending, "stopped").ok);
  // An ended delegate stays gated (deny-all) when it is resumed.
  assert.deepEqual(delegateToolsFor(db, "thr_new", {}), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  assert.equal(issuePolicy(db, "thr_new", {}).status, "denied");
});

test("issuePolicy: bound child gets its snapshot policy and a fresh nonce per call", () => {
  const db = openDb();
  const delegationId = launched(db);
  const first = ok(issuePolicy(db, "thr_child", {}));
  const second = ok(issuePolicy(db, "thr_child", {}));
  assert.equal(first.policy.delegationId, delegationId);
  assert.deepEqual(first.policy.allowTools.sort(), ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "sandy_ask_parent", "sandy_delegate_brief", "sandy_question_answer", "find", "grep", "ls", "read", "tasks"]);
  assert.deepEqual(first.policy.transportTools, ["codemode"]);
  assert.equal(first.policyHash, policyHash(first.policy));
  assert.notEqual(first.nonce, second.nonce);
});

test("issuePolicy: an unbound reserved row named by metadata is pending; anything else is denied without a nonce", () => {
  const db = openDb();
  const delegationId = reserve(db);
  assert.deepEqual(issuePolicy(db, "thr_child", { delegationId }), { status: "pending", delegationId });
  for (const metadata of [{}, { delegationId: "dlg_unknown" }]) {
    const answer = issuePolicy(db, "thr_plain", metadata);
    assert.equal(answer.status, "denied");
    assert.deepEqual(answer.status === "denied" && [answer.nonce, answer.policy.allowTools, answer.policy.transportTools], [null, [], []]);
  }
  assert.ok(bindChild(db, delegationId, "thr_child").ok);
  assert.equal(issuePolicy(db, "thr_other", { delegationId }).status, "denied");
  assert.ok(transition(db, delegationId, "stopped").ok);
  assert.equal(issuePolicy(db, "thr_child", {}).status, "denied");
});

test("recordAck: a valid ack moves starting -> active; wrong hash, reused nonce and foreign delegation are refused", () => {
  const db = openDb();
  const delegationId = launched(db);
  const other = launched(db, "thr_child2");
  const issued = ok(issuePolicy(db, "thr_child", {}));
  const otherIssued = ok(issuePolicy(db, "thr_child2", {}));
  const ack = { threadId: "thr_child", delegationId, policyHash: issued.policyHash, nonce: issued.nonce, piSessionId: "pi-1", turn: 1 };

  assert.deepEqual(recordAck(db, { ...ack, policyHash: "0".repeat(64) }), { ok: false, code: "policy_mismatch", message: "policy hash does not match the issued policy" });
  assert.equal(recordAck(db, { ...ack, nonce: "nonce_never_issued" }).ok, false);
  // Foreign: another delegation's nonce, or this nonce claimed for another delegation / thread.
  assert.equal((recordAck(db, { ...ack, nonce: otherIssued.nonce }) as { code: string }).code, "foreign_delegation");
  assert.equal((recordAck(db, { ...ack, delegationId: other }) as { code: string }).code, "foreign_delegation");
  assert.equal((recordAck(db, { ...ack, threadId: "thr_child2" }) as { code: string }).code, "foreign_delegation");
  assert.equal(getDelegation(db, delegationId)!.state, "starting");

  const accepted = recordAck(db, ack);
  assert.ok(accepted.ok);
  assert.equal(accepted.delegation.state, "active");
  assert.equal((recordAck(db, ack) as { code: string }).code, "nonce_used");

  // A later session acks a fresh nonce; the row stays active.
  const again = ok(issuePolicy(db, "thr_child", {}));
  const reacked = recordAck(db, { ...ack, nonce: again.nonce, policyHash: again.policyHash, piSessionId: "pi-2", turn: 1 });
  assert.ok(reacked.ok);
  assert.equal(reacked.delegation.state, "active");
});

test("deliverBrief: only after a valid ack, once per delegation: a resumed session's ack gets already_delivered, the brief stays stored", () => {
  const db = openDb();
  const delegationId = launched(db);
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "no_ack");
  assert.equal((deliverBrief(db, "thr_plain") as { code: string }).code, "not_a_delegate");
  const issued = ok(issuePolicy(db, "thr_child", {}));
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "no_ack", "an issued but unacked nonce unlocks nothing");
  assert.ok(recordAck(db, { threadId: "thr_child", delegationId, policyHash: issued.policyHash, nonce: issued.nonce, piSessionId: "pi-1", turn: 1 }).ok);

  const brief = deliverBrief(db, "thr_child");
  assert.ok(brief.ok);
  assert.equal(brief.agent, "scout");
  assert.equal(brief.task, "find the config loader");
  assert.match(brief.body, /You are `scout`/);
  assert.deepEqual(brief.tools.filter((tool) => ["bash", "codemode", "edit", "read", "sandy_ask_parent"].includes(tool)), ["sandy_ask_parent", "codemode", "read"], "the brief names the gate's tools, transport included");
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "already_delivered");

  // A follow-up turn and a resumed session ack fresh nonces; neither gets the brief again.
  const followUp = ok(issuePolicy(db, "thr_child", {}));
  assert.ok(recordAck(db, { threadId: "thr_child", delegationId, policyHash: followUp.policyHash, nonce: followUp.nonce, piSessionId: "pi-1", turn: 2 }).ok);
  const resumed = ok(issuePolicy(db, "thr_child", {}));
  assert.ok(recordAck(db, { threadId: "thr_child", delegationId, policyHash: resumed.policyHash, nonce: resumed.nonce, piSessionId: "pi-2", turn: 1 }).ok);
  const again = deliverBrief(db, "thr_child");
  assert.equal(again.ok, false);
  assert.equal((again as { code: string }).code, "already_delivered");
  assert.match((again as { message: string }).message, /delivered earlier in this conversation/);
  assert.doesNotMatch((again as { message: string }).message, /find the config loader/);
  const acks = db.prepare("SELECT pi_session_id AS session, turn FROM delegation_acks WHERE delegation_id = ? AND acked_at IS NOT NULL ORDER BY acked_at, rowid").all(delegationId);
  assert.deepEqual(acks.map((row: any) => [row.session, row.turn]), [["pi-1", 1], ["pi-1", 2], ["pi-2", 1]], "each ack records its session and turn");
  const stored = db.prepare("SELECT task, delivered_at AS deliveredAt FROM delegation_briefs WHERE delegation_id = ?").get(delegationId) as { task: string; deliveredAt: number | null };
  assert.equal(stored.task, "find the config loader");
  assert.notEqual(stored.deliveredAt, null);
});

test("recordAck: a natively resumed idle child takes a slot again on its ack (idle -> active); a full root refuses it with limit_reached", () => {
  const db = openDb();
  const settings = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 2 };
  const delegationId = launched(db);
  const first = ok(issuePolicy(db, "thr_child", {}, Date.now(), settings));
  assert.ok(recordAck(db, { threadId: "thr_child", delegationId, policyHash: first.policyHash, nonce: first.nonce, piSessionId: "pi-1", turn: 1 }, undefined, Date.now(), settings).ok);
  assert.ok(transition(db, delegationId, "idle").ok);
  // Someone writes into the idle child's thread: its next turn loads a policy and acks it.
  const resumed = ok(issuePolicy(db, "thr_child", {}, Date.now(), settings));
  const other1 = reserve(db, "scout", "thr_parent");
  const other2 = reserve(db, "oracle", "thr_parent");
  assert.equal(listSlotHolders(db, "thr_parent").length, 2);
  const denied = issuePolicy(db, "thr_child", {}, Date.now(), settings);
  assert.equal(denied.status, "denied");
  assert.match((denied as { reason: string }).reason, /no free slot/);
  const refused = recordAck(db, { threadId: "thr_child", delegationId, policyHash: resumed.policyHash, nonce: resumed.nonce, piSessionId: "pi-2", turn: 1 }, undefined, Date.now(), settings);
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "limit_reached");
  assert.match((refused as { message: string }).message, /no free slot/);
  assert.equal(getDelegation(db, delegationId)!.state, "idle");
  assert.ok(transition(db, other2, "error").ok);
  const accepted = recordAck(db, { threadId: "thr_child", delegationId, policyHash: resumed.policyHash, nonce: resumed.nonce, piSessionId: "pi-2", turn: 1 }, undefined, Date.now(), settings);
  assert.ok(accepted.ok);
  assert.equal(accepted.delegation.state, "active");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId).sort(), [delegationId, other1].sort());
});

test("briefToolsLine: names the allowed tools and what a reader cannot do", () => {
  const reader = briefToolsLine(["codemode", "find", "read"]);
  assert.match(reader, /You can call only: codemode, find, read\./);
  assert.match(reader, /cannot run shell commands \(no bash, no git\)/);
  assert.match(reader, /cannot change files/);
  const writer = briefToolsLine(["bash", "edit", "read"]);
  assert.doesNotMatch(writer, /cannot/);
});
