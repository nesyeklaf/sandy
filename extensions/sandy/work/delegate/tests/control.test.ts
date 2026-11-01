import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import {
  admit, admitNextQueued, bindChild, getDelegation, getPendingInput, getStopRequest, listSlotHolders, claimDelivery, markStopConfirmed, moveReservedToIdle, nextQueued,
  readmit, settleDelivery, stopDelegation, transition, type DelegationState,
} from "../server/ledger.ts";
import { DELIVERY_SETTLE_MS, drainAfterSweep, drainQueues, sendToDelegation, stopDelegations, type ControlHost, type SendMode } from "../server/control.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { delegateToolsFor, issuePolicy, recordAck, storeBrief, type PolicyAnswer } from "../server/protocol.ts";
import { sweepWatchdog, type SweepReport, type TurnEvent, type WatchdogHost } from "../server/watchdog.ts";

type Db = ReturnType<typeof openDb>;

const WINDOW = 120_000;
const T0 = 1_800_000_000_000;
const ONE_SLOT = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 1 };
const TWO_SLOTS = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 2 };

type Options = {
  // The status after the first stop call of a test (default idle; later stop calls settle to idle).
  statusAfterStop?: string;
  // Rejects every send with this error.
  sendError?: Error & { status?: number };
  // How many send calls reject before they succeed.
  sendFailures?: number;
  // SANDY's answer to a send that succeeds (default sent).
  delivery?: "sent" | "queued";
};

// Pause points of a test, run before the fake answers (threadState reads the status before it pauses, so
// a paused call answers what SANDY showed when it was made). A hook may throw to fail the call.
type Hooks = {
  send?: (threadId: string, message: string) => Promise<void> | void;
  latestTurnEvents?: (threadId: string) => Promise<void> | void;
  threadState?: (threadId: string) => Promise<void> | void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// A one-shot pause for an interleaving: the first call (for threadId, when given) waits until release();
// reached resolves when it does.
function pausePoint(threadId?: string) {
  const reached = deferred<void>();
  const gate = deferred<void>();
  let used = false;
  return {
    reached: reached.promise,
    release: () => gate.resolve(),
    async hook(calledFor: string) {
      if (used || (threadId !== undefined && calledFor !== threadId)) return;
      used = true;
      reached.resolve();
      await gate.promise;
    },
  };
}

// Lets every other pending task run as far as it can (it may block on the delegation lock).
const settle = async () => { for (let round = 0; round < 20; round += 1) await new Promise((done) => setImmediate(done)); };

// A SANDY stand-in for the control tools and the sweep: thread statuses, turn events per thread, and every
// send and stop call it received.
function fakeHost(options: Options = {}) {
  const statuses = new Map<string, string>();
  const turns = new Map<string, TurnEvent[]>();
  const sent: { threadId: string; message: string; mode: SendMode }[] = [];
  const stops: string[] = [];
  // SANDY send and stop calls in the order they reached SANDY.
  const calls: string[] = [];
  const warnings: string[] = [];
  const hooks: Hooks = {};
  let failures = options.sendFailures ?? 0;
  const host: WatchdogHost & ControlHost = {
    pluginId: "delegate",
    deliveriesInFlight: new Set(),
    answerWaiters: new Map(),
    questionForms: new Map(),
    warn(line) { warnings.push(line); },
    async send(threadId, message, mode) {
      await hooks.send?.(threadId, message);
      if (options.sendError !== undefined && options.sendFailures === undefined) throw options.sendError;
      if (failures > 0) { failures -= 1; throw options.sendError ?? new Error("sandy unavailable"); }
      sent.push({ threadId, message, mode });
      calls.push("send " + threadId);
      statuses.set(threadId, "running");
      return { delivery: options.delivery ?? "sent" };
    },
    async stop(threadId) {
      stops.push(threadId);
      calls.push("stop " + threadId);
      statuses.set(threadId, stops.length === 1 ? (options.statusAfterStop ?? "idle") : "idle"); // the first stop call only is slow to take effect
    },
    async threadState(threadId) {
      const status = statuses.get(threadId) ?? "running";
      await hooks.threadState?.(threadId);
      return { status, archived: false };
    },
    async latestTurnEvents(threadId, count) {
      await hooks.latestTurnEvents?.(threadId);
      return [...(turns.get(threadId) ?? [])].sort((a, b) => a.seq - b.seq).slice(-count);
    },
    async turnEventsAfter(threadId, afterSeq, limit) {
      return [...(turns.get(threadId) ?? [])].sort((a, b) => a.seq - b.seq).filter((event) => afterSeq === null || event.seq > afterSeq).slice(0, limit);
    },
    async spawnCandidates() { return []; },
    spawnInFlight: () => false,
    waitInFlight: () => false,
    async setParentNotifications() {},
    async firstTurnStartedAt() { return null; },
  };
  return { host, statuses, turns, sent, stops, calls, hooks, warnings };
}

let counter = 0;

// A child of parent that has run its first turn (events 1-2, acked) and is bound to thr_c<n>; its row is in state.
function child(db: Db, host: ReturnType<typeof fakeHost>, parent: string, state: DelegationState = "active", root = parent) {
  counter += 1;
  const threadId = "thr_c" + counter;
  const result = admit(db, { rootThreadId: root, callerThreadId: parent, kind: "delegate", agent: "scout", inputHash: "h" + counter }, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 50 }, T0);
  assert.ok(result.ok);
  const delegationId = result.delegation.delegationId;
  storeBrief(db, delegationId, "task", "[delegate-test]", T0);
  assert.ok(bindChild(db, delegationId, threadId, T0 + 1_000).ok);
  const answer = issuePolicy(db, threadId, {}, T0 + 2_000) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.ok(recordAck(db, { threadId, delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn: 1 }, WINDOW, T0 + 3_000).ok);
  host.turns.set(threadId, [{ seq: 1, type: "started", at: T0 + 2_500 }, { seq: 2, type: "completed", at: T0 + 10_000 }]);
  host.statuses.set(threadId, state === "active" ? "running" : "idle");
  if (state !== "active") assert.ok(transition(db, delegationId, state, T0 + 11_000).ok);
  return { delegationId, threadId };
}

