import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, transition } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { MAX_WAIT_CEILING_MS, WAIT_POLL_MS, waitCeilingMs, waitFields, waitForDelegation, type WaitHost, type WaitOutcome } from "../server/wait.ts";
import type { TurnEvent } from "../server/watchdog.ts";

type Db = ReturnType<typeof openDb>;

// A delegation of thr_parent bound to thr_child, and a SANDY stand-in on a virtual clock: sleep advances it.
// world.thread / world.events change as the test script dictates (by virtual time through at()).
function setup(options: { parent?: string } = {}) {
  const db = openDb();
  const admitted = admit(db, { rootThreadId: "thr_parent", callerThreadId: options.parent ?? "thr_parent", kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, 1);
  assert.ok(admitted.ok);
  const delegationId = admitted.delegation.delegationId;
  assert.ok(bindChild(db, delegationId, "thr_child", 2).ok);
  let clock = 1_000_000;
  const notifications: string[] = [];
  const world: { thread: { status: string; archived: boolean } | null; events: TurnEvent[]; output: string | null; flipFails: string[] } = {
    thread: { status: "active", archived: false }, events: [{ seq: 1, type: "started", at: 1 }], output: "found it in server/config.ts", flipFails: [],
  };
  const timeline: { at: number; run: () => void }[] = [];
  const host: WaitHost = {
    waitsInFlight: new Map(),
    threadState: async () => world.thread,
    latestTurnEvents: async (_id, count) => world.events.slice(-count),
    output: async () => world.output,
    setParentNotifications: async (threadId, mode) => {
      assert.equal(threadId, "thr_child");
      if (world.flipFails.includes(mode)) throw new Error("SANDY refused " + mode);
      notifications.push(mode);
    },
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal.aborted) return;
      clock += ms;
      for (const step of timeline.filter((entry) => entry.at <= clock)) { timeline.splice(timeline.indexOf(step), 1); step.run(); }
    },
  };
  const at = (ms: number, run: () => void) => timeline.push({ at: clock + ms, run });
  const finishTurn = (outcome = "completed", error?: string) => {
    world.thread = { status: "idle", archived: false };
    world.events = [...world.events, { seq: 2, type: "completed", at: 2, outcome, ...(error === undefined ? {} : { error }) }];
  };
  return { db, delegationId, host, world, notifications, at, finishTurn, clock: () => clock };
}

const run = (s: ReturnType<typeof setup>, overrides: Partial<Parameters<typeof waitForDelegation>[2]> = {}) =>
  waitForDelegation(s.db, s.host, { callerThreadId: "thr_parent", delegationId: s.delegationId, ceilingMs: 60_000, signal: new AbortController().signal, ...overrides });

test("wait: a child finishing within the ceiling returns its last message and status, and the notification ends on auto", async () => {
  const s = setup();
  s.at(10_000, () => s.finishTurn());
  const outcome = await run(s);
  assert.equal(outcome.kind, "finished");
  assert.ok(outcome.kind === "finished");
  assert.deepEqual(outcome.finished, { status: "completed", error: null, result: "found it in server/config.ts" });
  assert.deepEqual(s.notifications, ["off", "auto"]);
  assert.ok(s.clock() - 1_000_000 <= 10_000 + WAIT_POLL_MS);
  assert.deepEqual(waitFields(outcome), { status: "completed", waitTimedOut: false, result: "found it in server/config.ts", parentNotifications: "auto" });
});

test("wait: a child that fails reports the turn's error; an idle child with no turn yet is not finished", async () => {
  const s = setup();
  s.world.thread = { status: "idle", archived: false };
  s.world.events = [];
  s.at(6_000, () => { s.world.events = [{ seq: 1, type: "started", at: 1 }]; s.world.thread = { status: "active", archived: false }; });
  s.at(12_000, () => s.finishTurn("failed", "provider exploded"));
  const outcome = await run(s);
  assert.ok(outcome.kind === "finished");
  assert.equal(outcome.finished.status, "failed");
  assert.equal(outcome.finished.error, "provider exploded");
  assert.ok(s.clock() - 1_000_000 >= 12_000);
});

