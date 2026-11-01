import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, clearWaitSilenced, markWaitSilenced, transition } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { restoreSilencedChildren, WAIT_RESTORE_BUDGET, type SweepReport, type WatchdogHost } from "../server/watchdog.ts";
import { waitForDelegation, type WaitHost } from "../server/wait.ts";

// The watchdog's restore of children a dead process left silenced (parentNotifications "off").
type Db = ReturnType<typeof openDb>;

const emptyReport = (): SweepReport => ({ refused: [], unmarked: [], turnUnacked: [], bound: [], released: [], kept: [], stopped: [], restored: [], idled: [], deleted: [], failures: [] });

function child(db: Db, n: number, options: { wait: boolean; bind?: boolean }): { delegationId: string; threadId: string } {
  const admitted = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: `h${n}`, clientRequestId: `c${n}` }, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 50 }, n);
  assert.ok(admitted.ok);
  const delegationId = admitted.delegation.delegationId;
  const threadId = `thr_child${n}`;
  if (options.bind !== false) assert.ok(bindChild(db, delegationId, threadId, n).ok);
  if (options.wait) markWaitSilenced(db, delegationId, n);
  return { delegationId, threadId };
}

// A fresh plugin process: nothing is waited on, spawned, or flipped yet.
function freshHost(options: { waiting?: Set<string>; spawning?: Set<string>; failing?: Map<string, number> } = {}) {
  const flips: { threadId: string; mode: string }[] = [];
  const host = {
    spawnInFlight: (id: string) => options.spawning?.has(id) ?? false,
    waitInFlight: (id: string) => options.waiting?.has(id) ?? false,
    setParentNotifications: async (threadId: string, mode: string) => {
      if (options.failing?.has(threadId)) throw Object.assign(new Error("sandy refused"), { status: options.failing.get(threadId) });
      flips.push({ threadId, mode });
    },
  } as unknown as WatchdogHost;
  return { host, flips };
}

const marks = (db: Db) => (db.prepare("SELECT delegation_id AS id FROM delegation_wait_marks ORDER BY marked_at").all() as { id: string }[]).map((row) => row.id);

test("restore: a new process (nothing in flight) flips a wait-mode child to auto and clears its mark", async () => {
  const db = openDb();
  const wait = child(db, 1, { wait: true });
  const report = emptyReport();
  const { host, flips } = freshHost();
  await restoreSilencedChildren(db, host, 100, report);
  assert.deepEqual(flips, [{ threadId: wait.threadId, mode: "auto" }]);
  assert.deepEqual(report.restored, [wait.threadId]);
  assert.deepEqual(marks(db), []);
  await restoreSilencedChildren(db, host, 200, emptyReport());
  assert.equal(flips.length, 1, "a cleared mark is not flipped again");
});

test("restore: a child whose wait is in flight in this process is left off, its mark kept", async () => {
  const db = openDb();
  const waiting = child(db, 1, { wait: true });
  const other = child(db, 2, { wait: true });
  const { host, flips } = freshHost({ waiting: new Set([waiting.delegationId]) });
  await restoreSilencedChildren(db, host, 100, emptyReport());
  assert.deepEqual(flips, [{ threadId: other.threadId, mode: "auto" }]);
  assert.deepEqual(marks(db), [waiting.delegationId]);
});

test("restore: a spawn still in flight is left alone", async () => {
  const db = openDb();
  const spawning = child(db, 1, { wait: true });
  const { host, flips } = freshHost({ spawning: new Set([spawning.delegationId]) });
  await restoreSilencedChildren(db, host, 100, emptyReport());
  assert.deepEqual(flips, []);
  assert.deepEqual(marks(db), [spawning.delegationId]);
});

test("restore: async children (no mark) are never touched", async () => {
  const db = openDb();
  child(db, 1, { wait: false });
  child(db, 2, { wait: false });
  const { host, flips } = freshHost();
  await restoreSilencedChildren(db, host, 100, emptyReport());
  assert.deepEqual(flips, []);
});

test("restore: ended delegations lose their mark without a SANDY call; unbound ones keep it", async () => {
  const db = openDb();
  const ended = child(db, 1, { wait: true });
  assert.ok(transition(db, ended.delegationId, "stopped", 5).ok);
  const unbound = child(db, 2, { wait: true, bind: false });
  const { host, flips } = freshHost();
  await restoreSilencedChildren(db, host, 100, emptyReport());
  assert.deepEqual(flips, []);
  assert.deepEqual(marks(db), [unbound.delegationId]);
  assert.ok(bindChild(db, unbound.delegationId, "thr_late", 6).ok);
  await restoreSilencedChildren(db, host, 200, emptyReport());
  assert.deepEqual(flips, [{ threadId: "thr_late", mode: "auto" }]);
  assert.deepEqual(marks(db), []);
});

