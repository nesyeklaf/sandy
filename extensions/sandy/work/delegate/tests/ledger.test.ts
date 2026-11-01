import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { getSnapshot } from "../server/catalog.ts";
import {
  admit,
  admitNextQueued,
  bindChild,
  getDelegation,
  settleDelivery,
  getPendingInput,
  listSlotHolders,
  claimDelivery,
  nextQueued,
  readmit,
  transition,
  type AdmitRequest,
  type DelegationRow,
} from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { openDb } from "./db-fixture.ts";

const settings = DEFAULT_SETTINGS;
const ROOT = "thread-root";

const request = (overrides: Partial<AdmitRequest> = {}): AdmitRequest => ({
  rootThreadId: ROOT,
  callerThreadId: ROOT,
  kind: "delegate",
  agent: "scout",
  inputHash: "input-" + Math.random(),
  ...overrides,
});

function admitted(db: Database.Database, overrides: Partial<AdmitRequest> = {}): DelegationRow {
  const result = admit(db, request(overrides), settings);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { delegation: DelegationRow }).delegation;
}

// A child that was spawned, bound and is running.
function running(db: Database.Database, childThreadId: string, overrides: Partial<AdmitRequest> = {}): DelegationRow {
  const row = admitted(db, overrides);
  assert.equal(bindChild(db, row.delegationId, childThreadId).ok, true);
  const active = transition(db, row.delegationId, "active");
  assert.equal(active.ok, true);
  return (active as { delegation: DelegationRow }).delegation;
}

function idle(db: Database.Database, childThreadId: string): DelegationRow {
  const row = running(db, childThreadId);
  assert.equal(transition(db, row.delegationId, "idle").ok, true);
  return getDelegation(db, row.delegationId)!;
}

test("default settings", () => {
  assert.deepEqual(DEFAULT_SETTINGS, { maxConcurrentChildren: 4, waitCeilingMs: 270_000, briefWatchdogSeconds: 120, questionTimeoutDays: 7 });
});

test("admit: a delegate row is reserved with the catalog snapshot, model and thinking", () => {
  const db = openDb();
  const row = admitted(db, { clientRequestId: "req-1" });
  assert.equal(row.state, "reserved");
  assert.equal(row.kind, "delegate");
  assert.equal(row.rootThreadId, ROOT);
  assert.equal(row.parentThreadId, ROOT);
  assert.equal(row.childThreadId, null);
  assert.equal(row.agent, "scout");
  assert.equal(row.agentVersion, 2);
  assert.equal(row.model, "anthropic/claude-haiku-5-5");
  assert.equal(row.thinking, "medium");
  assert.equal(row.clientRequestId, "req-1");
  assert.match(row.delegationId, /^dlg_/);
  assert.equal(getSnapshot(db, row.snapshotHash!)?.entry.name, "scout");
});

test("admit: the 5th running child is refused with limit_reached naming the 4", () => {
  const db = openDb();
  const holders = [
    admitted(db),
    (() => { const row = admitted(db); bindChild(db, row.delegationId, "child-starting"); return row; })(),
    running(db, "child-active-1"),
    running(db, "child-active-2"),
  ];
  const result = admit(db, request(), settings);
  assert.equal(result.ok, false);
  const refusal = (result as { refusal: { code: string; limit: number; running: DelegationRow[] } }).refusal;
  assert.equal(refusal.code, "limit_reached");
  assert.equal(refusal.limit, 4);
  assert.deepEqual(refusal.running.map((row) => row.delegationId).sort(), holders.map((row) => row.delegationId).sort());
  assert.deepEqual(refusal.running.map((row) => row.state).sort(), ["active", "active", "reserved", "starting"]);
  assert.equal(listSlotHolders(db, ROOT).length, 4);
});

test("admit: slots are per root and the limit is the setting", () => {
  const db = openDb();
  for (let i = 0; i < 4; i++) running(db, `child-${i}`);
  assert.equal(admit(db, request({ rootThreadId: "other-root", callerThreadId: "other-root" }), settings).ok, true);
  assert.equal(admit(db, request(), { maxConcurrentChildren: 5 }).ok, true);
});