const sweep = (db: Db, host: WatchdogHost & ControlHost, settings: typeof ONE_SLOT, now: number) =>
  sweepWatchdog(db, host, WINDOW, now, { afterSweep: (report: SweepReport) => drainAfterSweep(db, host, settings, report, now) });

// Appends a turn the way the extension acks it: started (seq), acked, and (done) completed (seq + 1).
function nextTurn(db: Db, host: ReturnType<typeof fakeHost>, c: { delegationId: string; threadId: string }, turn: number, seq: number, done: boolean, first: number) {
  const answer = issuePolicy(db, c.threadId, {}, T0 + first - 100) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.ok(recordAck(db, { threadId: c.threadId, delegationId: c.delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn }, WINDOW, T0 + first + 100).ok);
  host.turns.get(c.threadId)!.push({ seq, type: "started", at: T0 + first });
  if (done) host.turns.get(c.threadId)!.push({ seq: seq + 1, type: "completed", at: T0 + first + 5_000 });
}

// Appends the child's second turn (seq 3, completed at seq 4 when done).
const secondTurn = (db: Db, host: ReturnType<typeof fakeHost>, c: { delegationId: string; threadId: string }, done: boolean, first: number) => nextTurn(db, host, c, 2, 3, done, first);

test("send: only the parent of a delegation may send; every other caller is refused before SANDY is reached", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent");
  const sibling = child(db, fake, "thr_parent");
  const other = child(db, fake, "thr_other");
  const reserved = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "unbound" }, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 50 }, T0);
  assert.ok(reserved.ok);
  const send = (callerThreadId: string, delegationId: string) => sendToDelegation(db, fake.host, TWO_SLOTS, { callerThreadId, delegationId, message: "hi", mode: "steer" });
  const code = async (callerThreadId: string, delegationId: string) => { const result = await send(callerThreadId, delegationId); return result.ok ? "ok" : result.refusal.code; };
  assert.equal(await code("thr_parent", "dlg_unknown"), "unknown_delegation");
  assert.equal(await code("thr_parent", other.delegationId), "not_parent");
  assert.equal(await code("thr_other", mine.delegationId), "not_parent");
  assert.equal(await code(mine.threadId, mine.delegationId), "delegate_caller", "a delegate on itself");
  assert.equal(await code(mine.threadId, sibling.delegationId), "delegate_caller", "a delegate on its sibling");
  assert.equal(await code("thr_parent", reserved.delegation.delegationId), "not_started");
  assert.deepEqual([fake.sent, fake.stops], [[], []]);
  assert.deepEqual(getDelegation(db, mine.delegationId)?.state, "active");
});

test("stop: only the parent of a delegation may stop; every other caller is refused and nothing is stopped", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent");
  const other = child(db, fake, "thr_other");
  const stop = async (callerThreadId: string, delegationId?: string) => {
    const result = await stopDelegations(db, fake.host, TWO_SLOTS, delegationId === undefined ? { callerThreadId, all: true } : { callerThreadId, delegationId });
    return result.ok ? "ok" : result.refusal.code;
  };
  assert.equal(await stop("thr_parent", "dlg_unknown"), "unknown_delegation");
  assert.equal(await stop("thr_parent", other.delegationId), "not_parent");
  assert.equal(await stop("thr_other", mine.delegationId), "not_parent");
  assert.equal(await stop(mine.threadId, mine.delegationId), "delegate_caller");
  assert.equal(await stop(mine.threadId), "delegate_caller", "a delegate's stop all");
  assert.deepEqual(fake.stops, []);
  assert.deepEqual([getDelegation(db, mine.delegationId)?.state, getDelegation(db, other.delegationId)?.state], ["active", "active"]);
});

test("delegateToolsFor: a plain parent thread gets send and stop; a delegate gets only the brief tool", () => {
  const db = openDb();
  assert.deepEqual(delegateToolsFor(db, "thr_plain", {}), ["sandy_delegate", "sandy_delegate_wait", "sandy_delegate_send", "sandy_delegate_stop", "sandy_delegate_status"]);
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent");
  assert.deepEqual(delegateToolsFor(db, mine.threadId, {}), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
});

test("send steer to a running child reaches it at once; no slot is taken and the row stays active", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent");
  const result = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "look at X", mode: "steer" });
  assert.deepEqual(result, { ok: true, status: "delivered", delegationId: mine.delegationId, threadId: mine.threadId, readmitted: false, sandyDelivery: "sent" });
  assert.deepEqual(fake.sent, [{ threadId: mine.threadId, message: "look at X", mode: "steer" }]);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.equal(getDelegation(db, mine.delegationId)?.idleAfterSeq, 2, "the newest turn event before the send");
  assert.equal(listSlotHolders(db, "thr_parent").length, 1);
});

