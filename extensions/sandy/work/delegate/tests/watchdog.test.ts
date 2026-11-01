import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, claimDelivery, getDelivery, getDelegation, getDelegationByChild, getStopRequest, markWaitSilenced, getTurnCursor, listSlotHolders, readmit, STOP_RETRY_CAP_MS, stopRetryDelayMs, transition } from "../server/ledger.ts";
import { migrations } from "../server/migrations.ts";
import { askQuestion, listQuestionsOfEndedDelegations } from "../server/questions.ts";
import { seedBuiltinAgents } from "../server/catalog.ts";
import { formatDelegationTable, listDelegations } from "../server/list.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { delegateToolsFor, deliverBrief, issuePolicy, recordAck, storeBrief, type PolicyAnswer } from "../server/protocol.ts";
import { delegate, type LaunchHost } from "../server/launch.ts";
import {
  advanceTurns, markerMissing, SPAWN_SETTLE_MS, sweepWatchdog, TURN_EVENT_PAGE, TURN_SCAN_BUDGET, TURN_SCAN_PRIORITY_SHARE, turnRefusalBoundMs,
  watchdogTickMs, watchdogWindowMs,
  type SpawnCandidate, type SweepReport, type TurnEvent, type WatchdogHost,
} from "../server/watchdog.ts";

type Db = ReturnType<typeof openDb>;

const WINDOW = 120_000;
const T0 = 1_800_000_000_000;

const PLUGIN = "delegate";

type FakeOptions = {
  // The parent's threads naming a delegation in their metadata; a parent missing here is not listed (null).
  candidates?: Record<string, SpawnCandidate[]>;
  // Throw on every stop call.
  failStops?: boolean;
  // The status a thread has after a resolved stop call (default idle).
  statusAfterStop?: string;
  // When each thread's first turn started; a thread missing here has not started a turn.
  turnStarts?: Record<string, number>;
  // Each thread's turn/started and turn/completed events (shared, so a test can append turns); none when missing.
  turns?: Record<string, TurnEvent[]>;
  // Threads whose turn event listings throw (shared, so a test can add threads).
  failListings?: Set<string>;
  // Threads whose parentNotifications update throws, with the HTTP status of the error.
  failFlips?: Map<string, number>;
};

// A SANDY stand-in for the sweep: spawn candidates per parent, thread statuses, the stop calls it received,
// its turn event listings, and the order of stops and listings (calls).
function fakeWatchdogHost(options: FakeOptions = {}) {
  const stops: string[] = [];
  const listings: { threadId: string; afterSeq: number | null; limit: number }[] = [];
  const calls: string[] = [];
  const statuses = new Map<string, string>();
  const notifications: { threadId: string; mode: string }[] = [];
  const waiting = new Set<string>();
  const host: WatchdogHost = {
    waitInFlight: (delegationId) => waiting.has(delegationId),
    setParentNotifications: async (threadId, mode) => {
      if (options.failFlips?.has(threadId)) throw Object.assign(new Error("sandy refused the update"), { status: options.failFlips.get(threadId) });
      notifications.push({ threadId, mode });
    },
    pluginId: PLUGIN,
    spawnCandidates: async (parentThreadId, delegationId) =>
      options.candidates === undefined ? [] : (options.candidates[parentThreadId]?.filter((entry) => entry.metadata.delegationId === delegationId) ?? null),
    spawnInFlight: () => false,
    stop: async (threadId) => {
      stops.push(threadId);
      calls.push(`stop ${threadId}`);
      if (options.failStops) throw new Error("sandy refused the stop");
      statuses.set(threadId, options.statusAfterStop ?? "idle");
    },
    threadState: async (threadId) => ({ status: statuses.get(threadId) ?? "active", archived: false }),
    firstTurnStartedAt: async (threadId) => options.turnStarts?.[threadId] ?? null,
    turnEventsAfter: async (threadId, afterSeq, limit) => {
      listings.push({ threadId, afterSeq, limit });
      calls.push(`turns ${threadId}`);
      if (options.failListings?.has(threadId)) throw new Error("sandy listing failed");
      const events = [...(options.turns?.[threadId] ?? [])].sort((a, b) => a.seq - b.seq);
      return events.filter((event) => afterSeq === null || event.seq > afterSeq).slice(0, limit);
    },
    latestTurnEvents: async (threadId, count) => {
      calls.push(`latest ${threadId}`);
      if (options.failListings?.has(threadId)) throw new Error("sandy listing failed");
      return [...(options.turns?.[threadId] ?? [])].sort((a, b) => a.seq - b.seq).slice(-count);
    },
  };
  return { host, stops, statuses, listings, calls, notifications, waiting };
}

// A thread this plugin spawned under thr_parent at T0 + 500 ms, naming the delegation.
const ownSpawn = (threadId: string, delegationId: string, overrides: Partial<SpawnCandidate> = {}): SpawnCandidate => ({
  threadId, parentThreadId: "thr_parent", originPluginId: PLUGIN, createdAt: T0 + 500, metadata: { delegationId }, ...overrides,
});

const reserve = (db: Db, now = T0) => {
  const result = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, now);
  assert.ok(result.ok);
  storeBrief(db, result.delegation.delegationId, "find the config loader", "[delegate-test] scout", now);
  return result.delegation.delegationId;
};

// Reserved at T0, bound to thr_child at T0 + 1 s, policy issued at T0 + 2 s.
const spawned = (db: Db) => {
  const delegationId = reserve(db);
  assert.ok(bindChild(db, delegationId, "thr_child", T0 + 1_000).ok);
  const answer = issuePolicy(db, "thr_child", {}, T0 + 2_000) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.equal(answer.status, "ok");
  const ack = { threadId: "thr_child", delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn: 1 };
  return { delegationId, ack };
};

const emptyReport = { refused: [], unmarked: [], turnUnacked: [], bound: [], released: [], kept: [], stopped: [], restored: [], idled: [], deleted: [], failures: [] };

test("watchdogWindowMs / watchdogTickMs: seconds to ms with the default for bad values; tick a tenth of the window in 1-5 s", () => {
  assert.equal(watchdogWindowMs({ briefWatchdogSeconds: 20 }), 20_000);
  for (const bad of [0, -5, Number.NaN]) assert.equal(watchdogWindowMs({ briefWatchdogSeconds: bad }), 120_000);
  assert.deepEqual([watchdogTickMs(5_000), watchdogTickMs(20_000), watchdogTickMs(120_000)], [1_000, 2_000, 5_000]);
});

test("watchdog: every sweep, the startup pass too, sets a wait-mode child with no wait in this process back to auto; a waited-on or async child is left alone", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 1_000 + WINDOW - 1).ok);
  markWaitSilenced(db, delegationId, T0);
  const asyncId = reserve(db, T0 + 10);
  assert.ok(bindChild(db, asyncId, "thr_async", T0 + 1_100).ok);
  const turns = { thr_child: [{ seq: 1, type: "started" as const, at: T0 + 1_500 }], thr_async: [{ seq: 1, type: "started" as const, at: T0 + 1_500 }] };
  const waited = fakeWatchdogHost({ turns });
  waited.waiting.add(delegationId);
  const first = await sweepWatchdog(db, waited.host, WINDOW, T0 + 5_000, { startup: true });
  assert.deepEqual(waited.notifications, [], "a wait in flight keeps the child off; the async child is never touched");
  assert.deepEqual(first.restored, []);
  const fresh = fakeWatchdogHost({ turns });
  const second = await sweepWatchdog(db, fresh.host, WINDOW, T0 + 6_000, { startup: true });
  assert.deepEqual(fresh.notifications, [{ threadId: "thr_child", mode: "auto" }]);
  assert.deepEqual(second.restored, ["thr_child"]);
  await sweepWatchdog(db, fresh.host, WINDOW, T0 + 7_000);
  assert.equal(fresh.notifications.length, 1, "confirmed once, not flipped again");
});

test("watchdog: an ack within the window leaves the delegation untouched; the brief is delivered, nothing is stopped", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 1_000 + WINDOW - 1).ok);
  const { host, stops } = fakeWatchdogHost();
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 10 * WINDOW), emptyReport);
  assert.equal(getDelegation(db, delegationId)?.state, "active");
  assert.equal(deliverBrief(db, "thr_child").ok, true);
  assert.deepEqual(stops, []);
});

test("watchdog: no ack within the window -> refused, slot freed, child stopped, brief withheld; a later ack revives nothing", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  const { host, stops } = fakeWatchdogHost();
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 1_000 + WINDOW - 1), emptyReport, "not overdue one ms before the deadline");
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 1_000 + WINDOW);
  assert.deepEqual(report.refused.map((row) => row.delegationId), [delegationId]);
  assert.deepEqual(stops, ["thr_child"]);
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  assert.deepEqual(listSlotHolders(db, "thr_parent"), []);
  assert.equal(getStopRequest(db, "thr_child")?.reason, "no_ack");
  assert.notEqual(getStopRequest(db, "thr_child")?.stoppedAt, null);
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "not_a_delegate");
  // The late ack: refused, the row stays refused and the brief stays locked.
  assert.equal((recordAck(db, ack, WINDOW, T0 + 1_000 + WINDOW + 5) as { code: string }).code, "delegation_ended");
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "not_a_delegate");
  assert.equal(issuePolicy(db, "thr_child", {}).status, "denied");
  // A later sweep does not stop it again.
  await sweepWatchdog(db, host, WINDOW, T0 + 5 * WINDOW);
  assert.deepEqual(stops, ["thr_child"]);
});

