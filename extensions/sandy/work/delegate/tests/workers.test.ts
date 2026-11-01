import test from "node:test";
import assert from "node:assert/strict";
import { admit, getDelegation, listSlotHolders } from "../server/ledger.ts";
import { delegateToolsFor, BRIEF_TOOL } from "../server/protocol.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { SPAWN_SETTLE_MS, sweepWatchdog, type WatchdogHost } from "../server/watchdog.ts";
import { admitWorker, attachWorker, releaseWorker, sweepWorkers, type WorkerCandidate, type WorkerSweepHost, type WorkerThreadHost } from "../server/workers.ts";
import { openDb } from "./db-fixture.ts";

const WORK = "work";
const ORIGIN = "thr_origin";
const T0 = 1_000_000;
const GRACE = 20_000;
const settings = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 4 };

const NO_THREADS: WorkerThreadHost = { workerPluginId: WORK, workerCandidates: async () => [], rootOf: async (threadId) => threadId };
const admitCall = (db: ReturnType<typeof openDb>, callId: string, now = T0, extra: { threadId?: string; attempt?: number; runId?: string } = {}, host: WorkerThreadHost = NO_THREADS) =>
  admitWorker(db, host, { originThreadId: ORIGIN, runId: "run_1", callId, ...extra }, settings, now);

const delegateReservation = (db: ReturnType<typeof openDb>, n: number) => {
  const result = admit(db, { rootThreadId: ORIGIN, callerThreadId: ORIGIN, kind: "delegate", agent: "scout", inputHash: `d${n}` }, settings, T0);
  assert.ok(result.ok);
  return result.delegation;
};

// callRunning: workflows-plus' answer whether a worker's call attempt still runs; null (default) when
// workflows-plus is not installed.
function fakeHost(
  candidates: WorkerCandidate[] | null,
  statuses: Record<string, { status: string; archived: boolean } | null> = {},
  callRunning: WorkerSweepHost["workerCallRunning"] = async () => null,
): WorkerSweepHost {
  return {
    workerPluginId: WORK, workerCandidates: async (originThreadId) => (originThreadId === ORIGIN ? candidates : null),
    rootOf: async (threadId) => threadId,
    threadState: async (threadId) => (threadId in statuses ? statuses[threadId] : { status: "active", archived: false }),
    workerCallRunning: callRunning,
  };
}

const workerThread = (threadId: string, callId: string, overrides: Partial<WorkerCandidate> = {}): WorkerCandidate => ({
  threadId, originPluginId: WORK, createdAt: T0 + 500, metadata: { workflowWorker: 1, runId: "run_1", callId, originThreadId: ORIGIN }, ...overrides,
});

// SANDY lists these threads under ORIGIN.
const listing = (...threads: WorkerCandidate[]): WorkerThreadHost => ({ workerPluginId: WORK, workerCandidates: async (originThreadId) => (originThreadId === ORIGIN ? threads : null), rootOf: async (threadId) => threadId });