test("send to an idle child re-admits it first: it takes a slot, the message is delivered, the row is active", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
  const result = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "continue", mode: "queue" });
  assert.ok(result.ok && result.status === "delivered" && result.readmitted);
  assert.deepEqual(fake.sent, [{ threadId: mine.threadId, message: "continue", mode: "queue" }]);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.equal(listSlotHolders(db, "thr_parent").length, 1);
});

test("send to an idle child when the root is full waits as queued; it is delivered when the running child's turn completes (the active -> idle transition frees the slot)", async () => {
  const db = openDb();
  const fake = fakeHost();
  const runner = child(db, fake, "thr_parent", "active");
  const sleeper = child(db, fake, "thr_parent", "idle");
  const result = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: sleeper.delegationId, message: "later", mode: "queue" });
  assert.ok(result.ok && result.status === "queued");
  const inputId = result.ok && result.status === "queued" ? result.inputId : "";
  assert.deepEqual(fake.sent, [], "nothing reaches the child while the root is full");
  assert.equal(getPendingInput(db, inputId)?.state, "queued");
  assert.equal(getDelegation(db, sleeper.delegationId)?.state, "idle");

  // The runner's turn is still running (events end at seq 2 but SANDY shows it running): the input keeps waiting.
  secondTurn(db, fake, runner, false, 20_000);
  let report = await sweep(db, fake.host, ONE_SLOT, T0 + 30_000);
  assert.deepEqual([report.idled.length, fake.sent.length, getDelegation(db, runner.delegationId)?.state], [0, 0, "active"]);

  // Its turn completes and SANDY shows it idle: the sweep moves it to idle, then delivers to the sleeper.
  fake.turns.get(runner.threadId)!.push({ seq: 4, type: "completed", at: T0 + 40_000 });
  fake.statuses.set(runner.threadId, "idle");
  report = await sweep(db, fake.host, ONE_SLOT, T0 + 50_000);
  assert.deepEqual(report.idled.map((row) => row.delegationId), [runner.delegationId]);
  assert.deepEqual(fake.sent, [{ threadId: sleeper.threadId, message: "later", mode: "queue" }]);
  assert.deepEqual([getDelegation(db, runner.delegationId)?.state, getDelegation(db, sleeper.delegationId)?.state], ["idle", "active"]);
  assert.equal(getPendingInput(db, inputId)?.state, "delivered");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [sleeper.delegationId]);
});

test("queued inputs of a root are delivered in arrival order, one slot at a time, also to a child that already holds a slot", async () => {
  const db = openDb();
  const fake = fakeHost();
  const runner = child(db, fake, "thr_parent", "active");
  const a = child(db, fake, "thr_parent", "idle");
  const b = child(db, fake, "thr_parent", "idle");
  const send = (delegationId: string, message: string) => sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId, message, mode: "queue" });
  assert.ok((await send(a.delegationId, "first")).ok);
  assert.ok((await send(b.delegationId, "second")).ok);
  assert.ok((await send(a.delegationId, "third")).ok);
  fake.statuses.set(runner.threadId, "idle");
  secondTurn(db, fake, runner, true, 20_000);
  await sweep(db, fake.host, ONE_SLOT, T0 + 40_000);
  assert.deepEqual(fake.sent.map((entry) => entry.message), ["first"], "one slot: only the oldest input goes");
  // a's new turn completes: its slot frees; the next in line is b's input, then a's third waits behind it.
  fake.turns.set(a.threadId, [...fake.turns.get(a.threadId)!]);
  secondTurn(db, fake, a, true, 60_000);
  fake.statuses.set(a.threadId, "idle");
  await sweep(db, fake.host, ONE_SLOT, T0 + 80_000);
  assert.deepEqual(fake.sent.map((entry) => entry.message), ["first", "second"]);
  assert.deepEqual(nextQueued(db, "thr_parent")?.payload, { message: "third", mode: "queue" });
});

test("active -> idle: only a completed turn newer than the last delivered input, read to the end, with SANDY idle or error, frees the slot", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "active");
  const state = () => getDelegation(db, mine.delegationId)?.state;
  // SANDY still shows the thread running: stays active.
  await sweep(db, fake.host, ONE_SLOT, T0 + 20_000);
  assert.equal(state(), "active");
  // Idle, last event completed: idle.
  fake.statuses.set(mine.threadId, "idle");
  const report = await sweep(db, fake.host, ONE_SLOT, T0 + 21_000);
  assert.deepEqual(report.idled.map((row) => row.delegationId), [mine.delegationId]);
  assert.equal(state(), "idle");
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
});

test("active -> idle: a turn that completed before the last delivered input does not count; the new turn's completion does", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "active");
  // The old turn is done (seq 2); the parent steers: idle_after_seq = 2. SANDY is idle already (the new turn has not started yet).
  fake.statuses.set(mine.threadId, "idle");
  const sent = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "again", mode: "steer" });
  assert.ok(sent.ok);
  fake.statuses.set(mine.threadId, "idle");
  await sweep(db, fake.host, ONE_SLOT, T0 + 20_000);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active", "seq 2 is not after idle_after_seq 2");
  secondTurn(db, fake, mine, true, 30_000);
  const report = await sweep(db, fake.host, ONE_SLOT, T0 + 50_000);
  assert.deepEqual(report.idled.map((row) => row.delegationId), [mine.delegationId]);
});