test("watchdog: a late ack that arrives before the sweep is refused itself and refuses the delegation; the sweep then stops the child", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  const late = recordAck(db, ack, WINDOW, T0 + 1_000 + WINDOW);
  assert.equal((late as { code: string }).code, "ack_too_late");
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "not_a_delegate");
  const { host, stops } = fakeWatchdogHost();
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 1_000 + WINDOW + 1);
  assert.deepEqual(report.refused, [], "already refused by the ack");
  assert.deepEqual(stops, ["thr_child"]);
});

test("watchdog: queued inputs of a refused delegation are cancelled", async () => {
  const db = openDb();
  const { delegationId } = spawned(db);
  const other = reserve(db, T0);
  assert.ok(bindChild(db, other, "thr_idle", T0).ok);
  assert.ok(transition(db, other, "idle", T0).ok);
  // Fill the root so an input for the idle child queues, then move it to the refused row by hand.
  const queued = readmit(db, { delegationId: other, input: { kind: "queue", payload: "x" } }, { maxConcurrentChildren: 1 }, T0);
  assert.ok(queued.ok && queued.status === "queued");
  db.prepare("UPDATE pending_inputs SET delegation_id = ? WHERE input_id = ?").run(delegationId, queued.pendingInput.inputId);
  await sweepWatchdog(db, fakeWatchdogHost().host, WINDOW, T0 + 1_000 + WINDOW);
  assert.equal((db.prepare("SELECT state FROM pending_inputs WHERE input_id = ?").get(queued.pendingInput.inputId) as { state: string }).state, "cancelled");
});

test("watchdog: an expired reservation with its one proven spawn under the parent is bound and then watched", async () => {
  const db = openDb();
  const delegationId = reserve(db);
  const { host, stops } = fakeWatchdogHost({
    candidates: { thr_parent: [ownSpawn("thr_foreign", "dlg_other"), ownSpawn("thr_found", delegationId)] },
  });
  const inFlight = await sweepWatchdog(db, { ...host, spawnInFlight: (id) => id === delegationId }, WINDOW, T0 + WINDOW - 1);
  assert.deepEqual(inFlight.kept, [{ delegationId, reason: "its spawn is still in flight" }], "a reservation whose spawn is in flight is left to it");
  const found = await sweepWatchdog(db, host, WINDOW, T0 + WINDOW);
  assert.deepEqual(found.bound, [{ delegationId, childThreadId: "thr_found" }]);
  assert.deepEqual(stops, []);
  const row = getDelegation(db, delegationId)!;
  assert.deepEqual([row.state, row.childThreadId, row.boundAt], ["starting", "thr_found", T0 + WINDOW]);
  // Bound now, it gets its own window from the bind; without an ack it is refused and stopped.
  await sweepWatchdog(db, host, WINDOW, T0 + 2 * WINDOW - 1);
  assert.equal(getDelegation(db, delegationId)?.state, "starting");
  await sweepWatchdog(db, host, WINDOW, T0 + 2 * WINDOW);
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  assert.deepEqual(stops, ["thr_found"]);
});

test("watchdog: copied metadata grants nothing: a thread not spawned by this plugin, not a direct child, or older than the reservation is neither bound nor stopped", async () => {
  for (const [label, overrides] of [
    ["spawned by the user", { originPluginId: null }],
    ["spawned by another plugin", { originPluginId: "other-plugin" }],
    ["a grandchild", { parentThreadId: "thr_mid" }],
    ["created before the reservation", { createdAt: T0 - 1 }],
  ] as const) {
    const db = openDb();
    const delegationId = reserve(db);
    const { host, stops } = fakeWatchdogHost({ candidates: { thr_parent: [ownSpawn("thr_sibling", delegationId, overrides)] } });
    const report = await sweepWatchdog(db, host, WINDOW, T0 + SPAWN_SETTLE_MS);
    assert.deepEqual(report.bound, [], label);
    assert.deepEqual(report.released, [delegationId], `${label}: no proven spawn, released`);
    assert.equal(getDelegationByChild(db, "thr_sibling"), null, label);
    assert.deepEqual(stops, [], label);
    assert.equal(getStopRequest(db, "thr_sibling"), null, label);
  }
});

test("watchdog: a sibling that parents its own delegates is never bound to a reservation, even with copied metadata", async () => {
  const db = openDb();
  const delegationId = reserve(db);
  // thr_sibling called sandy_delegate itself: it is a parent in the ledger, so it is no delegate.
  const own = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_sibling", kind: "delegate", agent: "scout", inputHash: "h2" }, DEFAULT_SETTINGS, T0);
  assert.ok(own.ok);
  assert.ok(bindChild(db, own.delegation.delegationId, "thr_grandchild", T0).ok);
  assert.ok(transition(db, own.delegation.delegationId, "active", T0).ok);
  const { host, stops } = fakeWatchdogHost({ candidates: { thr_parent: [ownSpawn("thr_sibling", delegationId)] } });
  const report = await sweepWatchdog(db, host, WINDOW, T0 + WINDOW);
  assert.deepEqual(report.bound, []);
  assert.equal(getDelegationByChild(db, "thr_sibling"), null);
  assert.deepEqual(stops, []);
});

test("watchdog: two plugin-spawned threads naming one reservation: kept with its slot, nothing bound, nothing stopped", async () => {
  const db = openDb();
  const delegationId = reserve(db);
  const { host, stops } = fakeWatchdogHost({ candidates: { thr_parent: [ownSpawn("thr_a", delegationId), ownSpawn("thr_b", delegationId)] } });
  const report = await sweepWatchdog(db, host, WINDOW, T0 + WINDOW);
  assert.deepEqual(report.bound, []);
  assert.deepEqual(report.released, []);
  assert.equal(report.kept.length, 1);
  assert.match(report.kept[0].reason, /ambiguous: 2 threads .*thr_a, thr_b/);
  assert.deepEqual(stops, []);
  assert.deepEqual([getStopRequest(db, "thr_a"), getStopRequest(db, "thr_b")], [null, null]);
  const row = getDelegation(db, delegationId)!;
  assert.deepEqual([row.state, row.childThreadId], ["reserved", null]);
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((holder) => holder.delegationId), [delegationId]);
});

test("watchdog: an expired reservation is released only on a positively empty listing after SPAWN_SETTLE_MS; a failing or unlisted parent, a spawn in flight, or a younger row keeps it", async () => {
  const db = openDb();
  const delegationId = reserve(db);
  const settled = T0 + SPAWN_SETTLE_MS;
  const failing: WatchdogHost = { ...fakeWatchdogHost().host, spawnCandidates: async () => { throw new Error("sandy unreachable"); } };
  const failed = await sweepWatchdog(db, failing, WINDOW, settled);
  assert.deepEqual(failed.failures, [{ subject: delegationId, error: "sandy unreachable" }]);
  assert.equal(getDelegation(db, delegationId)?.state, "reserved");
  const unlisted = await sweepWatchdog(db, fakeWatchdogHost({ candidates: {} }).host, WINDOW, settled);
  assert.deepEqual(unlisted.kept, [{ delegationId, reason: "SANDY does not list its parent thr_parent" }]);
  assert.equal(getDelegation(db, delegationId)?.state, "reserved");
  const inFlight = await sweepWatchdog(db, { ...fakeWatchdogHost().host, spawnInFlight: (id) => id === delegationId }, WINDOW, settled);
  assert.deepEqual(inFlight.kept, [{ delegationId, reason: "its spawn is still in flight" }]);
  assert.equal(getDelegation(db, delegationId)?.state, "reserved");
  const { host, stops } = fakeWatchdogHost({ candidates: { thr_parent: [] } });
  for (const now of [T0 + WINDOW, settled - 1]) {
    const young = await sweepWatchdog(db, host, WINDOW, now);
    assert.deepEqual([young.released, young.kept], [[], [{ delegationId, reason: "spawn outcome unknown" }]], `kept at ${now - T0} ms`);
    assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [delegationId], "the slot stays held");
  }
  const report = await sweepWatchdog(db, host, WINDOW, settled);
  assert.deepEqual(report.released, [delegationId]);
  assert.equal(getDelegation(db, delegationId)?.state, "error");
  assert.deepEqual(listSlotHolders(db, "thr_parent"), []);
  assert.deepEqual(stops, []);
});

test("watchdog: a resolved stop whose thread stays stopping is not confirmed: the request stays open and is retried until SANDY shows it stopped", async () => {
  const db = openDb();
  const { delegationId } = spawned(db);
  const { host, stops, statuses } = fakeWatchdogHost({ statusAfterStop: "stopping" });
  const deadline = T0 + 1_000 + WINDOW;
  const first = await sweepWatchdog(db, host, WINDOW, deadline);
  assert.deepEqual(first.stopped, []);
  assert.deepEqual(first.failures, [{ subject: "thr_child", error: "stop not confirmed: thread is stopping" }]);
  let request = getStopRequest(db, "thr_child")!;
  assert.deepEqual([request.stoppedAt, request.attempts, request.lastError, request.nextAttemptAt], [null, 1, "stop not confirmed: thread is stopping", deadline + 1_000]);
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [delegationId], "the slot stays held");
  await sweepWatchdog(db, host, WINDOW, deadline + 999);
  assert.deepEqual(stops, ["thr_child"], "backed off");
  await sweepWatchdog(db, host, WINDOW, deadline + 1_000);
  assert.deepEqual(stops, ["thr_child", "thr_child"], "retried");
  assert.equal(getStopRequest(db, "thr_child")?.attempts, 2);
  // The machine confirms the interrupt: the next stop leaves the thread idle.
  statuses.set("thr_child", "idle");
  const confirming = { ...host, stop: async (threadId: string) => { stops.push(threadId); } };
  const last = await sweepWatchdog(db, confirming, WINDOW, deadline + 3_000);
  assert.deepEqual(last.stopped, ["thr_child"]);
  request = getStopRequest(db, "thr_child")!;
  assert.deepEqual([request.stoppedAt, request.attempts, request.lastError], [deadline + 3_000, 3, null]);
  assert.deepEqual(listSlotHolders(db, "thr_parent"), []);
});