test("admit: workflows-plus workers count against the same slots", () => {
  const db = openDb();
  for (let i = 0; i < 3; i++) running(db, `delegate-${i}`);
  const worker = admitted(db, { kind: "workflow-worker", agent: "worker", model: "openai/gpt-x" });
  assert.equal(worker.snapshotHash, null);
  assert.equal(worker.model, "openai/gpt-x");
  const fifth = admit(db, request({ kind: "workflow-worker", agent: "worker" }), settings);
  assert.equal(fifth.ok, false);
  assert.equal((fifth as { refusal: { code: string } }).refusal.code, "limit_reached");
});

test("admit: an idle child frees its slot; error, refused and stopped free it too", () => {
  const db = openDb();
  const children = [running(db, "c0"), running(db, "c1"), running(db, "c2"), running(db, "c3")];
  assert.equal(admit(db, request(), settings).ok, false);
  assert.equal(transition(db, children[0].delegationId, "idle").ok, true);
  const next = admitted(db);
  assert.equal(admit(db, request(), settings).ok, false);
  for (const [index, end] of [[1, "error"], [2, "refused"], [3, "stopped"]] as const) {
    assert.equal(transition(db, children[index].delegationId, end).ok, true);
    assert.equal(admit(db, request(), settings).ok, true, end);
    assert.equal(admit(db, request(), settings).ok, false);
  }
  assert.equal(getDelegation(db, next.delegationId)!.state, "reserved");
});

test("admit: same clientRequestId and input returns the same delegation, other input is idempotency_conflict", () => {
  const db = openDb();
  const first = admitted(db, { clientRequestId: "req-1", inputHash: "hash-a" });
  for (let i = 0; i < 3; i++) running(db, `c${i}`);
  const again = admit(db, request({ clientRequestId: "req-1", inputHash: "hash-a" }), settings);
  assert.deepEqual(again, { ok: true, delegation: getDelegation(db, first.delegationId), reused: true }, "also when the root is full");
  const conflict = admit(db, request({ clientRequestId: "req-1", inputHash: "hash-b" }), settings);
  assert.deepEqual(conflict, { ok: false, refusal: { code: "idempotency_conflict", clientRequestId: "req-1", delegationId: first.delegationId } });
  assert.equal(listSlotHolders(db, ROOT).length, 4);
});

test("admit: clientRequestId is scoped to the calling thread", () => {
  const db = openDb();
  const mine = admitted(db, { clientRequestId: "req-1", inputHash: "hash-a" });
  const theirs = admitted(db, { callerThreadId: "other-parent", clientRequestId: "req-1", inputHash: "hash-b" });
  assert.notEqual(mine.delegationId, theirs.delegationId);
  assert.equal(theirs.parentThreadId, "other-parent");
});

test("admit: a caller bound as a child is refused with nested_delegation", () => {
  const db = openDb();
  const child = running(db, "child-thread");
  for (const kind of ["delegate", "workflow-worker"] as const) {
    const result = admit(db, request({ callerThreadId: "child-thread", kind }), settings);
    assert.deepEqual(result, { ok: false, refusal: { code: "nested_delegation", callerThreadId: "child-thread", delegationId: child.delegationId } });
  }
  transition(db, child.delegationId, "stopped");
  assert.equal(admit(db, request({ callerThreadId: "child-thread" }), settings).ok, false, "also once the child has ended");
});

test("admit: unknown_agent and model overrides", () => {
  const db = openDb();
  assert.deepEqual(admit(db, request({ agent: "nobody" }), settings), { ok: false, refusal: { code: "unknown_agent", agent: "nobody" } });
  assert.deepEqual(admit(db, request({ model: "openai/gpt-x" }), settings), {
    ok: false,
    refusal: { code: "model_not_allowed", model: "openai/gpt-x", allowed: ["anthropic/claude-haiku-5-5"] },
  });
  const row = admitted(db, { model: "anthropic/claude-haiku-5-5", thinking: "low" });
  assert.equal(row.thinking, "low");
  assert.throws(() => admit(db, request({ thinking: "huge" as never }), settings), /thinking must be one of/);
  assert.equal(listSlotHolders(db, ROOT).length, 1);
});