test("active -> idle: an error status (a failed turn) also frees the slot; a turn still open does not", async () => {
  const db = openDb();
  const fake = fakeHost();
  const failed = child(db, fake, "thr_parent", "active");
  fake.statuses.set(failed.threadId, "error");
  await sweep(db, fake.host, ONE_SLOT, T0 + 20_000);
  assert.equal(getDelegation(db, failed.delegationId)?.state, "idle");
  const open = child(db, fake, "thr_parent", "active");
  secondTurn(db, fake, open, false, 30_000);
  fake.statuses.set(open.threadId, "idle");
  await sweep(db, fake.host, ONE_SLOT, T0 + 40_000);
  assert.equal(getDelegation(db, open.delegationId)?.state, "active", "last event is a turn/started");
});

test("stop one: the row is stopped, SANDY stop is called, and the slot is held until SANDY confirms the stop", async () => {
  const db = openDb();
  const fake = fakeHost({ statusAfterStop: "running" });
  const mine = child(db, fake, "thr_parent");
  const result = await stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId }, T0 + 20_000);
  assert.ok(result.ok);
  assert.deepEqual(fake.stops, [mine.threadId]);
  assert.deepEqual(result.ok && result.stopped.map(({ delegationId, state, stopConfirmed }) => ({ delegationId, state, stopConfirmed })), [{ delegationId: mine.delegationId, state: "stopped", stopConfirmed: false }]);
  assert.equal(getStopRequest(db, mine.threadId)?.reason, "parent_stop");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [mine.delegationId], "unconfirmed: still holds its slot");
  // SANDY now shows it stopped: the next sweep confirms and frees the slot.
  fake.statuses.set(mine.threadId, "idle");
  const report = await sweep(db, fake.host, ONE_SLOT, T0 + 20_000 + 10 * WINDOW);
  assert.deepEqual(report.stopped, [mine.threadId]);
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
});

test("stop confirmed at once frees the slot and a queued input of another child is delivered after it", async () => {
  const db = openDb();
  const fake = fakeHost();
  const runner = child(db, fake, "thr_parent", "active");
  const sleeper = child(db, fake, "thr_parent", "idle");
  assert.ok((await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: sleeper.delegationId, message: "go", mode: "steer" })).ok);
  assert.deepEqual(fake.sent, []);
  const result = await stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: runner.delegationId }, T0 + 20_000);
  assert.ok(result.ok && result.stopped[0].stopConfirmed);
  assert.deepEqual(fake.sent, [{ threadId: sleeper.threadId, message: "go", mode: "steer" }]);
});

test("stop all stops every not ended child of the caller, cancels their queued inputs, and leaves another parent's children alone", async () => {
  const db = openDb();
  const fake = fakeHost();
  const a = child(db, fake, "thr_parent", "active");
  const b = child(db, fake, "thr_parent", "idle");
  const ended = child(db, fake, "thr_parent", "active");
  assert.ok(transition(db, ended.delegationId, "stopped").ok);
  const other = child(db, fake, "thr_other", "active");
  const runner = child(db, fake, "thr_parent", "active");
  assert.ok((await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: b.delegationId, message: "q", mode: "queue" })).ok);
  const queuedId = nextQueued(db, "thr_parent")!.inputId;
  const result = await stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", all: true }, T0 + 20_000);
  assert.ok(result.ok);
  assert.deepEqual([...fake.stops].sort(), [a.threadId, b.threadId, runner.threadId].sort());
  assert.deepEqual(result.ok && result.stopped.map((entry) => entry.state), ["stopped", "stopped", "stopped"]);
  assert.equal(getPendingInput(db, queuedId)?.state, "cancelled");
  assert.equal(getDelegation(db, other.delegationId)?.state, "active");
  assert.equal(listSlotHolders(db, "thr_other").length, 1);
});

test("the parent's own stop leaves its children running: a sweep with the parent stopped issues no stop, the rows stay active", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "active");
  fake.statuses.set("thr_parent", "idle");
  const report = await sweep(db, fake.host, TWO_SLOTS, T0 + 20_000 + 10 * WINDOW);
  assert.deepEqual([fake.stops, report.stopped, report.refused, report.released], [[], [], [], []]);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.equal(getStopRequest(db, mine.threadId), null);
  assert.equal(fake.statuses.get(mine.threadId), "running");
});