test("watchdog: a stop is confirmed when SANDY no longer has the thread, or the stop succeeded and the thread is idle or errored; archived is no confirmation", async () => {
  for (const [label, state, confirmed] of [
    ["gone", null, true],
    ["idle", { status: "idle", archived: false }, true],
    ["archived idle", { status: "idle", archived: true }, true],
    ["error", { status: "error", archived: false }, true],
    ["active", { status: "active", archived: false }, false],
    ["pending", { status: "pending", archived: false }, false],
    ["archived active", { status: "active", archived: true }, false],
    ["archived stopping", { status: "stopping", archived: true }, false],
  ] as const) {
    const db = openDb();
    const { delegationId } = spawned(db);
    const { host, stops } = fakeWatchdogHost();
    const stateHost: WatchdogHost = { ...host, threadState: async () => state };
    const deadline = T0 + 1_000 + WINDOW;
    const report = await sweepWatchdog(db, stateHost, WINDOW, deadline);
    assert.equal(report.stopped.length === 1, confirmed, label);
    assert.equal(getStopRequest(db, "thr_child")?.stoppedAt !== null, confirmed, label);
    assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), confirmed ? [] : [delegationId], `${label}: slot`);
    if (confirmed) continue;
    assert.equal(getStopRequest(db, "thr_child")?.lastError, `stop not confirmed: thread is ${state!.status}${state!.archived ? " (archived)" : ""}`, label);
    await sweepWatchdog(db, stateHost, WINDOW, getStopRequest(db, "thr_child")!.nextAttemptAt!);
    assert.deepEqual([stops, getStopRequest(db, "thr_child")?.stoppedAt], [["thr_child", "thr_child"], null], `${label}: retried, still open`);
  }
});

test("stopRetryDelayMs: doubles from 1 s, capped at the window and at 5 min", () => {
  assert.deepEqual([1, 2, 3, 10].map((attempts) => stopRetryDelayMs(attempts, WINDOW)), [1_000, 2_000, 4_000, WINDOW]);
  assert.equal(stopRetryDelayMs(10, 3_600_000), STOP_RETRY_CAP_MS);
  assert.equal(stopRetryDelayMs(1_000, 3_600_000), STOP_RETRY_CAP_MS);
});

test("watchdog: a stop is never given up: ten failures, a DB reopen, then success; attempts and the last error show in sandy work delegate list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandy-delegate-watchdog-"));
  try {
    const file = join(dir, "data.db");
    const before = openDb(file);
    const { delegationId } = spawned(before);
    const failing = fakeWatchdogHost({ failStops: true });
    let now = T0 + 1_000 + WINDOW;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const report = await sweepWatchdog(before, failing.host, WINDOW, now);
      assert.deepEqual(report.failures, [{ subject: "thr_child", error: "sandy refused the stop" }], `attempt ${attempt}`);
      now = getStopRequest(before, "thr_child")!.nextAttemptAt!;
    }
    assert.equal(failing.stops.length, 10);
    const request = getStopRequest(before, "thr_child")!;
    assert.deepEqual([request.stoppedAt, request.attempts, request.lastError], [null, 10, "sandy refused the stop"]);
    const [entry] = listDelegations(before, { limit: 10 });
    assert.deepEqual(entry.stop, { threadId: "thr_child", reason: "no_ack", stoppedAt: null, attempts: 10, lastError: "sandy refused the stop" });
    assert.match(formatDelegationTable([entry]), /pending \(10 attempts: sandy refused the stop\)/);
    before.close();

    const after = openDb(file, { migrate: false });
    const { host, stops } = fakeWatchdogHost();
    assert.deepEqual((await sweepWatchdog(after, host, WINDOW, now - 1)).stopped, [], "the backoff survives the reopen");
    const report = await sweepWatchdog(after, host, WINDOW, now);
    assert.deepEqual([report.stopped, stops], [["thr_child"], ["thr_child"]]);
    assert.equal(getStopRequest(after, "thr_child")?.attempts, 11);
    assert.equal(getDelegation(after, delegationId)?.state, "refused");
    assert.match(formatDelegationTable(listDelegations(after, { limit: 10 })), /refused.*\sstopped\s/);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: a refused child holds its root's slot until its stop is confirmed; ack and brief stay denied meanwhile", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  const limit = { maxConcurrentChildren: 1 };
  const failing = fakeWatchdogHost({ failStops: true });
  await sweepWatchdog(db, failing.host, WINDOW, T0 + 1_000 + WINDOW);
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  const request = { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate" as const, agent: "scout", inputHash: "h-next" };
  const blocked = admit(db, request, limit, T0 + 1_000 + WINDOW + 1);
  assert.equal(!blocked.ok && blocked.refusal.code, "limit_reached");
  assert.deepEqual(!blocked.ok && blocked.refusal.code === "limit_reached" && blocked.refusal.running.map((row) => row.delegationId), [delegationId]);
  assert.equal((recordAck(db, ack, WINDOW, T0 + 1_000 + WINDOW + 1) as { code: string }).code, "delegation_ended");
  assert.equal((deliverBrief(db, "thr_child") as { code: string }).code, "not_a_delegate");
  // Still unconfirmed (stopping) after a resolved stop: still held.
  await sweepWatchdog(db, fakeWatchdogHost({ statusAfterStop: "stopping" }).host, WINDOW, T0 + 1_000 + WINDOW + 1_000);
  assert.equal(!admit(db, request, limit, T0 + 1_000 + WINDOW + 1_001).ok, true);
  await sweepWatchdog(db, fakeWatchdogHost().host, WINDOW, T0 + 1_000 + WINDOW + 3_000);
  assert.notEqual(getStopRequest(db, "thr_child")?.stoppedAt, null);
  assert.ok(admit(db, request, limit, T0 + 1_000 + WINDOW + 3_001).ok, "the slot frees after confirmation");
});

test("watchdog: a restart (new DB handle, new sweep) still refuses an overdue delegation and retries an open stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandy-delegate-watchdog-"));
  try {
    const file = join(dir, "data.db");
    const before = openDb(file);
    const { delegationId: overdue } = spawned(before);
    // The sweep before the restart: nothing due yet; its stop of another refused child fails.
    const other = reserve(before, T0);
    assert.ok(bindChild(before, other, "thr_other", T0).ok);
    const failingSweep = fakeWatchdogHost({ failStops: true });
    const first = await sweepWatchdog(before, failingSweep.host, WINDOW, T0 + WINDOW);
    assert.deepEqual(first.refused.map((row) => row.delegationId), [other]);
    assert.equal(first.failures[0].subject, "thr_other");
    assert.equal(getDelegation(before, overdue)?.state, "starting");
    before.close();

    const after = openDb(file, { migrate: false });
    const { host, stops } = fakeWatchdogHost();
    const report = await sweepWatchdog(after, host, WINDOW, T0 + 1_000 + WINDOW);
    assert.deepEqual(report.refused.map((row) => row.delegationId), [overdue]);
    assert.deepEqual(stops.sort(), ["thr_child", "thr_other"]);
    assert.equal(getStopRequest(after, "thr_other")?.attempts, 2);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The spawn of sandy_delegate racing the sweep's reconciliation of its reservation.
function launchHost(db: Db, duringSpawn: (childId: string) => Promise<void>): LaunchHost {
  return {
    piProvider: async () => ({ available: true, permissionModes: ["full"] }),
    thread: async (threadId) => ({ id: threadId, projectId: "proj_test", environmentId: "env_parent" }),
    rootOf: async (threadId) => threadId,
    permissionModeOf: async () => "full",
    environment: async () => ({ hostId: "host_test", isGitRepo: true, branchName: "feature" }),
    project: async () => null,
    spawn: async () => {
      await duringSpawn("thr_slow");
      return { id: "thr_slow" };
    },
    spawnsInFlight: new Set(),
    bindDelayMs: async () => 0,
    sleep: async () => {},
  };
}

const lastDelegationId = (db: Db) => (db.prepare("SELECT delegation_id AS id FROM delegations ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;

test("watchdog vs. a slow spawn: a sweep that does not know the spawn (another plugin process) keeps the reservation and its slot inside SPAWN_SETTLE_MS; the launch then binds normally", async () => {
  const db = openDb();
  const settings = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 1 };
  const { host, stops } = fakeWatchdogHost();
  let swept: SweepReport | undefined;
  let replacement: ReturnType<typeof admit> | undefined;
  const result = await delegate(db, launchHost(db, async () => {
    const now = Date.now() + WINDOW;
    swept = await sweepWatchdog(db, host, WINDOW, now);
    replacement = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "h-replacement" }, settings, now);
  }), "thr_parent", { agent: "scout", task: "t", mode: "async" }, settings);
  assert.ok(result.ok);
  assert.deepEqual(swept?.kept, [{ delegationId: result.launched.delegationId, reason: "spawn outcome unknown" }]);
  assert.deepEqual(swept?.released, []);
  assert.equal(replacement?.ok === false && replacement.refusal.code, "limit_reached", "no replacement admission while it is reserved");
  assert.deepEqual([result.launched.threadId, getDelegation(db, result.launched.delegationId)?.state], ["thr_slow", "starting"]);
  assert.equal(getStopRequest(db, "thr_slow"), null);
  assert.deepEqual(stops, []);
});