test("bindChild: binds a reserved row once, a child thread binds one delegation only", () => {
  const db = openDb();
  const row = admitted(db);
  const bound = bindChild(db, row.delegationId, "child-1");
  assert.equal(bound.ok, true);
  assert.equal((bound as { delegation: DelegationRow }).delegation.state, "starting");
  assert.equal((bound as { delegation: DelegationRow }).delegation.childThreadId, "child-1");
  assert.deepEqual(bindChild(db, row.delegationId, "child-2"), { ok: false, state: "starting" });
  assert.deepEqual(bindChild(db, "dlg_missing", "child-3"), { ok: false, state: null });
  assert.throws(() => bindChild(db, admitted(db).delegationId, "child-1"), /UNIQUE/);
});

test("transition: end states are final, idle cannot take a slot without readmit", () => {
  const db = openDb();
  const row = idle(db, "child-1");
  assert.deepEqual(transition(db, row.delegationId, "reserved"), { ok: false, state: "idle" });
  assert.deepEqual(transition(db, row.delegationId, "active"), { ok: false, state: "idle" });
  assert.equal(transition(db, row.delegationId, "stopped").ok, true);
  assert.deepEqual(transition(db, row.delegationId, "active"), { ok: false, state: "stopped" });
});

test("readmit: an idle child takes a free slot, a running one already holds one, an ended one is refused", () => {
  const db = openDb();
  const sleeper = idle(db, "child-idle");
  const result = readmit(db, { delegationId: sleeper.delegationId, input: { kind: "steer", payload: "go on" } }, settings);
  assert.equal(result.ok && result.status, "admitted");
  assert.equal(getDelegation(db, sleeper.delegationId)!.state, "reserved");
  const busy = running(db, "child-busy");
  const steer = readmit(db, { delegationId: busy.delegationId, input: { kind: "steer", payload: "x" } }, settings);
  assert.equal(steer.ok && steer.status, "holds_slot");
  transition(db, busy.delegationId, "stopped");
  assert.deepEqual(readmit(db, { delegationId: busy.delegationId, input: { kind: "steer", payload: "x" } }, settings), {
    ok: false,
    refusal: { code: "delegation_ended", state: "stopped" },
  });
  assert.deepEqual(readmit(db, { delegationId: "dlg_missing", input: { kind: "steer", payload: "x" } }, settings), {
    ok: false,
    refusal: { code: "unknown_delegation" },
  });
});