test("send failures: 404 ends the delegation as error, another 4xx drops the input and frees the slot, a transient failure keeps the slot until DELIVERY_SETTLE_MS shows no turn took it, then the input is queued again and delivered", async () => {
  const gone = Object.assign(new Error("thread not found"), { status: 404 });
  const dbA = openDb();
  const a = child(dbA, fakeHost(), "thr_parent", "idle");
  const fakeA = fakeHost({ sendError: gone });
  const resultA = await sendToDelegation(dbA, fakeA.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: a.delegationId, message: "x", mode: "steer" });
  assert.ok(!resultA.ok && resultA.refusal.code === "send_failed");
  assert.equal(getDelegation(dbA, a.delegationId)?.state, "error");

  const dbB = openDb();
  const b = child(dbB, fakeHost(), "thr_parent", "idle");
  const fakeB = fakeHost({ sendError: Object.assign(new Error("bad request"), { status: 400 }) });
  const resultB = await sendToDelegation(dbB, fakeB.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: b.delegationId, message: "x", mode: "steer" });
  assert.ok(!resultB.ok && resultB.refusal.code === "send_failed");
  assert.equal(getDelegation(dbB, b.delegationId)?.state, "idle");
  assert.equal(listSlotHolders(dbB, "thr_parent").length, 0);

  // Transient: the delivery is unknown and keeps the slot; with no turn of the child above its watermark
  // within DELIVERY_SETTLE_MS and SANDY idle it is lost, the input is queued again and the same drain sends it.
  const dbC = openDb();
  const fakeC = fakeHost({ sendFailures: 1 });
  const runner = child(dbC, fakeC, "thr_parent", "active");
  const c = child(dbC, fakeC, "thr_parent", "idle");
  assert.ok((await sendToDelegation(dbC, fakeC.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: c.delegationId, message: "x", mode: "queue" })).ok);
  fakeC.statuses.set(runner.threadId, "idle");
  assert.ok(transition(dbC, runner.delegationId, "idle").ok);
  const first = await drainQueues(dbC, fakeC.host, ONE_SLOT, T0 + 30_000);
  assert.equal(first.delivered.length, 0);
  assert.equal(getDelegation(dbC, c.delegationId)?.state, "reserved", "the slot is kept while the outcome is open");
  assert.equal(getPendingInput(dbC, first.failures[0]!.subject)?.state, "delivering");
  const early = await drainQueues(dbC, fakeC.host, ONE_SLOT, T0 + 30_000 + DELIVERY_SETTLE_MS - 1);
  assert.equal(early.delivered.length, 0);
  assert.equal(getDelegation(dbC, c.delegationId)?.state, "reserved");
  const second = await drainQueues(dbC, fakeC.host, ONE_SLOT, T0 + 30_000 + DELIVERY_SETTLE_MS);
  assert.equal(second.delivered.length, 1);
  assert.equal(getDelegation(dbC, c.delegationId)?.state, "active");
  assert.deepEqual(fakeC.sent.map((entry) => entry.message), ["x"]);
});

// SANDY's thread send takes no idempotency key (plugin SDK 0.6.79): a process that dies between SANDY taking a
// message and the ledger recording it leaves a "sending" delivery. A turn above its watermark settles it
// without a resend; none within DELIVERY_SETTLE_MS (SANDY idle) sends it again: at least once.
test("crash after SANDY took a queued input: its turn settles it without a resend; with no turn within DELIVERY_SETTLE_MS it is sent again", async () => {
  for (const turnStarted of [true, false]) {
    const db = openDb();
    const fake = fakeHost();
    const mine = child(db, fake, "thr_parent", "idle");
    const queued = await sendToDelegation(db, fake.host, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 0 }, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "m", mode: "queue" });
    assert.ok(queued.ok && queued.status === "queued");
    // The lost process: admitted, claimed (watermark seq 2), SANDY's send went out, then the process died.
    const admitted = admitNextQueued(db, "thr_parent", ONE_SLOT, T0 + 20_000)!;
    const claim = claimDelivery(db, { delegationId: mine.delegationId, inputId: admitted.pendingInput.inputId, reservationOwner: admitted.reservationOwner, afterSeq: 2 }, T0 + 20_000);
    assert.ok(claim.ok);
    if (turnStarted) {
      nextTurn(db, fake, mine, 2, 3, false, 21_000);
      fake.statuses.set(mine.threadId, "running");
      const report = await drainQueues(db, fake.host, ONE_SLOT, T0 + 22_000);
      assert.deepEqual(report.delivered, [admitted.pendingInput.inputId]);
      assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
      assert.equal(getPendingInput(db, admitted.pendingInput.inputId)?.state, "delivered");
      assert.deepEqual(fake.sent, [], "no resend");
    } else {
      const early = await drainQueues(db, fake.host, ONE_SLOT, T0 + 20_000 + DELIVERY_SETTLE_MS - 1);
      assert.deepEqual([early.delivered, fake.sent], [[], []], "the slot is held, nothing is sent inside the window");
      assert.equal(getDelegation(db, mine.delegationId)?.state, "reserved");
      const report = await drainQueues(db, fake.host, ONE_SLOT, T0 + 20_000 + DELIVERY_SETTLE_MS);
      assert.deepEqual(report.delivered, [admitted.pendingInput.inputId]);
      assert.deepEqual(fake.sent.map((entry) => entry.message), ["m"], "sent again once");
      assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
      assert.equal(getPendingInput(db, admitted.pendingInput.inputId)?.state, "delivered");
    }
  }
});

test("an admitted input whose delivery this process lost (restart) is delivered again by the next drain; one in flight is not", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  const sentInput = await sendToDelegation(db, fake.host, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 0 }, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "m", mode: "steer" });
  assert.ok(sentInput.ok && sentInput.status === "queued");
  const admittedByLostProcess = (await import("../server/ledger.ts")).admitNextQueued(db, "thr_parent", ONE_SLOT)!;
  assert.equal(getDelegation(db, mine.delegationId)?.state, "reserved");
  fake.host.deliveriesInFlight.add(mine.delegationId);
  assert.equal((await drainQueues(db, fake.host, ONE_SLOT, T0 + 30_000)).delivered.length, 0);
  fake.host.deliveriesInFlight.delete(mine.delegationId);
  const report = await drainQueues(db, fake.host, ONE_SLOT, T0 + 31_000);
  assert.deepEqual(report.delivered, [admittedByLostProcess.pendingInput.inputId]);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.equal(getPendingInput(db, admittedByLostProcess.pendingInput.inputId)?.state, "delivered");
  assert.deepEqual(claimDelivery(db, { delegationId: mine.delegationId, inputId: admittedByLostProcess.pendingInput.inputId, reservationOwner: null, afterSeq: null }), { ok: false, reason: "input_taken" });
});