test("watchdog vs. a slow spawn: a reservation released after SPAWN_SETTLE_MS on an empty listing gets its late thread stopped, not bound", async () => {
  const db = openDb();
  const { host, stops } = fakeWatchdogHost();
  let swept: SweepReport | undefined;
  const result = await delegate(db, launchHost(db, async () => { swept = await sweepWatchdog(db, host, WINDOW, Date.now() + SPAWN_SETTLE_MS); }), "thr_parent",
    { agent: "scout", task: "t", mode: "async" }, DEFAULT_SETTINGS);
  assert.deepEqual(swept?.released, [lastDelegationId(db)]);
  assert.equal(!result.ok && result.refusal.code, "bind_failed");
  assert.equal(getDelegation(db, lastDelegationId(db))?.state, "error");
  assert.equal(getStopRequest(db, "thr_slow")?.reason, "unbound_spawn");
  await sweepWatchdog(db, host, WINDOW);
  assert.deepEqual(stops, ["thr_slow"]);
});

test("watchdog vs. a slow spawn: a reservation the sweep bound to the spawned thread is a successful launch", async () => {
  const db = openDb();
  let sweepAt = 0;
  const result = await delegate(db, launchHost(db, async (childId) => {
    const { host } = fakeWatchdogHost({ candidates: { thr_parent: [ownSpawn(childId, lastDelegationId(db), { createdAt: Date.now() })] } });
    sweepAt = Date.now() + WINDOW;
    await sweepWatchdog(db, host, WINDOW, sweepAt);
  }), "thr_parent", { agent: "scout", task: "t", mode: "async" }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.deepEqual([result.launched.threadId, result.launched.status], ["thr_slow", "starting"]);
  assert.equal(getDelegation(db, result.launched.delegationId)?.boundAt, sweepAt, "bound by the sweep, not by the spawn");
  assert.equal(getStopRequest(db, "thr_slow"), null);
});

test("markerMissing: unmarked when a turn started and the marker was never granted or granted after the first turn start", () => {
  assert.equal(markerMissing(null, null), false, "no turn yet: left to the ack window");
  assert.equal(markerMissing(T0, null), false);
  assert.equal(markerMissing(T0, T0 + 1), false, "marked before its first turn");
  assert.equal(markerMissing(T0, T0), false);
  assert.equal(markerMissing(null, T0), true, "never marked");
  assert.equal(markerMissing(T0 + 1, T0), true, "marked only after its first turn started");
});

// The previous plugin process: sandy_delegate admitted the call (clientRequestId r1) and SANDY spawned
// thr_spawned under thr_parent; marked: whether agents.configure gave it the marker then. The process
// died during the bind delay, before bindChild. Returns the DB file, the reserved row and the spawn count.
async function lostSpawn(dir: string, marked: boolean) {
  const file = join(dir, "data.db");
  const db = openDb(file);
  const spawns = { count: 0 };
  const dying: LaunchHost = {
    ...launchHost(db, async () => {}),
    spawn: async (request) => {
      spawns.count++;
      if (marked) delegateToolsFor(db, "thr_spawned", request.pluginMetadata, Date.now());
      return { id: "thr_spawned" };
    },
    bindDelayMs: async () => 20_000,
    sleep: async () => { throw new Error("plugin reloaded"); },
  };
  await assert.rejects(delegate(db, dying, "thr_parent", { agent: "scout", task: "t", mode: "async", clientRequestId: "r1" }, DEFAULT_SETTINGS), /plugin reloaded/);
  const row = getDelegation(db, lastDelegationId(db))!;
  assert.deepEqual([row.state, row.childThreadId], ["reserved", null]);
  db.close();
  return { file, row, spawns };
}

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "sandy-delegate-reconcile-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("startup reconcile: a restart between spawn and bind binds exactly the one spawned child inside the window; it is gated and a retry does not spawn again", () => withDir(async (dir) => {
  const { file, row, spawns } = await lostSpawn(dir, true);
  const db = openDb(file, { migrate: false });
  const now = row.createdAt + 5_000;
  const { host, stops } = fakeWatchdogHost({
    candidates: { thr_parent: [ownSpawn("thr_spawned", row.delegationId, { createdAt: row.createdAt + 50 })] },
    turnStarts: { thr_spawned: row.createdAt + 1_000 },
  });
  const report = await sweepWatchdog(db, host, WINDOW, now, { startup: true });
  assert.deepEqual(report.bound, [{ delegationId: row.delegationId, childThreadId: "thr_spawned" }]);
  assert.deepEqual([report.unmarked, report.kept, report.released], [[], [], []]);
  assert.deepEqual(stops, []);
  assert.deepEqual([getDelegation(db, row.delegationId)?.state, getDelegation(db, row.delegationId)?.childThreadId], ["starting", "thr_spawned"]);
  // Gated: the marker, a policy and an ack that unlocks the brief.
  assert.deepEqual(delegateToolsFor(db, "thr_spawned", { delegationId: row.delegationId }), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  const answer = issuePolicy(db, "thr_spawned", { delegationId: row.delegationId }, now + 1);
  assert.equal(answer.status, "ok");
  const { policyHash, nonce } = answer as Extract<PolicyAnswer, { status: "ok" }>;
  assert.ok(recordAck(db, { threadId: "thr_spawned", delegationId: row.delegationId, policyHash, nonce, piSessionId: "pi-1", turn: 1 }, WINDOW, now + 2).ok);
  assert.equal(deliverBrief(db, "thr_spawned").ok, true);
  // The parent retries sandy_delegate: it gets the bound child, SANDY is not asked to spawn again.
  const retried = { ...launchHost(db, async () => {}), spawn: async () => { spawns.count++; return { id: "thr_second" }; } };
  const retry = await delegate(db, retried, "thr_parent", { agent: "scout", task: "t", mode: "async", clientRequestId: "r1" }, DEFAULT_SETTINGS);
  assert.ok(retry.ok && retry.launched.reused);
  assert.deepEqual([retry.launched.delegationId, retry.launched.threadId], [row.delegationId, "thr_spawned"]);
  assert.equal(spawns.count, 1);
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((holder) => holder.delegationId), [row.delegationId]);
  db.close();
}));

test("reconcile without a restart: a lost spawn result binds on the next ordinary sweep, long before the window (inside the extension's 30 s policy retry)", () => withDir(async (dir) => {
  const { file, row } = await lostSpawn(dir, true);
  const db = openDb(file, { migrate: false });
  const now = row.createdAt + 3_000;
  const { host, stops } = fakeWatchdogHost({
    candidates: { thr_parent: [ownSpawn("thr_spawned", row.delegationId, { createdAt: row.createdAt + 50 })] },
    turnStarts: { thr_spawned: row.createdAt + 1_000 },
  });
  assert.ok(now - row.createdAt < WINDOW);
  const report = await sweepWatchdog(db, host, WINDOW, now);
  assert.deepEqual(report.bound, [{ delegationId: row.delegationId, childThreadId: "thr_spawned" }]);
  assert.deepEqual(stops, []);
  assert.equal(issuePolicy(db, "thr_spawned", { delegationId: row.delegationId }, now + 1).status, "ok");
  db.close();
}));

test("startup reconcile: a restart finds the spawned child already running without the marker: refused and stopped, never repaired; the slot is held until the stop is confirmed", () => withDir(async (dir) => {
  const { file, row } = await lostSpawn(dir, false);
  const db = openDb(file, { migrate: false });
  const now = row.createdAt + 5_000;
  const options = {
    candidates: { thr_parent: [ownSpawn("thr_spawned", row.delegationId, { createdAt: row.createdAt + 50 })] },
    turnStarts: { thr_spawned: row.createdAt + 1_000 },
  };
  const failing = fakeWatchdogHost({ ...options, failStops: true });
  const report = await sweepWatchdog(db, failing.host, WINDOW, now, { startup: true });
  assert.deepEqual(report.bound, [{ delegationId: row.delegationId, childThreadId: "thr_spawned" }]);
  assert.deepEqual(report.unmarked.map((refused) => refused.delegationId), [row.delegationId]);
  assert.deepEqual(failing.stops, ["thr_spawned"]);
  assert.equal(getDelegation(db, row.delegationId)?.state, "refused");
  const request = getStopRequest(db, "thr_spawned")!;
  assert.deepEqual([request.reason, request.stoppedAt], ["unmarked", null]);
  // Not repaired: no policy, no brief.
  assert.equal(issuePolicy(db, "thr_spawned", { delegationId: row.delegationId }).status, "denied");
  assert.equal((deliverBrief(db, "thr_spawned") as { code: string }).code, "not_a_delegate");
  // The slot stays held while the stop is unconfirmed.
  const next = { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate" as const, agent: "scout", inputHash: "h-next" };
  const blocked = admit(db, next, { maxConcurrentChildren: 1 }, now + 1);
  assert.equal(!blocked.ok && blocked.refusal.code, "limit_reached");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((holder) => holder.delegationId), [row.delegationId]);
  const { host, stops } = fakeWatchdogHost(options);
  const confirmed = await sweepWatchdog(db, host, WINDOW, request.nextAttemptAt ?? now + 1_000);
  assert.deepEqual([confirmed.stopped, stops, confirmed.unmarked], [["thr_spawned"], ["thr_spawned"], []]);
  assert.deepEqual(listSlotHolders(db, "thr_parent"), []);
  assert.ok(admit(db, next, { maxConcurrentChildren: 1 }, now + 2_000).ok, "the slot frees after confirmation");
  db.close();
}));