type Granted = { reservationId: string; lease: string };
function granted(result: Awaited<ReturnType<typeof admitWorker>>): Granted {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

// workflows-plus spawned threadId for callId and attaches it.
const attachSpawn = (db: ReturnType<typeof openDb>, slot: Granted, threadId: string, callId: string, now = T0 + 500) =>
  attachWorker(db, listing(workerThread(threadId, callId)), { reservationId: slot.reservationId, lease: slot.lease, threadId }, now);

test("workers.admit: an origin that is itself a delegated child is refused (depth 1)", async () => {
  const db = openDb();
  const parent = delegateReservation(db, 1);
  db.prepare("UPDATE delegations SET child_thread_id = 'thr_child', state = 'active' WHERE delegation_id = ?").run(parent.delegationId);
  const admitted = await admitWorker(db, NO_THREADS, { originThreadId: "thr_child", runId: "run_1", callId: "c1" }, settings, T0);
  assert.equal((admitted as { code: string }).code, "nested_delegation");
});

test("workers.admit: an origin that is an ordinary SANDY child counts against its real root, with that root's delegates", async () => {
  const db = openDb();
  for (const n of [1, 2, 3, 4]) {
    const result = admit(db, { rootThreadId: "thr_top", callerThreadId: "thr_top", kind: "delegate", agent: "scout", inputHash: `top${n}` }, settings, T0);
    assert.ok(result.ok);
  }
  const underTop: WorkerThreadHost = { workerPluginId: WORK, workerCandidates: async () => [], rootOf: async (threadId) => (threadId === ORIGIN ? "thr_top" : threadId) };
  const refused = await admitWorker(db, underTop, { originThreadId: ORIGIN, runId: "run_1", callId: "c1" }, settings, T0);
  assert.equal((refused as { code: string }).code, "limit_reached");
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
  db.prepare("UPDATE delegations SET state = 'error' WHERE root_thread_id = 'thr_top' AND input_hash = 'top4'").run();
  const admitted = granted(await admitWorker(db, underTop, { originThreadId: ORIGIN, runId: "run_1", callId: "c1" }, settings, T0));
  assert.equal(getDelegation(db, admitted.reservationId)?.rootThreadId, "thr_top");
  assert.equal(getDelegation(db, admitted.reservationId)?.parentThreadId, ORIGIN);
});

test("workers.admit: the root's limit counts delegates and workers together; the 5th waits until one releases", async () => {
  const db = openDb();
  for (const n of [1, 2, 3]) delegateReservation(db, n);
  const fourth = granted(await admitCall(db, "c1"));
  const fifth = await admitCall(db, "c2");
  assert.equal(fifth.ok, false);
  assert.equal((fifth as { code: string }).code, "limit_reached");
  assert.equal((fifth as { running: string[] }).running.length, 4);
  // A full root also refuses a new delegate.
  const delegateRefused = admit(db, { rootThreadId: ORIGIN, callerThreadId: ORIGIN, kind: "delegate", agent: "scout", inputHash: "d9" }, settings, T0);
  assert.equal(delegateRefused.ok, false);
  assert.ok((await attachSpawn(db, fourth, "thr_w1", "c1")).ok);
  assert.equal(getDelegation(db, fourth.reservationId)!.state, "active");
  assert.deepEqual(releaseWorker(db, fourth), { ok: true, released: true });
  assert.equal(getDelegation(db, fourth.reservationId)!.state, "idle");
  assert.ok((await admitCall(db, "c2")).ok, "the waiting worker is admitted once the slot is free");
});

test("workers.admit: a retried admit of the same call returns its reservation; a provider retry (attempt) gets a new one", async () => {
  const db = openDb();
  const first = granted(await admitCall(db, "c1"));
  const again = granted(await admitCall(db, "c1"));
  assert.deepEqual([again.reservationId, again.lease], [first.reservationId, first.lease]);
  const retry = granted(await admitCall(db, "c1", T0, { attempt: 1 }));
  assert.notEqual(retry.reservationId, first.reservationId);
  assert.notEqual(retry.lease, first.lease);
});

test("workers.admit with threadId (kept-session continuation): idle worker takes a slot again, waits when the root is full", async () => {
  const db = openDb();
  const spawn = granted(await admitCall(db, "c1"));
  assert.ok((await attachSpawn(db, spawn, "thr_kept", "c1")).ok);
  assert.ok(releaseWorker(db, spawn).ok);
  for (const n of [1, 2, 3, 4]) delegateReservation(db, n);
  const full = await admitCall(db, "c2", T0, { threadId: "thr_kept" });
  assert.equal((full as { code: string }).code, "limit_reached");
  assert.equal(getDelegation(db, spawn.reservationId)!.state, "idle");
  db.prepare("UPDATE delegations SET state = 'idle' WHERE kind = 'delegate' AND rowid = (SELECT MIN(rowid) FROM delegations WHERE kind = 'delegate')").run();
  const continued = granted(await admitCall(db, "c2", T0, { threadId: "thr_kept" }));
  assert.equal(continued.reservationId, spawn.reservationId);
  assert.notEqual(continued.lease, spawn.lease);
  assert.equal(getDelegation(db, spawn.reservationId)!.state, "active");
  assert.ok((await attachWorker(db, NO_THREADS, { ...continued, threadId: "thr_kept" })).ok, "attach of the same thread is idempotent");
});

test("restart after workers.admit, before the spawn: the reservation holds its slot until SPAWN_SETTLE_MS, then is released (no thread)", async () => {
  const db = openDb();
  const reserved = granted(await admitCall(db, "c1"));
  const early = await sweepWorkers(db, fakeHost([]), GRACE, T0 + GRACE, { startup: true });
  assert.deepEqual(early.released, []);
  assert.equal(listSlotHolders(db, ORIGIN).length, 1, "slot kept while a spawn may still be outstanding");
  const unlisted = await sweepWorkers(db, fakeHost(null), GRACE, T0 + SPAWN_SETTLE_MS);
  assert.deepEqual(unlisted.released, [], "an origin SANDY does not list proves nothing");
  const settled = await sweepWorkers(db, fakeHost([workerThread("thr_other", "c9")]), GRACE, T0 + SPAWN_SETTLE_MS);
  assert.deepEqual(settled.released, [reserved.reservationId]);
  assert.equal(getDelegation(db, reserved.reservationId)!.state, "error");
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
});

test("restart after the spawn, before workers.attach: the worker is attached by its metadata and keeps its slot while it runs", async () => {
  const db = openDb();
  const reserved = granted(await admitCall(db, "c1"));
  const forged = workerThread("thr_forged", "c1", { originPluginId: "some-plugin" });
  const early = workerThread("thr_early", "c1", { createdAt: T0 - 1 });
  const report = await sweepWorkers(db, fakeHost([forged, early, workerThread("thr_w1", "c1")]), GRACE, T0 + 1_000, { startup: true });
  assert.deepEqual(report.attached, [{ reservationId: reserved.reservationId, threadId: "thr_w1" }]);
  const row = getDelegation(db, reserved.reservationId)!;
  assert.equal(row.state, "active");
  assert.equal(row.childThreadId, "thr_w1");
  const running = await sweepWorkers(db, fakeHost([], { thr_w1: { status: "active", archived: false } }), GRACE, T0 + SPAWN_SETTLE_MS * 2);
  assert.deepEqual(running.idled, []);
  assert.equal(listSlotHolders(db, ORIGIN).length, 1, "never freed while it runs");
  // workflows-plus restarted too and never releases: once SANDY shows the worker idle past the grace, the slot frees.
  const done = await sweepWorkers(db, fakeHost([], { thr_w1: { status: "idle", archived: false } }), GRACE, T0 + SPAWN_SETTLE_MS * 2);
  assert.deepEqual(done.idled, [reserved.reservationId]);
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
  // The sweep took the slot back: the lease it was granted under no longer attaches or releases anything.
  assert.equal((await attachWorker(db, NO_THREADS, { ...reserved, threadId: "thr_w1" }) as { code: string }).code, "stale_lease");
  assert.equal((await attachSpawn(db, reserved, "thr_w2", "c1")).ok, false);
  assert.equal((releaseWorker(db, reserved)).ok, true);
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
});

test("a just-continued worker whose thread is still idle keeps its slot through the grace window", async () => {
  const db = openDb();
  const spawn = granted(await admitCall(db, "c1"));
  await attachSpawn(db, spawn, "thr_kept", "c1", T0);
  const sweep = await sweepWorkers(db, fakeHost([], { thr_kept: { status: "idle", archived: false } }), GRACE, T0 + GRACE - 1);
  assert.deepEqual(sweep.idled, []);
  const archivedRunning = await sweepWorkers(db, fakeHost([], { thr_kept: { status: "active", archived: true } }), GRACE, T0 + 1);
  assert.deepEqual(archivedRunning.idled, [], "archiving does not end a running turn: the slot is kept");
  assert.equal(listSlotHolders(db, ORIGIN).length, 1);
  const archivedStopping = await sweepWorkers(db, fakeHost([], { thr_kept: { status: "stopping", archived: true } }), GRACE, T0 + 2);
  assert.deepEqual(archivedStopping.idled, []);
  const archivedIdle = await sweepWorkers(db, fakeHost([], { thr_kept: { status: "idle", archived: true } }), GRACE, T0 + 3);
  assert.deepEqual(archivedIdle.idled, [spawn.reservationId], "archived and stopped frees the slot at once");
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
});

test("a reporting worker idle between its own turns keeps its slot while workflows-plus reports its call running; freed once the call ended or workflows-plus is gone", async () => {
  const db = openDb();
  const slot = granted(await admitCall(db, "c1", T0, { attempt: 2 }));
  assert.equal((await attachSpawn(db, slot, "thr_w1", "c1")).ok, true);
  const asked: unknown[] = [];
  const idle = { thr_w1: { status: "idle", archived: false } };
  const running = await sweepWorkers(db, fakeHost([], idle, async (call) => (asked.push(call), true)), GRACE, T0 + GRACE * 3);
  assert.deepEqual(running.idled, []);
  assert.deepEqual(asked, [{ runId: "run_1", callId: "c1", attempt: 2 }]);
  const archived = await sweepWorkers(db, fakeHost([], { thr_w1: { status: "idle", archived: true } }, async () => true), GRACE, T0 + GRACE * 3);
  assert.deepEqual(archived.idled, []);
  const unanswered = await sweepWorkers(db, fakeHost([], idle, async () => { throw new Error("timeout"); }), GRACE, T0 + GRACE * 3);
  assert.deepEqual(unanswered.idled, []);
  assert.equal(unanswered.failures.length, 1);
  assert.equal(getDelegation(db, slot.reservationId)!.state, "active");
  const ended = await sweepWorkers(db, fakeHost([], idle, async () => false), GRACE, T0 + GRACE * 3);
  assert.deepEqual(ended.idled, [slot.reservationId]);

  const gone = openDb();
  const other = granted(await admitCall(gone, "c1"));
  assert.equal((await attachSpawn(gone, other, "thr_w1", "c1")).ok, true);
  const absent = await sweepWorkers(gone, fakeHost([], idle, async () => null), GRACE, T0 + GRACE * 3);
  assert.deepEqual(absent.idled, [other.reservationId]);
});

test("a worker thread gets no delegate marker and the delegate watchdog never refuses or reconciles it", async () => {
  const db = openDb();
  const reserved = granted(await admitCall(db, "c1"));
  const stops: string[] = [];
  let listed = 0;
  const host: WatchdogHost = {
    pluginId: "delegate",
    spawnCandidates: async () => { listed += 1; return []; },
    spawnInFlight: () => false,
    waitInFlight: () => false,
    setParentNotifications: async () => {},
    stop: async (threadId) => { stops.push(threadId); },
    threadState: async () => ({ status: "active", archived: false }),
    firstTurnStartedAt: async () => T0 + 600,
    turnEventsAfter: async () => [{ seq: 1, type: "started", at: T0 + 600 }],
    latestTurnEvents: async () => [{ seq: 1, type: "started", at: T0 + 600 }],
  };
  await sweepWatchdog(db, host, GRACE, T0 + SPAWN_SETTLE_MS, { startup: true });
  assert.equal(listed, 0, "worker reservations are not delegate spawns");
  assert.equal(getDelegation(db, reserved.reservationId)!.state, "reserved");
  await attachSpawn(db, reserved, "thr_w1", "c1", T0 + 500);
  const report = await sweepWatchdog(db, host, GRACE, T0 + SPAWN_SETTLE_MS * 2);
  assert.deepEqual([report.refused, report.unmarked, report.turnUnacked, stops], [[], [], [], []]);
  assert.equal(getDelegation(db, reserved.reservationId)!.state, "active");
  assert.ok(!delegateToolsFor(db, "thr_w1", {}).includes(BRIEF_TOOL));
});

test("workers.admit: concurrent continuations of one kept worker get one lease; the waiting call can never free the running call's slot", async () => {
  const db = openDb();
  const one = { ...settings, maxConcurrentChildren: 1 };
  const spawn = granted(await admitWorker(db, NO_THREADS, { originThreadId: ORIGIN, runId: "run_1", callId: "c1" }, one, T0));
  assert.ok((await attachSpawn(db, spawn, "thr_kept", "c1")).ok);
  assert.ok(releaseWorker(db, spawn).ok);
  const first = granted(await admitWorker(db, NO_THREADS, { originThreadId: ORIGIN, runId: "run_1", callId: "c2", threadId: "thr_kept" }, one, T0));
  const second = await admitWorker(db, NO_THREADS, { originThreadId: ORIGIN, runId: "run_1", callId: "c3", threadId: "thr_kept" }, one, T0);
  assert.equal((second as { code: string }).code, "worker_busy", "another call never shares the running call's reservation");
  assert.equal((releaseWorker(db, spawn) as { code: string }).code, "stale_lease", "the spawn's old lease frees nothing");
  assert.equal(getDelegation(db, first.reservationId)!.state, "active");
  assert.equal((await admitWorker(db, NO_THREADS, { originThreadId: ORIGIN, runId: "run_1", callId: "c4" }, one, T0)).ok, false, "the root stays full while the continuation runs");
  assert.deepEqual(releaseWorker(db, first), { ok: true, released: true });
  assert.ok((await admitWorker(db, NO_THREADS, { originThreadId: ORIGIN, runId: "run_1", callId: "c3", threadId: "thr_kept" }, one, T0)).ok, "the waiting call continues once released");
});

test("workers.admit: a kept worker of another run is not transferred, even under the same origin", async () => {
  const db = openDb();
  const spawn = granted(await admitCall(db, "c1"));
  assert.ok((await attachSpawn(db, spawn, "thr_kept", "c1")).ok);
  assert.ok(releaseWorker(db, spawn).ok);
  const other = await admitCall(db, "c1", T0, { runId: "run_2", threadId: "thr_kept" });
  assert.equal((other as { code: string }).code, "not_a_worker");
  assert.equal(getDelegation(db, spawn.reservationId)!.state, "idle");
});

test("workers.attach binds only the reservation's own workflows-plus spawn under the origin", async () => {
  const db = openDb();
  const slot = granted(await admitCall(db, "c1"));
  const attach = (threadId: string, host: WorkerThreadHost) => attachWorker(db, host, { ...slot, threadId }, T0 + 500);
  assert.equal((await attach("thr_none", NO_THREADS)).ok, false, "a thread SANDY does not list under the origin");
  assert.equal((await attach("thr_plain", listing(workerThread("thr_plain", "c1", { originPluginId: null })))).ok, false, "an ordinary thread");
  assert.equal((await attach("thr_other", listing(workerThread("thr_other", "c2")))).ok, false, "a worker of another call");
  assert.equal((await attach("thr_run2", listing(workerThread("thr_run2", "c1", { metadata: { workflowWorker: 1, runId: "run_2", callId: "c1", originThreadId: ORIGIN } })))).ok, false, "a worker of another run");
  const delegated = delegateReservation(db, 1);
  db.prepare("UPDATE delegations SET child_thread_id = 'thr_dlg', state = 'active' WHERE delegation_id = ?").run(delegated.delegationId);
  assert.equal((await attach("thr_dlg", listing(workerThread("thr_dlg", "c1")))).ok, false, "a thread the ledger already binds (a delegate child)");
  assert.equal((await attachWorker(db, listing(workerThread("thr_w1", "c1")), { reservationId: slot.reservationId, lease: "wl_forged", threadId: "thr_w1" }, T0 + 500)).ok, false, "a foreign lease");
  assert.equal(getDelegation(db, slot.reservationId)!.childThreadId, null);
  assert.ok((await attach("thr_w1", listing(workerThread("thr_w1", "c1")))).ok);
  assert.equal(getDelegation(db, slot.reservationId)!.childThreadId, "thr_w1");
});

test("workers.admit with an unknown threadId binds only a workflows-plus worker of the same run under the origin", async () => {
  const db = openDb();
  const refused = await admitCall(db, "c2", T0, { threadId: "thr_ghost" });
  assert.equal((refused as { code: string }).code, "not_a_worker", "a nonexistent thread");
  const plain = await admitCall(db, "c2", T0, { threadId: "thr_plain" }, listing(workerThread("thr_plain", "c1", { originPluginId: null })));
  assert.equal((plain as { code: string }).code, "not_a_worker", "an ordinary thread");
  assert.equal(listSlotHolders(db, ORIGIN).length, 0);
  const kept = granted(await admitCall(db, "c2", T0, { threadId: "thr_kept" }, listing(workerThread("thr_kept", "c1"))));
  assert.equal(getDelegation(db, kept.reservationId)!.childThreadId, "thr_kept");
});