test("a bound row left reserved past the window with nothing in flight is settled from SANDY's status", async () => {
  const db = openDb();
  const fake = fakeHost();
  const running = child(db, fake, "thr_parent", "idle");
  const resting = child(db, fake, "thr_parent", "idle");
  const { readmit } = await import("../server/ledger.ts");
  for (const entry of [running, resting]) assert.ok(readmit(db, { delegationId: entry.delegationId, input: { kind: "steer", payload: null } }, TWO_SLOTS, T0 + 1_000).ok);
  fake.statuses.set(running.threadId, "running");
  fake.statuses.set(resting.threadId, "idle");
  await drainQueues(db, fake.host, TWO_SLOTS, T0 + 1_000 + WINDOW - 1);
  assert.deepEqual([getDelegation(db, running.delegationId)?.state, getDelegation(db, resting.delegationId)?.state], ["reserved", "reserved"]);
  const report = await drainQueues(db, fake.host, TWO_SLOTS, T0 + 1_000 + WINDOW + 1);
  assert.deepEqual(report.settled.sort(), [running.delegationId, resting.delegationId].sort());
  assert.deepEqual([getDelegation(db, running.delegationId)?.state, getDelegation(db, resting.delegationId)?.state], ["active", "idle"]);
});

// Interleavings (review of slice 10). Each pauses one SANDY call of the fake and runs another control
// operation while it waits.

test("send vs stop: a send in flight when the stop comes reaches SANDY before the stop, a send behind the stop never does; the child stays stopped", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  const pause = pausePoint();
  fake.hooks.latestTurnEvents = pause.hook;
  const first = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "first", mode: "queue" });
  await pause.reached;
  const stopping = stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId }, T0 + 20_000);
  await settle();
  const second = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "second", mode: "steer" });
  pause.release();
  const [sentFirst, stopped, sentSecond] = await Promise.all([first, stopping, second]);
  assert.deepEqual(fake.calls, ["send " + mine.threadId, "stop " + mine.threadId], "the stop comes after the send it waited for");
  assert.ok(sentFirst.ok && sentFirst.status === "delivered");
  assert.ok(!sentSecond.ok && sentSecond.refusal.code === "delegation_ended");
  assert.ok(stopped.ok && stopped.stopped[0].stopConfirmed);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "stopped");
  assert.equal(fake.statuses.get(mine.threadId), "idle");
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
});

test("send vs refusal: a send that lands after its row ended and the stop was confirmed requests the stop again", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "active");
  const pause = pausePoint();
  fake.hooks.send = pause.hook;
  const sending = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "more", mode: "steer" });
  await pause.reached;
  // The row ends while SANDY has the send (a refusal of the sweep, which takes no lock) and SANDY confirms that stop.
  assert.ok(stopDelegation(db, mine.delegationId, T0 + 20_000) !== null);
  markStopConfirmed(db, mine.threadId, T0 + 20_001);
  pause.release();
  await sending;
  assert.equal(getStopRequest(db, mine.threadId)?.stoppedAt, null, "the stop is open again");
  await sweep(db, fake.host, ONE_SLOT, T0 + 30_000);
  assert.deepEqual(fake.calls, ["send " + mine.threadId, "stop " + mine.threadId]);
  assert.notEqual(getStopRequest(db, mine.threadId)?.stoppedAt, null);
});

test("idle vs send: a sweep that read SANDY idle before a send does not free the slot of the child the send started", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "active");
  fake.statuses.set(mine.threadId, "idle");
  const pause = pausePoint(mine.threadId);
  fake.hooks.threadState = pause.hook;
  const sweeping = sweep(db, fake.host, ONE_SLOT, T0 + 20_000);
  await pause.reached;
  const sending = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "go on", mode: "queue" });
  await settle();
  pause.release();
  const [, sent] = await Promise.all([sweeping, sending]);
  assert.ok(sent.ok && sent.status === "delivered");
  assert.equal(fake.statuses.get(mine.threadId), "running");
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [mine.delegationId]);
});

test("a message SANDY queued behind the running turn: that turn's completion does not free the slot, the completion of the turn that took the message does", async () => {
  const db = openDb();
  const fake = fakeHost({ delivery: "queued" });
  const mine = child(db, fake, "thr_parent", "active");
  secondTurn(db, fake, mine, false, 20_000);
  const sent = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "after this", mode: "queue" });
  assert.ok(sent.ok && sent.status === "delivered" && sent.sandyDelivery === "queued");
  // The running turn completes; SANDY shows the thread idle before it starts the queued message.
  fake.turns.get(mine.threadId)!.push({ seq: 4, type: "completed", at: T0 + 30_000 });
  fake.statuses.set(mine.threadId, "idle");
  let report = await sweep(db, fake.host, ONE_SLOT, T0 + 40_000);
  assert.deepEqual(report.idled, []);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  // The queued message's turn runs and completes.
  nextTurn(db, fake, mine, 3, 5, true, 50_000);
  report = await sweep(db, fake.host, ONE_SLOT, T0 + 60_000);
  assert.deepEqual(report.idled.map((row) => row.delegationId), [mine.delegationId]);
});

test("send failures: a send whose outcome SANDY left open (timeout) keeps the slot; the child's next turn settles it as delivered", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  fake.hooks.send = () => { fake.hooks.send = undefined; throw new Error("socket timeout"); };
  const result = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "x", mode: "queue" });
  assert.ok(!result.ok && result.refusal.code === "delivery_unconfirmed");
  assert.equal(getDelegation(db, mine.delegationId)?.state, "reserved");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [mine.delegationId], "the slot is held");
  // SANDY had taken it: the child's turn starts above the send's watermark.
  nextTurn(db, fake, mine, 2, 3, false, 20_000);
  fake.statuses.set(mine.threadId, "running");
  await drainQueues(db, fake.host, ONE_SLOT, T0 + 25_000);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
});