test("startup reconcile: a foreign thread with copied metadata binds nothing and gets deny-all, at startup and after", () => withDir(async (dir) => {
  const { file, row } = await lostSpawn(dir, true);
  const db = openDb(file, { migrate: false });
  const now = row.createdAt + 5_000;
  const metadata = { delegationId: row.delegationId };
  const { host, stops } = fakeWatchdogHost({
    candidates: {
      thr_parent: [
        ownSpawn("thr_foreign", row.delegationId, { originPluginId: null, createdAt: row.createdAt + 20 }),
        ownSpawn("thr_spawned", row.delegationId, { createdAt: row.createdAt + 50 }),
      ],
    },
    turnStarts: { thr_foreign: row.createdAt + 30, thr_spawned: row.createdAt + 1_000 },
  });
  const report = await sweepWatchdog(db, host, WINDOW, now, { startup: true });
  assert.deepEqual(report.bound, [{ delegationId: row.delegationId, childThreadId: "thr_spawned" }]);
  assert.deepEqual([report.unmarked, report.kept, stops], [[], [], []]);
  assert.equal(getDelegationByChild(db, "thr_foreign"), null);
  assert.equal(getStopRequest(db, "thr_foreign"), null);
  // The foreign thread is gated by the marker and its gate gets deny-all, no nonce: it can never ack.
  assert.deepEqual(delegateToolsFor(db, "thr_foreign", metadata), ["sandy_delegate_brief", "sandy_ask_parent", "sandy_question_answer"]);
  const answer = issuePolicy(db, "thr_foreign", metadata);
  assert.equal(answer.status, "denied");
  assert.deepEqual([answer.policy.snapshotHash, answer.policy.allowTools, answer.policy.transportTools, (answer as { nonce: null }).nonce], ["deny-all", [], [], null]);
  assert.equal((recordAck(db, { threadId: "thr_foreign", delegationId: row.delegationId, policyHash: "x", nonce: "nonce_guess", piSessionId: "pi-x", turn: 1 }, WINDOW, now) as { code: string }).code, "unknown_nonce");
  assert.equal((deliverBrief(db, "thr_foreign") as { code: string }).code, "not_a_delegate");
  db.close();
}));

test("startup reconcile: two plugin-spawned threads naming one reservation (both running unmarked): kept with its slot, nothing bound, nothing stopped", () => withDir(async (dir) => {
  const { file, row } = await lostSpawn(dir, false);
  const db = openDb(file, { migrate: false });
  const { host, stops } = fakeWatchdogHost({
    candidates: { thr_parent: [ownSpawn("thr_a", row.delegationId, { createdAt: row.createdAt + 50 }), ownSpawn("thr_b", row.delegationId, { createdAt: row.createdAt + 60 })] },
    turnStarts: { thr_a: row.createdAt + 1_000, thr_b: row.createdAt + 1_000 },
  });
  const report = await sweepWatchdog(db, host, WINDOW, row.createdAt + 5_000, { startup: true });
  assert.deepEqual([report.bound, report.unmarked, report.released, report.stopped], [[], [], [], []]);
  assert.equal(report.kept.length, 1);
  assert.match(report.kept[0].reason, /ambiguous: 2 threads .*thr_a, thr_b/);
  assert.deepEqual(stops, []);
  assert.deepEqual([getStopRequest(db, "thr_a"), getStopRequest(db, "thr_b")], [null, null]);
  assert.deepEqual([getDelegation(db, row.delegationId)?.state, getDelegation(db, row.delegationId)?.childThreadId], ["reserved", null]);
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((holder) => holder.delegationId), [row.delegationId]);
  db.close();
}));

test("watchdog: a child bound by its own launch whose first turn started without the marker is refused at the next sweep, inside the window", async () => {
  const db = openDb();
  const delegationId = reserve(db);
  assert.ok(bindChild(db, delegationId, "thr_child", T0 + 1_000).ok);
  const { host, stops } = fakeWatchdogHost({ turnStarts: { thr_child: T0 + 1_500 } });
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 2_000);
  assert.deepEqual([report.unmarked.map((refused) => refused.delegationId), stops], [[delegationId], ["thr_child"]]);
  assert.equal(getStopRequest(db, "thr_child")?.reason, "unmarked");
  // A marked child (granted before its turn) and an acked child are left alone.
  const marked = reserve(db, T0);
  assert.ok(bindChild(db, marked, "thr_marked", T0 + 1_000).ok);
  delegateToolsFor(db, "thr_marked", {}, T0 + 1_100);
  const { host: markedHost, stops: markedStops } = fakeWatchdogHost({ turnStarts: { thr_marked: T0 + 1_500 } });
  assert.deepEqual((await sweepWatchdog(db, markedHost, WINDOW, T0 + 3_000)).unmarked, []);
  assert.deepEqual(markedStops, []);
});


// The turn rule. spawned(): bound T0 + 1 s, turn 1 acked at T0 + 3 s (pi-1, turn 1), turn 1 runs T0 + 2.5 s .. T0 + 10 s.
const turnStart = (seq: number, at: number): TurnEvent => ({ seq, type: "started", at });
const turnEnd = (seq: number, at: number): TurnEvent => ({ seq, type: "completed", at });

// Fetches a fresh policy at issuedAt and acks its nonce at ackedAt, as the extension does at a turn start.
const ackTurn = (db: Db, delegationId: string, piSessionId: string, turn: number, issuedAt: number, ackedAt = issuedAt) => {
  const answer = issuePolicy(db, "thr_child", {}, issuedAt) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.equal(answer.status, "ok");
  const request = { threadId: "thr_child", delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId, turn };
  assert.ok(recordAck(db, request, WINDOW, ackedAt).ok);
  return request;
};

const firstTurn = (db: Db) => {
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok);
  return { delegationId, turns: [turnStart(1, T0 + 2_500), turnEnd(2, T0 + 10_000)] };
};

const acksAt = (...times: number[]) => times.map((ackedAt, index) => ({ nonce: `n${index}`, ackedAt }));
const NO_TURN = { checkedSeq: null, lastAt: null, open: null };
const missingSeqs = (events: TurnEvent[], acks: number[], windowMs: number, now: number) => {
  const scan = advanceTurns(NO_TURN, events, acksAt(...acks), windowMs, now, true);
  return scan.missing === null ? null : scan.missing.seq;
};

test("advanceTurns: an ack after the previous turn event and by min(window, next turn event) counts, before or after the start", () => {
  const events = [turnStart(1, 100), turnEnd(2, 200), turnStart(3, 300), turnEnd(4, 400), turnStart(5, 500)];
  const all = advanceTurns(NO_TURN, events, acksAt(90, 250, 600), 1_000, 10_000, true);
  assert.deepEqual([all.missing, all.matches], [null, [{ nonce: "n0", turnSeq: 1 }, { nonce: "n1", turnSeq: 3 }, { nonce: "n2", turnSeq: 5 }]], "turn 1 acked before, turn 2 before, turn 3 after its start");
  assert.equal(missingSeqs(events, [90, 150], 1_000, 10_000), 3, "an ack inside turn 1 (before its turn/completed) does not cover turn 2");
  assert.equal(missingSeqs(events, [90, 250, 1_501], 1_000, 10_000), 5, "an ack past the window does not count");
  assert.equal(missingSeqs(events, [90, 250, 1_500], 1_000, 10_000), null, "an ack exactly at the deadline counts");
  assert.equal(missingSeqs(events, [90, 250], 1_000, 1_499), null, "a turn inside its window is not decided yet");
  assert.equal(missingSeqs(events, [90, 250], 1_000, 1_500), 5);
  assert.equal(missingSeqs([...events].reverse(), [90, 250], 1_000, 1_500), 5, "events are taken in seq order");
  assert.equal(missingSeqs(events, [90, 450, 600], 1_000, 10_000), 3, "an ack after turn 2's turn/completed is not turn 2's");
  const open = advanceTurns(NO_TURN, events, acksAt(90, 250), 1_000, 10_000, false);
  assert.deepEqual([open.missing, open.state.open], [null, { seq: 5, at: 500, lowerAt: 400 }], "with events left to read, the newest turn waits for them");
});

test("advanceTurns: one ack is one turn's; a later turn's ack does not repair an earlier unacked turn (review repro 1)", () => {
  const events = [turnStart(1, 1_000), turnEnd(2, 2_000), turnStart(3, 3_000), turnEnd(4, 4_000), turnStart(5, 5_000), turnEnd(6, 6_000)];
  assert.equal(missingSeqs(events, [900, 4_900], 120_000, 200_000), 3);
});