test("restore: at most WAIT_RESTORE_BUDGET SANDY calls per pass, the rest on the next passes", async () => {
  const db = openDb();
  const all = [1, 2, 3, 4, 5].map((n) => child(db, n, { wait: true }));
  const { host, flips } = freshHost();
  await restoreSilencedChildren(db, host, 100, emptyReport());
  assert.equal(flips.length, WAIT_RESTORE_BUDGET);
  await restoreSilencedChildren(db, host, 200, emptyReport());
  assert.deepEqual(flips.map((flip) => flip.threadId).sort(), all.map((entry) => entry.threadId).sort());
  assert.deepEqual(marks(db), []);
});

test("restore: a refused flip is reported and retried, behind the children not yet attempted; a 404 drops the mark", async () => {
  const db = openDb();
  const bad = child(db, 1, { wait: true });
  const gone = child(db, 2, { wait: true });
  const goods = [3, 4, 5].map((n) => child(db, n, { wait: true }));
  const failing = new Map([[bad.threadId, 500], [gone.threadId, 404]]);
  const { host, flips } = freshHost({ failing });
  const first = emptyReport();
  await restoreSilencedChildren(db, host, 100, first);
  assert.deepEqual(first.failures.map((failure) => failure.subject), [`restore notifications of ${bad.threadId}`]);
  assert.ok(!marks(db).includes(gone.delegationId), "404: SANDY no longer has the thread");
  assert.ok(marks(db).includes(bad.delegationId), "a refused flip keeps its mark");
  await restoreSilencedChildren(db, host, 200, emptyReport());
  assert.deepEqual(flips.map((flip) => flip.threadId).sort(), goods.map((entry) => entry.threadId).sort());
  failing.delete(bad.threadId);
  await restoreSilencedChildren(db, host, 300, emptyReport());
  assert.ok(flips.some((flip) => flip.threadId === bad.threadId));
  assert.deepEqual(marks(db), []);
});

// The wait itself: its mark is written before the child is silenced and cleared once "auto" is confirmed.
function waitHost(db: Db, options: { failAuto?: boolean } = {}) {
  const flips: string[] = [];
  const inFlightDuringFlip: boolean[] = [];
  const host: WaitHost = {
    waitsInFlight: new Map(),
    threadState: async () => ({ status: "idle", archived: false }),
    latestTurnEvents: async () => [{ seq: 2, type: "completed", at: 2, outcome: "completed" }],
    output: async () => "done",
    setParentNotifications: async (_threadId, mode) => {
      inFlightDuringFlip.push((host.waitsInFlight.get(delegationIdOf(db)) ?? 0) > 0);
      if (mode === "auto" && options.failAuto) throw new Error("sandy down");
      flips.push(mode);
    },
    now: () => 0,
    sleep: async () => {},
  };
  return { host, flips, inFlightDuringFlip };
}
const delegationIdOf = (db: Db) => (db.prepare("SELECT delegation_id AS id FROM delegations LIMIT 1").get() as { id: string }).id;

test("wait: sandy_delegate_wait marks the child before silencing it and clears the mark after the flip to auto; the wait is in flight meanwhile and not afterwards", async () => {
  const db = openDb();
  const wait = child(db, 1, { wait: false });
  const { host, flips, inFlightDuringFlip } = waitHost(db);
  const outcome = await waitForDelegation(db, host, { callerThreadId: "thr_parent", delegationId: wait.delegationId, ceilingMs: 10_000, signal: new AbortController().signal });
  assert.equal(outcome.kind, "finished");
  assert.deepEqual(flips, ["off", "auto"]);
  assert.deepEqual(inFlightDuringFlip, [true, true]);
  assert.equal(host.waitsInFlight.size, 0);
  assert.deepEqual(marks(db), []);
});

test("wait: when the flip to auto fails the mark stays for the watchdog, and the wait is no longer in flight", async () => {
  const db = openDb();
  const wait = child(db, 1, { wait: true });
  const { host } = waitHost(db, { failAuto: true });
  const outcome = await waitForDelegation(db, host, { callerThreadId: "thr_parent", delegationId: wait.delegationId, ceilingMs: 10_000, signal: new AbortController().signal, notificationsAlreadyOff: true });
  assert.ok(outcome.kind === "finished" && outcome.flipError === "sandy down");
  assert.deepEqual(marks(db), [wait.delegationId]);
  assert.equal(host.waitsInFlight.size, 0);
  const { host: watchdog, flips } = freshHost();
  await restoreSilencedChildren(db, watchdog, 100, emptyReport());
  assert.deepEqual(flips, [{ threadId: wait.threadId, mode: "auto" }]);
});

test("ledger: clearWaitSilenced removes only the named mark", () => {
  const db = openDb();
  const a = child(db, 1, { wait: true });
  const b = child(db, 2, { wait: true });
  clearWaitSilenced(db, a.delegationId);
  assert.deepEqual(marks(db), [b.delegationId]);
});