test("send failures: a failing send does not undo the reservation of another send to the same child", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  const pause = pausePoint();
  fake.hooks.latestTurnEvents = pause.hook;
  fake.hooks.send = (_threadId, message) => { if (message === "b") throw Object.assign(new Error("bad request"), { status: 400 }); };
  const a = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "a", mode: "queue" });
  await pause.reached;
  const b = sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "b", mode: "steer" });
  await settle();
  pause.release();
  const [sentA, sentB] = await Promise.all([a, b]);
  assert.ok(sentA.ok && sentA.status === "delivered");
  assert.ok(!sentB.ok && sentB.refusal.code === "send_failed");
  assert.deepEqual(fake.sent.map((entry) => entry.message), ["a"]);
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [mine.delegationId]);
});

test("two drains at once deliver each admitted input once", async () => {
  const db = openDb();
  const fake = fakeHost();
  const a = child(db, fake, "thr_parent", "idle");
  const b = child(db, fake, "thr_parent", "idle");
  const closed = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 0 };
  for (const [entry, message] of [[a, "for a"], [b, "for b"]] as const) {
    const queued = await sendToDelegation(db, fake.host, closed, { callerThreadId: "thr_parent", delegationId: entry.delegationId, message, mode: "queue" });
    assert.ok(queued.ok && queued.status === "queued");
  }
  // A process that died after admitting both left them admitted.
  assert.ok(admitNextQueued(db, "thr_parent", TWO_SLOTS) !== null);
  assert.ok(admitNextQueued(db, "thr_parent", TWO_SLOTS) !== null);
  const pause = pausePoint(a.threadId);
  fake.hooks.send = pause.hook;
  const first = drainQueues(db, fake.host, TWO_SLOTS, T0 + 30_000);
  await pause.reached;
  const second = drainQueues(db, fake.host, TWO_SLOTS, T0 + 30_001);
  await settle();
  pause.release();
  await Promise.all([first, second]);
  assert.deepEqual(fake.sent.map((entry) => entry.message).sort(), ["for a", "for b"]);
  assert.deepEqual([getDelegation(db, a.delegationId)?.state, getDelegation(db, b.delegationId)?.state], ["active", "active"]);
});


// Slot accounting after sends SANDY left without an answer (fix check of slice 10).

const holders = (db: Db) => listSlotHolders(db, "thr_parent").map((row) => row.delegationId);

test("send timeout, then a confirmed stop: the open delivery keeps the slot; SANDY taking the message late opens the stop again, and the slot frees only when that stop is confirmed", async () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  fake.hooks.send = () => { fake.hooks.send = undefined; throw new Error("socket timeout"); };
  const sent = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "x", mode: "queue" }, T0 + 20_000);
  assert.ok(!sent.ok && sent.refusal.code === "delivery_unconfirmed");
  const stopped = await stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId }, T0 + 21_000);
  assert.ok(stopped.ok && stopped.stopped[0].stopConfirmed);
  assert.deepEqual(holders(db), [mine.delegationId], "the delivery is open: SANDY may still start the message");
  const other = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "late" }, ONE_SLOT, T0 + 22_000);
  assert.ok(!other.ok && other.refusal.code === "limit_reached");
  // SANDY took the message after all: a turn of the (stopped) child starts above the send's watermark.
  fake.turns.get(mine.threadId)!.push({ seq: 3, type: "started", at: T0 + 23_000 });
  fake.statuses.set(mine.threadId, "running");
  await drainQueues(db, fake.host, ONE_SLOT, T0 + 24_000);
  assert.equal(getStopRequest(db, mine.threadId)?.stoppedAt, null, "the stop is open again");
  assert.deepEqual(holders(db), [mine.delegationId]);
  await sweep(db, fake.host, ONE_SLOT, T0 + 25_000);
  assert.notEqual(getStopRequest(db, mine.threadId)?.stoppedAt, null);
  assert.deepEqual(fake.stops, [mine.threadId, mine.threadId]);
  assert.deepEqual(holders(db), []);
});

test("a message SANDY queued behind the running turn keeps the child active through later sends: after a rejected send or a steer into that turn, its completion still does not free the slot", async () => {
  for (const later of ["rejected", "steered"] as const) {
    const db = openDb();
    const options: Options = { delivery: "queued" };
    const fake = fakeHost(options);
    const mine = child(db, fake, "thr_parent", "active");
    secondTurn(db, fake, mine, false, 20_000);
    const send = (message: string, mode: SendMode) => sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message, mode });
    const queued = await send("a", "queue");
    assert.ok(queued.ok && queued.status === "delivered" && queued.sandyDelivery === "queued");
    if (later === "rejected") fake.hooks.send = (_threadId, message) => { if (message === "b") throw Object.assign(new Error("bad request"), { status: 400 }); };
    else options.delivery = "sent";
    const next = await send("b", later === "rejected" ? "queue" : "steer");
    assert.equal(next.ok, later === "steered", later);
    // The running turn completes; SANDY shows the thread idle before it starts the queued message a.
    fake.turns.get(mine.threadId)!.push({ seq: 4, type: "completed", at: T0 + 30_000 });
    fake.statuses.set(mine.threadId, "idle");
    let report = await sweep(db, fake.host, ONE_SLOT, T0 + 40_000);
    assert.deepEqual(report.idled, [], later);
    assert.equal(getDelegation(db, mine.delegationId)?.state, "active", later);
    // a's turn runs and completes.
    nextTurn(db, fake, mine, 3, 5, true, 50_000);
    report = await sweep(db, fake.host, ONE_SLOT, T0 + 60_000);
    assert.deepEqual(report.idled.map((row) => row.delegationId), [mine.delegationId], later);
    assert.deepEqual(holders(db), [], later);
  }
});