test("advanceTurns: a new turn/started without a completion between needs another ack; the earlier one does not cover it (review repro 2)", () => {
  assert.equal(missingSeqs([turnStart(1, 1_000), turnStart(2, 1_000_000)], [900], 120_000, 2_000_000), 2);
  assert.equal(missingSeqs([turnStart(1, 1_000), turnStart(2, 1_000_000)], [900, 1_000_500], 120_000, 2_000_000), null, "its own ack after the earlier start");
  const twice = advanceTurns(NO_TURN, [turnStart(1, 1_000), turnStart(2, 5_000)], acksAt(1_500), 120_000, 2_000_000, true);
  assert.deepEqual([twice.matches, twice.missing?.seq], [[{ nonce: "n0", turnSeq: 1 }], 2], "an ack in both ranges counts for the first turn only");
  const events = [turnStart(1, 100), turnEnd(2, 200), turnStart(3, 300), turnStart(5, 500)];
  assert.equal(missingSeqs(events, [90, 250, 280], 1_000, 10_000), 5, "the lower bound is the previous turn/started when that turn has no completion");
});

test("advanceTurns: continues from a stored state; turns closed by grandfatherThroughSeq take their acks but are not refused, an open one is checked", () => {
  const stored = { checkedSeq: 8, lastAt: 800, open: null };
  assert.deepEqual(advanceTurns(stored, [turnStart(5, 500), turnEnd(8, 800), turnStart(9, 900)], acksAt(850), 100, 2_000, true).matches, [{ nonce: "n0", turnSeq: 9 }], "seqs up to checkedSeq are skipped");
  const history = [turnStart(1, 100), turnEnd(2, 200), turnStart(3, 300), turnEnd(4, 400), turnStart(5, 500)];
  const grandfathered = advanceTurns(NO_TURN, history, acksAt(90, 450), 1_000, 10_000, true, 5);
  assert.deepEqual([grandfathered.matches, grandfathered.missing], [[{ nonce: "n0", turnSeq: 1 }, { nonce: "n1", turnSeq: 5 }], null], "turn seq 3 had no ack: grandfathered");
  assert.equal(advanceTurns(NO_TURN, history, acksAt(90), 1_000, 10_000, true, 5).missing?.seq, 5, "the turn open at the baseline is checked");
  assert.equal(advanceTurns(NO_TURN, [...history, turnEnd(6, 600)], acksAt(90), 1_000, 10_000, true, 5).missing?.seq, 5, "closed after the baseline: checked");
});

test("advanceTurns: an open baseline turn does not take the previous turn's ack (fix-check P1, Sol's case); its own ack 50 ms before it counts", () => {
  const events = [turnStart(1, 1_000), turnStart(2, 1_000_000)];
  const sol = advanceTurns(NO_TURN, events, acksAt(1_500), 120_000, 2_000_000, true, 2);
  assert.deepEqual([sol.matches, sol.missing?.seq], [[{ nonce: "n0", turnSeq: 1 }], 2]);
  const healthy = advanceTurns(NO_TURN, events, acksAt(950, 999_950), 120_000, 2_000_000, true, 2);
  assert.deepEqual([healthy.matches, healthy.missing], [[{ nonce: "n0", turnSeq: 1 }, { nonce: "n1", turnSeq: 2 }], null]);
});

test("turnRefusalBoundMs: window + listings (backlog pages + 1, + 1 for a pending baseline seq) * ceil(N / non-priority slots) * P", () => {
  assert.deepEqual([TURN_SCAN_BUDGET, TURN_SCAN_PRIORITY_SHARE, TURN_EVENT_PAGE], [10, 5, 100]);
  assert.equal(turnRefusalBoundMs(WINDOW, 11, 1_000, 3), WINDOW + 1 * 3 * 1_000);
  assert.equal(turnRefusalBoundMs(WINDOW, 10, 1_000, 99), WINDOW + 1 * 2 * 1_000);
  assert.equal(turnRefusalBoundMs(WINDOW, 10, 1_000, 100), WINDOW + 2 * 2 * 1_000, "a full page needs one more listing");
  assert.equal(turnRefusalBoundMs(WINDOW, 25, 5_000, 350, true), WINDOW + 5 * 5 * 5_000);
});

test("watchdog turn rule: 3 follow-up turns of a retained pi session, each acked (before or after its turn/started), refuse nothing", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  ackTurn(db, delegationId, "pi-1", 2, T0 + 20_000);
  turns.push(turnStart(3, T0 + 20_050), turnEnd(4, T0 + 30_000));
  turns.push(turnStart(5, T0 + 40_000), turnEnd(6, T0 + 50_000));
  ackTurn(db, delegationId, "pi-1", 3, T0 + 40_000, T0 + 45_000);
  ackTurn(db, delegationId, "pi-1", 4, T0 + 60_000);
  turns.push(turnStart(7, T0 + 60_010), turnEnd(8, T0 + 70_000));
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 70_000 + 2 * WINDOW), emptyReport);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["active", []]);
});

test("watchdog turn rule: resumes after release (new pi session each) that fetched a fresh policy and acked refuse nothing; the brief is not re-sent", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  assert.equal(deliverBrief(db, "thr_child", T0 + 4_000).ok, true);
  for (const [index, session] of ["pi-2", "pi-3", "pi-4"].entries()) {
    const startedAt = T0 + 400_000 * (index + 1);
    turns.push(turnStart(3 + 2 * index, startedAt));
    ackTurn(db, delegationId, session, 1, startedAt + 2_000);
    turns.push(turnEnd(4 + 2 * index, startedAt + 30_000));
    assert.equal((deliverBrief(db, "thr_child", startedAt + 3_000) as { code: string }).code, "already_delivered");
  }
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 2_000_000), emptyReport);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["active", []]);
});

test("watchdog turn rule: a turn with no ack within the window -> refused and stopped (turn_no_ack); the slot is held until the stop is confirmed", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  turns.push(turnStart(3, T0 + 400_000));
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns }, statusAfterStop: "active" });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + WINDOW - 1), emptyReport, "inside the window nothing happens");
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ delegation, turn }) => [delegation.delegationId, turn.seq]), [[delegationId, 3]]);
  assert.deepEqual(stops, ["thr_child"]);
  assert.equal(getDelegation(db, delegationId)?.state, "refused");
  assert.equal(getStopRequest(db, "thr_child")?.reason, "turn_no_ack");
  assert.deepEqual(listSlotHolders(db, "thr_parent").map((row) => row.delegationId), [delegationId], "the child still runs: its slot is held");
  assert.equal(issuePolicy(db, "thr_child", {}).status, "denied");
  // The stop takes effect: the next attempt confirms it and frees the slot.
  const { host: stoppingHost } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual((await sweepWatchdog(db, stoppingHost, WINDOW, T0 + 400_000 + 3 * WINDOW)).stopped, ["thr_child"]);
  assert.notEqual(getStopRequest(db, "thr_child")?.stoppedAt, null);
  assert.deepEqual(listSlotHolders(db, "thr_parent"), []);
});

test("watchdog turn rule: an ack from the previous turn (before its turn/completed) or a reused nonce from another pi session does not count", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  // A second ack inside turn 1, before its turn/completed at T0 + 10 s.
  const earlier = ackTurn(db, delegationId, "pi-1", 2, T0 + 9_000);
  turns.push(turnStart(3, T0 + 400_000));
  // A new pi session that echoes the earlier session's nonce instead of fetching a fresh policy.
  assert.equal((recordAck(db, { ...earlier, piSessionId: "pi-2", turn: 1 }, WINDOW, T0 + 401_000) as { code: string }).code, "nonce_used");
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [3]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

test("watchdog turn rule: an ack matched to a turn is stored with it and never counts again in a later sweep (review repro 2 on the ledger)", async () => {
  const db = openDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok, "acked after turn 1's turn/started");
  const turns = [turnStart(1, T0 + 2_500)];
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 2_500 + WINDOW), emptyReport);
  assert.deepEqual(db.prepare("SELECT turn_seq AS turnSeq FROM delegation_acks WHERE nonce = ?").get(ack.nonce), { turnSeq: 1 });
  // A resume with no turn/completed in between and no new ack: turn 1's ack lies in its range but is used up.
  turns.push(turnStart(2, T0 + 400_000));
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [2]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

test("watchdog turn rule: a later turn's ack does not repair an earlier unacked retained turn (review repro 1 on the ledger)", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  turns.push(turnStart(3, T0 + 20_000), turnEnd(4, T0 + 30_000));
  ackTurn(db, delegationId, "pi-1", 3, T0 + 39_900);
  turns.push(turnStart(5, T0 + 40_000), turnEnd(6, T0 + 50_000));
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 200_000);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [3]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

// A DB as slices 5-6 left it (migrations #1-#6), before the turn cursors of #7. The delegations columns of
// #9 and #10 and the delegation_deliveries table of #10 are added by hand (ledger reads select them; slot
// counting reads open deliveries): migrations #9 and #10 cannot run before #7.
const preTurnCursorDb = () => {
  const db = openDb(":memory:", { migrate: false });
  db.transaction(() => {
    for (const statement of migrations.slice(0, 6)) db.exec(statement);
    db.exec("ALTER TABLE delegations ADD COLUMN idle_after_seq INTEGER");
    db.exec("ALTER TABLE delegations ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE delegations ADD COLUMN reservation_owner TEXT");
    db.exec(migrations[9].split(";").slice(2, 5).join(";"));
  })();
  seedBuiltinAgents(db);
  return db;
};

// Migrations #7-#10 on a preTurnCursorDb: #7 and #8 as shipped, the cursor column of #9, and #10 without
// its two delegations columns and its delegation_deliveries table (already there).
const upgradeFromPreTurnCursor = (db: Db) => {
  db.exec(migrations[6]);
  db.exec(migrations[7]);
  db.exec("ALTER TABLE delegation_turn_cursors ADD COLUMN last_event_type TEXT");
  db.exec(migrations[9].split(";").slice(5).join(";"));
};