test("wait: a ledger end state, a missing thread and a thread in error without a completed turn all finish the wait", async () => {
  const stopped = setup();
  assert.ok(transition(stopped.db, stopped.delegationId, "refused").ok);
  const a = await run(stopped);
  assert.ok(a.kind === "finished" && a.finished.status === "refused");
  const gone = setup();
  gone.world.thread = null;
  const b = await run(gone);
  assert.ok(b.kind === "finished" && b.finished.status === "gone");
  const failedStart = setup();
  failedStart.world.thread = { status: "error", archived: false };
  const c = await run(failedStart);
  assert.ok(c.kind === "finished" && c.finished.status === "error");
});

test("wait: at the ceiling it returns waitTimedOut with the id and flips the child's notifications to auto", async () => {
  const s = setup();
  const outcome = await run(s, { ceilingMs: 30_000 });
  assert.equal(outcome.kind, "timed_out");
  assert.ok(outcome.kind === "timed_out");
  assert.deepEqual(s.notifications, ["off", "auto"]);
  assert.ok(s.clock() - 1_000_000 <= 30_000);
  assert.deepEqual(waitFields(outcome), { status: "running", waitTimedOut: true, parentNotifications: "auto" });
  assert.equal(outcome.delegation.delegationId, s.delegationId);
  assert.equal(outcome.delegation.childThreadId, "thr_child");
});

test("wait: an aborted parent turn flips the child to auto and the child is left running", async () => {
  const s = setup();
  const controller = new AbortController();
  s.at(5_000, () => controller.abort());
  const outcome = await run(s, { signal: controller.signal });
  assert.equal(outcome.kind, "aborted");
  assert.deepEqual(s.notifications, ["off", "auto"]);
  assert.ok(s.clock() - 1_000_000 < 10_000);
  const already = new AbortController();
  already.abort();
  const s2 = setup();
  assert.equal((await run(s2, { signal: already.signal })).kind, "aborted");
  assert.deepEqual(s2.notifications, ["off", "auto"]);
});

test("wait: notificationsAlreadyOff skips the first flip (the spawn made the child silent)", async () => {
  const s = setup();
  s.finishTurn();
  await run(s, { notificationsAlreadyOff: true });
  assert.deepEqual(s.notifications, ["auto"]);
});

test("wait: a flip that SANDY refuses is reported, not hidden; a host error mid-wait still restores auto and is rethrown", async () => {
  const s = setup();
  s.world.flipFails = ["auto"];
  const outcome = await run(s, { ceilingMs: 4_000 });
  assert.ok(outcome.kind === "timed_out");
  assert.equal(outcome.parentNotifications, "off");
  assert.match(outcome.flipError ?? "", /SANDY refused auto/);
  assert.match(String(waitFields(outcome).notificationFlipError), /SANDY refused auto/);

  const broken = setup();
  broken.host.threadState = async () => { throw new Error("SANDY down"); };
  await assert.rejects(run(broken), /SANDY down/);
  assert.deepEqual(broken.notifications, ["off", "auto"]);
});

test("wait: a thread that is not the delegation's parent is refused and nothing is changed", async () => {
  const s = setup();
  s.finishTurn();
  const foreign = await run(s, { callerThreadId: "thr_other" });
  assert.deepEqual((foreign as Extract<WaitOutcome, { kind: "refused" }>).refusal.code, "not_parent");
  // The child itself is no parent either, whatever its metadata says.
  const child = await run(s, { callerThreadId: "thr_child" });
  assert.equal(child.kind === "refused" && child.refusal.code, "not_parent");
  assert.deepEqual(s.notifications, []);
});

test("wait: an unknown delegation id is refused", async () => {
  const s = setup();
  const outcome = await run(s, { delegationId: "dlg_nope" });
  assert.ok(outcome.kind === "refused");
  assert.equal(outcome.refusal.code, "unknown_delegation");
  assert.deepEqual(s.notifications, []);
});

test("waitCeilingMs: the setting is kept between 1 s and 270 s", () => {
  assert.equal(waitCeilingMs({ waitCeilingMs: 60_000 }), 60_000);
  assert.equal(waitCeilingMs({ waitCeilingMs: 900_000 }), MAX_WAIT_CEILING_MS);
  assert.equal(waitCeilingMs({ waitCeilingMs: 5 }), 1_000);
  assert.equal(waitCeilingMs({ waitCeilingMs: Number.NaN }), MAX_WAIT_CEILING_MS);
  assert.equal(waitCeilingMs(DEFAULT_SETTINGS), 270_000);
});