test("staggered send timeouts on a re-admitted child: the first one's loss does not undo the reservation while the second is open; the slot is held until the second settles", async () => {
  for (const second of ["sent", "lost"] as const) {
    const db = openDb();
    const fake = fakeHost();
    const mine = child(db, fake, "thr_parent", "idle");
    fake.hooks.send = () => { throw new Error("socket timeout"); };
    const at = T0 + 20_000;
    const send = (message: string, now: number) => sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message, mode: "queue" }, now);
    const a = await send("a", at);
    assert.ok(!a.ok && a.refusal.code === "delivery_unconfirmed");
    const b = await send("b", at + 9 * 60_000);
    assert.ok(!b.ok && b.refusal.code === "delivery_unconfirmed");
    fake.hooks.send = undefined;
    // a is lost (no turn within DELIVERY_SETTLE_MS, SANDY idle); b is one minute old.
    await drainQueues(db, fake.host, ONE_SLOT, at + DELIVERY_SETTLE_MS);
    assert.equal(getDelegation(db, mine.delegationId)?.state, "reserved", second);
    assert.deepEqual(holders(db), [mine.delegationId], second);
    if (second === "sent") {
      nextTurn(db, fake, mine, 2, 3, false, 20_000 + DELIVERY_SETTLE_MS + 1_000);
      fake.statuses.set(mine.threadId, "running");
      await drainQueues(db, fake.host, ONE_SLOT, at + DELIVERY_SETTLE_MS + 2_000);
      assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
      assert.deepEqual(holders(db), [mine.delegationId]);
    } else {
      await drainQueues(db, fake.host, ONE_SLOT, at + 9 * 60_000 + DELIVERY_SETTLE_MS);
      assert.equal(getDelegation(db, mine.delegationId)?.state, "idle");
      assert.deepEqual(holders(db), []);
    }
  }
});

test("settleDelivery: a late sent settlement on a row that went idle while the delivery was open makes it active again", () => {
  const db = openDb();
  const fake = fakeHost();
  const mine = child(db, fake, "thr_parent", "idle");
  const admitted = readmit(db, { delegationId: mine.delegationId, input: { kind: "steer", payload: null } }, ONE_SLOT, T0 + 20_000);
  assert.ok(admitted.ok && admitted.status === "admitted");
  const claim = claimDelivery(db, { delegationId: mine.delegationId, inputId: null, reservationOwner: admitted.reservationOwner, afterSeq: 2 }, T0 + 20_000);
  assert.ok(claim.ok);
  assert.ok(settleDelivery(db, claim.delivery.deliveryId, "unknown", T0 + 20_001));
  assert.ok(moveReservedToIdle(db, mine.delegationId, admitted.reservationOwner, T0 + 30_000));
  assert.ok(settleDelivery(db, claim.delivery.deliveryId, "sent", T0 + 40_000));
  assert.equal(getDelegation(db, mine.delegationId)?.state, "active");
});

test("a message SANDY queued behind a turn and never started: after a confirmed stop it keeps the slot until DELIVERY_SETTLE_MS after the completion of the turn it waited for, with SANDY not running; then it is closed as lost, logged, and not sent again", async () => {
  const db = openDb();
  const fake = fakeHost({ delivery: "queued" });
  const mine = child(db, fake, "thr_parent", "active");
  secondTurn(db, fake, mine, false, 20_000);
  const sent = await sendToDelegation(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId, message: "after this", mode: "queue" }, T0 + 21_000);
  assert.ok(sent.ok && sent.status === "delivered" && sent.sandyDelivery === "queued");
  // The turn it waited for runs longer than the settle window.
  const completedAt = T0 + 21_000 + 15 * 60_000;
  fake.turns.get(mine.threadId)!.push({ seq: 4, type: "completed", at: completedAt });
  fake.statuses.set(mine.threadId, "idle");
  const stopped = await stopDelegations(db, fake.host, ONE_SLOT, { callerThreadId: "thr_parent", delegationId: mine.delegationId }, completedAt + 60_000);
  assert.ok(stopped.ok && stopped.stopped[0].stopConfirmed);
  assert.deepEqual(holders(db), [mine.delegationId], "SANDY may still start the queued message");
  await drainQueues(db, fake.host, ONE_SLOT, completedAt + DELIVERY_SETTLE_MS - 1);
  assert.deepEqual(holders(db), [mine.delegationId], "the window runs from the completion, not from the send");
  assert.deepEqual(fake.warnings, []);
  await drainQueues(db, fake.host, ONE_SLOT, completedAt + DELIVERY_SETTLE_MS);
  assert.deepEqual(holders(db), []);
  assert.equal(fake.warnings.length, 1);
  assert.match(fake.warnings[0]!, new RegExp(mine.delegationId + ".*lost"));
  assert.deepEqual(fake.sent.map((entry) => entry.message), ["after this"]);
});