test("upgrade (#7): a child bound before it with several retained turns acked once (the old extension) is not refused; its fresh acked resume passes, a later unacked turn is refused", async () => {
  const db = preTurnCursorDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok);
  const turns = [turnStart(1, T0 + 2_500), turnEnd(2, T0 + 10_000), turnStart(3, T0 + 20_000), turnEnd(4, T0 + 30_000), turnStart(5, T0 + 40_000), turnEnd(6, T0 + 50_000)];
  upgradeFromPreTurnCursor(db);
  const { host, stops, calls } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 300_000), emptyReport);
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 301_000), emptyReport);
  assert.deepEqual(calls, ["latest thr_child", "turns thr_child"], "the baseline takes the newest seq, then reads the history once");
  assert.deepEqual([getTurnCursor(db, delegationId, "thr_child").enforceFromSeq, getTurnCursor(db, delegationId, "thr_child").baselinePending], [6, false]);
  turns.push(turnStart(7, T0 + 400_000));
  ackTurn(db, delegationId, "pi-2", 1, T0 + 402_000);
  turns.push(turnEnd(8, T0 + 430_000));
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + 2 * WINDOW), emptyReport);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["active", []]);
  turns.push(turnStart(9, T0 + 800_000));
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 800_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [9]);
  assert.deepEqual(stops, ["thr_child"]);
});

test("upgrade (#7): a turn still open at the baseline is checked: no ack in its range -> refused", async () => {
  const db = preTurnCursorDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok);
  upgradeFromPreTurnCursor(db);
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: [turnStart(1, T0 + 2_500), turnEnd(2, T0 + 10_000), turnStart(3, T0 + 20_000)] } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 20_000 + WINDOW), emptyReport, "the baseline's newest seq");
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 21_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [3]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

test("upgrade (#7): the previous turn's ack does not satisfy a turn open at the baseline (fix-check P1, Sol's case on the ledger)", async () => {
  const db = preTurnCursorDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok, "turn 1's ack, after its turn/started");
  upgradeFromPreTurnCursor(db);
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: [turnStart(1, T0 + 2_500), turnStart(2, T0 + 1_000_000)] } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 1_000_000 + WINDOW), emptyReport, "the baseline's newest seq");
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 1_001_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [2]);
  assert.deepEqual(db.prepare("SELECT turn_seq AS turnSeq FROM delegation_acks WHERE nonce = ?").get(ack.nonce), { turnSeq: 1 }, "grandfathered turn 1 took it");
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

test("upgrade (#7): a turn open at the baseline with its own ack 50 ms before it, after an acked turn 1, is not refused", async () => {
  const db = preTurnCursorDb();
  const { delegationId, ack } = spawned(db);
  assert.ok(recordAck(db, ack, WINDOW, T0 + 3_000).ok);
  ackTurn(db, delegationId, "pi-2", 1, T0 + 1_000_000 - 50);
  upgradeFromPreTurnCursor(db);
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: [turnStart(1, T0 + 2_500), turnStart(2, T0 + 1_000_000)] } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 1_000_000 + WINDOW), emptyReport);
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 1_001_000 + WINDOW), emptyReport);
  assert.deepEqual(db.prepare("SELECT turn_seq AS turnSeq FROM delegation_acks ORDER BY acked_at").all(), [{ turnSeq: 1 }, { turnSeq: 2 }]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["active", []]);
});

test("turn scan: each sweep lists a child's events once, after its cursor; a short page ends the read (no empty page), a full page is continued next sweep", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  const { host, listings } = fakeWatchdogHost({ turns: { thr_child: turns } });
  await sweepWatchdog(db, host, WINDOW, T0 + 11_000);
  await sweepWatchdog(db, host, WINDOW, T0 + 12_000);
  const page = (afterSeq: number | null) => ({ threadId: "thr_child", afterSeq, limit: TURN_EVENT_PAGE });
  assert.deepEqual(listings, [page(null), page(2)]);
  for (let index = 0; index < 75; index += 1) {
    const startedAt = T0 + 100_000 + index * 10_000;
    ackTurn(db, delegationId, "pi-1", index + 2, startedAt - 100);
    turns.push(turnStart(3 + 2 * index, startedAt), turnEnd(4 + 2 * index, startedAt + 5_000));
  }
  const now = T0 + 2_000_000;
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, now), emptyReport);
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, now + 1_000), emptyReport);
  await sweepWatchdog(db, host, WINDOW, now + 2_000);
  assert.deepEqual(listings.slice(2), [page(2), page(102), page(152)]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM delegation_acks WHERE turn_seq IS NOT NULL").get() as { n: number }).n, 76, "every turn matched one ack");
});

test("turn scan: a full page ending on a turn/started leaves that turn open until its next event is read (an ack after its turn/completed is not its)", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  let at = T0 + 100_000;
  ackTurn(db, delegationId, "pi-1", 2, at - 100);
  turns.push(turnStart(3, at));
  at += 10_000;
  ackTurn(db, delegationId, "pi-1", 3, at - 100);
  turns.push(turnStart(4, at), turnEnd(5, at + 5_000));
  for (let seq = 6; seq < 100; seq += 2) {
    at += 10_000;
    ackTurn(db, delegationId, "pi-1", seq, at - 100);
    turns.push(turnStart(seq, at), turnEnd(seq + 1, at + 5_000));
  }
  at += 10_000;
  ackTurn(db, delegationId, "pi-1", 100, at + 6_000);
  turns.push(turnStart(100, at), turnEnd(101, at + 5_000), turnStart(102, at + 7_000));
  const { host, listings } = fakeWatchdogHost({ turns: { thr_child: turns } });
  const now = at + 7_000 + WINDOW;
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, now), emptyReport, "seqs 1-100: turn 100 waits for its next event");
  const report = await sweepWatchdog(db, host, WINDOW, now + 1_000);
  assert.deepEqual([listings.map(({ afterSeq }) => afterSeq), report.turnUnacked.map(({ turn }) => turn.seq)], [[null, 100], [100]]);
});

test("turn scan: at most TURN_SCAN_BUDGET children per sweep, round robin over all; a child with a due open turn is read first", async () => {
  const db = openDb();
  const children = Array.from({ length: 25 }, (_, index) => `thr_c${index}`);
  for (const [index, child] of children.entries()) {
    const result = admit(db, { rootThreadId: `thr_p${index}`, callerThreadId: `thr_p${index}`, kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, T0);
    assert.ok(result.ok);
    assert.ok(bindChild(db, result.delegation.delegationId, child, child === "thr_c15" ? T0 + 1_000 : T0 + 60_000).ok);
    if (child !== "thr_c15") continue;
    const answer = issuePolicy(db, child, {}, T0 + 1_600) as Extract<PolicyAnswer, { status: "ok" }>;
    assert.ok(recordAck(db, { threadId: child, delegationId: result.delegation.delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn: 1 }, WINDOW, T0 + 1_600).ok);
  }
  const { host, listings } = fakeWatchdogHost({ turns: { thr_c15: [turnStart(1, T0 + 1_500)] } });
  const perSweep: string[][] = [];
  for (const now of [T0 + 61_000, T0 + 62_000, T0 + 63_000, T0 + 1_500 + WINDOW]) {
    const before = listings.length;
    assert.deepEqual((await sweepWatchdog(db, host, WINDOW, now)).turnUnacked, []);
    perSweep.push(listings.slice(before).map(({ threadId }) => threadId));
  }
  assert.equal(TURN_SCAN_BUDGET, 10);
  assert.deepEqual(perSweep.map((threads) => threads.length), [10, 10, 10, 10]);
  assert.deepEqual(new Set(perSweep.slice(0, 3).flat()), new Set(children), "every child read within ceil(25 / 10) sweeps");
  assert.equal(perSweep[3][0], "thr_c15", "its open turn's window ran out: read first");
});

test("turn scan: due stop requests are carried out before any turn listing", async () => {
  const db = openDb();
  spawned(db);
  const { host: failing } = fakeWatchdogHost({ failStops: true });
  assert.equal((await sweepWatchdog(db, failing, WINDOW, T0 + 1_000 + WINDOW)).refused.length, 1, "refused, its stop failed");
  const other = admit(db, { rootThreadId: "thr_other_parent", callerThreadId: "thr_other_parent", kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, T0);
  assert.ok(other.ok);
  assert.ok(bindChild(db, other.delegation.delegationId, "thr_other", T0 + 3 * WINDOW - 1_000).ok, "inside its ack window");
  const { host, calls } = fakeWatchdogHost();
  await sweepWatchdog(db, host, WINDOW, T0 + 3 * WINDOW);
  assert.deepEqual(calls, ["stop thr_child", "turns thr_other"]);
});

test("turn scan: an idle child is still read; a new turn without its ack is refused", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  const { host, stops } = fakeWatchdogHost({ turns: { thr_child: turns } });
  assert.deepEqual(await sweepWatchdog(db, host, WINDOW, T0 + 11_000), emptyReport);
  assert.ok(transition(db, delegationId, "idle", T0 + 12_000).ok);
  turns.push(turnStart(3, T0 + 400_000));
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 400_000 + WINDOW);
  assert.deepEqual(report.turnUnacked.map(({ turn }) => turn.seq), [3]);
  assert.deepEqual([getDelegation(db, delegationId)?.state, stops], ["refused", ["thr_child"]]);
});