test("readmit: when the root is full inputs queue, nextQueued returns them FIFO and they are admitted in order", () => {
  const db = openDb();
  const a = idle(db, "child-a");
  const b = idle(db, "child-b");
  const runners = [running(db, "r0"), running(db, "r1"), running(db, "r2"), running(db, "r3")];
  const queue = (delegationId: string, payload: string) => {
    const result = readmit(db, { delegationId, input: { kind: "queue", payload } }, settings);
    assert.equal(result.ok && result.status, "queued");
    return (result as { pendingInput: { inputId: string } }).pendingInput;
  };
  const first = queue(b.delegationId, "b-1");
  const second = queue(a.delegationId, "a-1");
  const third = queue(b.delegationId, "b-2");
  assert.equal(nextQueued(db, ROOT)!.inputId, first.inputId);
  assert.equal(nextQueued(db, ROOT)!.payload, "b-1");
  assert.equal(nextQueued(db, "other-root"), null);
  assert.equal(admitNextQueued(db, ROOT, settings), null, "full: nothing admitted");

  transition(db, runners[0].delegationId, "idle");
  // A newcomer does not jump the queue while older inputs wait, even with a slot free.
  const c = idle(db, "child-c");
  const newcomer = readmit(db, { delegationId: c.delegationId, input: { kind: "steer", payload: "c-1" } }, settings);
  assert.equal(newcomer.ok && newcomer.status, "queued");

  const one = admitNextQueued(db, ROOT, settings)!;
  assert.equal(one.pendingInput.inputId, first.inputId);
  assert.equal(one.pendingInput.state, "admitted");
  assert.equal(one.delegation.state, "reserved");
  assert.equal(nextQueued(db, ROOT)!.inputId, second.inputId);
  assert.equal(admitNextQueued(db, ROOT, settings), null, "full again");
  const claim = claimDelivery(db, { delegationId: one.delegation.delegationId, inputId: first.inputId, reservationOwner: one.reservationOwner, afterSeq: null });
  assert.ok(claim.ok);
  assert.deepEqual(claimDelivery(db, { delegationId: one.delegation.delegationId, inputId: first.inputId, reservationOwner: one.reservationOwner, afterSeq: null }), { ok: false, reason: "input_taken" });
  assert.equal(settleDelivery(db, claim.delivery.deliveryId, "sent"), true);
  assert.equal(settleDelivery(db, claim.delivery.deliveryId, "sent"), false, "delivered once");
  assert.equal(getPendingInput(db, first.inputId)?.state, "delivered");

  transition(db, runners[1].delegationId, "idle");
  assert.equal(admitNextQueued(db, ROOT, settings)!.pendingInput.inputId, second.inputId);
  // b already holds its slot from b-1: b-2 is admitted without a new slot.
  const sameChild = admitNextQueued(db, ROOT, settings)!;
  assert.equal(sameChild.pendingInput.inputId, third.inputId);
  assert.equal(sameChild.delegation.delegationId, b.delegationId);
  assert.equal(nextQueued(db, ROOT)!.payload, "c-1");
  assert.equal(listSlotHolders(db, ROOT).length, 4);
});

test("readmit: queued inputs of a child that ends are cancelled and skipped", () => {
  const db = openDb();
  const a = idle(db, "child-a");
  const b = idle(db, "child-b");
  const runners = [running(db, "r0"), running(db, "r1"), running(db, "r2"), running(db, "r3")];
  const aInput = readmit(db, { delegationId: a.delegationId, input: { kind: "answer", payload: { answer: 42 } } }, settings);
  const bInput = readmit(db, { delegationId: b.delegationId, input: { kind: "continuation", payload: null } }, settings);
  transition(db, a.delegationId, "stopped");
  assert.equal(getPendingInput(db, (aInput as { pendingInput: { inputId: string } }).pendingInput.inputId)!.state, "cancelled");
  transition(db, runners[0].delegationId, "idle");
  assert.equal(admitNextQueued(db, ROOT, settings)!.pendingInput.inputId, (bInput as { pendingInput: { inputId: string } }).pendingInput.inputId);
});

test("admit: two concurrent admissions on a root with one free slot, on two connections -> exactly one wins", async () => {
  for (let round = 0; round < 10; round++) {
    const file = join(mkdtempSync(join(tmpdir(), "sandy-delegate-race-")), "data.db");
    const db = openDb(file);
    for (let i = 0; i < 3; i++) running(db, `child-${i}`);
    const barrier = new SharedArrayBuffer(4);
    const workers = ["parent-a", "parent-b"].map(
      (callerThreadId) => new Worker(new URL("./admit-race-worker.ts", import.meta.url), { workerData: { file, barrier, rootThreadId: ROOT, callerThreadId } }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ ok: boolean; code: string | null }>((resolve, reject) => {
          worker.on("message", (message) => { if (!message.ready) resolve(message); });
          worker.on("error", reject);
        }),
    );
    await Promise.all(workers.map((worker) => new Promise<void>((resolve) => worker.once("message", () => resolve()))));
    const gate = new Int32Array(barrier);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const outcomes = await Promise.all(results);
    assert.deepEqual(outcomes.map((outcome) => outcome.code).sort(), ["limit_reached", null], `round ${round}`);
    assert.equal(listSlotHolders(db, ROOT).length, 4, `round ${round}`);
    db.close();
  }
});