test("turn scan: an idle child resumed natively takes a slot with its ack and is idled again after the turn", async () => {
  const db = openDb();
  const { delegationId, turns } = firstTurn(db);
  const { host, statuses } = fakeWatchdogHost({ turns: { thr_child: turns } });
  statuses.set("thr_child", "idle");
  await sweepWatchdog(db, host, WINDOW, T0 + 11_000);
  assert.equal(getDelegation(db, delegationId)?.state, "idle");
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
  // A message written into the child's thread: its turn acks a fresh policy, SANDY runs the turn.
  turns.push(turnStart(3, T0 + 400_000));
  statuses.set("thr_child", "active");
  ackTurn(db, delegationId, "pi-1", 2, T0 + 400_100);
  assert.equal(getDelegation(db, delegationId)?.state, "active");
  assert.equal(listSlotHolders(db, "thr_parent").length, 1);
  turns.push(turnEnd(4, T0 + 410_000));
  statuses.set("thr_child", "idle");
  const report = await sweepWatchdog(db, host, WINDOW, T0 + 411_000);
  assert.deepEqual([report.idled.map((row) => row.delegationId), report.turnUnacked], [[delegationId], []]);
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
});

test("turn scan: a deleted child thread ends its delegation (error), frees its slot and settles its delivery and question; a failed read is retried", async () => {
  const db = openDb();
  const { delegationId } = firstTurn(db);
  const claimed = claimDelivery(db, { delegationId, inputId: null, reservationOwner: null, afterSeq: 2 }, T0 + 20_000);
  assert.ok(claimed.ok);
  assert.ok(askQuestion(db, { delegationId, question: "q?", options: [], formId: "frm_1", timeoutMs: 60_000 }, T0 + 20_000).ok);
  const { host } = fakeWatchdogHost({ turns: { thr_child: [turnStart(1, T0 + 2_500)] } });
  // A transient failure to read the thread: the child keeps its row and its slot, the next pass retries.
  const flaky: WatchdogHost = { ...host, turnEventsAfter: async () => null, threadState: async () => { throw new Error("sandy unavailable"); } };
  const retried = await sweepWatchdog(db, flaky, WINDOW, T0 + 30_000);
  assert.equal(getDelegation(db, delegationId)?.state, "active");
  assert.ok(retried.failures.some((failure) => failure.subject === "thr_child"));
  assert.equal(listSlotHolders(db, "thr_parent").length, 1);
  // SANDY no longer has the thread (deleted mid-turn): the row is terminal.
  const deleted: WatchdogHost = { ...host, turnEventsAfter: async () => null, latestTurnEvents: async () => null, threadState: async () => null };
  await sweepWatchdog(db, deleted, WINDOW, T0 + 31_000);
  assert.equal(getDelegation(db, delegationId)?.state, "error");
  assert.equal(listSlotHolders(db, "thr_parent").length, 0);
  assert.equal(getDelivery(db, claimed.delivery.deliveryId)?.state, "rejected");
  assert.deepEqual(listQuestionsOfEndedDelegations(db).map((question) => question.delegationId), [delegationId]);
});

// Starvation (fix-check P0): 11 children, sweeps P apart.
const P = 1_000;

// Acks the child's turn with a fresh policy at the given time.
const ackChild = (db: Db, delegationId: string, child: string, turn: number, at: number) => {
  const answer = issuePolicy(db, child, {}, at) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.equal(answer.status, "ok");
  assert.ok(recordAck(db, { threadId: child, delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn }, WINDOW, at).ok);
};

// A delegation of the child's own parent, bound at boundAt, its first turn acked 600 ms later.
const boundChild = (db: Db, child: string, boundAt: number) => {
  const result = admit(db, { rootThreadId: `${child}_parent`, callerThreadId: `${child}_parent`, kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, boundAt - 500);
  assert.ok(result.ok);
  assert.ok(bindChild(db, result.delegation.delegationId, child, boundAt).ok);
  ackChild(db, result.delegation.delegationId, child, 1, boundAt + 600);
  return result.delegation.delegationId;
};

// Sweeps every P from `from` (at most `sweeps` times) until `child` is refused; its refusal time (null:
// never) and every child refused for a turn meanwhile. Each of the child's `later` events joins its turns
// (SANDY's event list) only once the sweep time reaches it.
const sweepUntilRefused = async (
  db: Db, host: WatchdogHost, child: string, from: number, sweeps: number, turns: Record<string, TurnEvent[]>, later: TurnEvent[],
) => {
  const refused: string[] = [];
  const pending = [...later];
  for (let index = 0; index < sweeps; index += 1) {
    const now = from + index * P;
    while (pending.length > 0 && pending[0].at <= now) turns[child].push(pending.shift()!);
    const report = await sweepWatchdog(db, host, WINDOW, now);
    refused.push(...report.turnUnacked.map(({ delegation }) => delegation.childThreadId!));
    if (refused.includes(child)) return { at: now, refused };
  }
  return { at: null, refused };
};

// The 11th child: turn 1 acked and completed (known from the start), then a resume at resumedAt without an
// ack (3 turn events in all).
const firstTurnDone = (bindAt: number) => [turnStart(1, bindAt + 500), turnEnd(2, bindAt + 5_000)];
const unackedResume = (resumedAt: number) => [turnStart(3, resumedAt)];

test("turn scan: 10 baseline-pending children whose listings always fail do not starve an 11th child's unacked resume (fix-check P0)", async () => {
  const db = preTurnCursorDb();
  const failing = Array.from({ length: 10 }, (_, index) => `thr_b${index}`);
  for (const child of failing) boundChild(db, child, T0 + 1_000);
  upgradeFromPreTurnCursor(db);
  boundChild(db, "thr_last", T0 + 2_000);
  const resumedAt = T0 + 50_000;
  const turns = { thr_last: firstTurnDone(T0 + 2_000) };
  const { host } = fakeWatchdogHost({ turns, failListings: new Set(failing) });
  const { at, refused } = await sweepUntilRefused(db, host, "thr_last", T0 + 10_000, 400, turns, unackedResume(resumedAt));
  assert.notEqual(at, null, "refused at all");
  assert.ok(at! <= resumedAt + turnRefusalBoundMs(WINDOW, 11, P, 3), `refused at +${at! - resumedAt} ms`);
  assert.deepEqual(refused, ["thr_last"]);
  assert.ok(failing.every((child) => getTurnCursor(db, getDelegationByChild(db, child)!.delegationId, child).baselinePending), "the 10 baselines still pending");
});

test("turn scan: 10 children whose overdue open turns cannot be listed do not starve an 11th child's unacked resume (fix-check P0)", async () => {
  const db = openDb();
  const failing = Array.from({ length: 10 }, (_, index) => `thr_o${index}`);
  const turns: Record<string, TurnEvent[]> = {};
  for (const child of failing) {
    boundChild(db, child, T0 + 1_000);
    turns[child] = [turnStart(1, T0 + 1_500)];
  }
  boundChild(db, "thr_last", T0 + 2_000);
  const resumedAt = T0 + 200_000;
  turns.thr_last = firstTurnDone(T0 + 2_000);
  const failListings = new Set<string>();
  const { host } = fakeWatchdogHost({ turns, failListings });
  for (const now of [T0 + 6_000, T0 + 7_000]) assert.deepEqual((await sweepWatchdog(db, host, WINDOW, now)).turnUnacked, []);
  for (const child of failing) failListings.add(child);
  const { at, refused } = await sweepUntilRefused(db, host, "thr_last", T0 + 8_000, 400, turns, unackedResume(resumedAt));
  assert.notEqual(at, null, "refused at all");
  assert.ok(at! <= resumedAt + turnRefusalBoundMs(WINDOW, 11, P, 3), `refused at +${at! - resumedAt} ms`);
  assert.deepEqual(refused, ["thr_last"]);
  assert.ok(failing.every((child) => getTurnCursor(db, getDelegationByChild(db, child)!.delegationId, child).open?.seq === 1), "the 10 open turns were read and are overdue");
});

test("turn scan: 10 children with long multi-page histories do not hold back an 11th child's unacked resume (fix-check P0)", async () => {
  const db = openDb();
  const turns: Record<string, TurnEvent[]> = {};
  for (let index = 0; index < 10; index += 1) {
    const child = `thr_long${index}`;
    const delegationId = boundChild(db, child, T0 + 1_000);
    turns[child] = [turnStart(1, T0 + 1_500), turnEnd(2, T0 + 5_000)];
    for (let turn = 2; turn <= 300; turn += 1) {
      const startedAt = T0 + turn * 10_000;
      ackChild(db, delegationId, child, turn, startedAt - 100);
      turns[child].push(turnStart(2 * turn - 1, startedAt), turnEnd(2 * turn, startedAt + 5_000));
    }
  }
  boundChild(db, "thr_last", T0 + 2_000);
  const resumedAt = T0 + 4_000_000;
  turns.thr_last = [...firstTurnDone(T0 + 2_000), ...unackedResume(resumedAt)];
  const { host, listings } = fakeWatchdogHost({ turns });
  const { at, refused } = await sweepUntilRefused(db, host, "thr_last", resumedAt + WINDOW, 50, turns, []);
  assert.notEqual(at, null, "refused at all");
  assert.ok(at! <= resumedAt + turnRefusalBoundMs(WINDOW, 11, P, 3), `refused at +${at! - resumedAt} ms`);
  assert.deepEqual(refused, ["thr_last"]);
  assert.ok(listings.filter(({ threadId }) => threadId === "thr_long0").length < 600 / TURN_EVENT_PAGE, "the 11th was refused before the long histories were drained");
});
