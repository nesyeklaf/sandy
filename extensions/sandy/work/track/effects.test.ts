import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor, type EffectPorts } from "./effects.ts";
import type { Effect, Reply, SystemCommand, Ticket } from "./run.ts";

const T = "run1.3" as Ticket;
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(overrides: Partial<EffectPorts> = {}, reply: (c: SystemCommand) => Reply = () => ({ kind: "ok" })) {
  const calls: string[] = [];
  const dispatched: SystemCommand[] = [];
  const ports: EffectPorts = {
    runCheck: async (_t, input) => {
      calls.push(`runCheck ${input.command}`);
      return { exitCode: 0, durationMs: 3, tail: "ok" };
    },
    requestInput: async () => ({ approved: true }),
    send: async (_t, text) => {
      calls.push(`send ${text}`);
    },
    writePolicy: async (_t, rev) => {
      calls.push(`writePolicy ${rev}`);
    },
    warn: (message) => calls.push(`warn ${message}`),
    ...overrides,
  };
  const executor = createExecutor(
    ports,
    async (_threadId, command) => {
      dispatched.push(command);
      calls.push(`dispatch ${command.op}`);
      return reply(command);
    },
    "boot-a",
  );
  return { executor, calls, dispatched };
}

test("check: workStarted is dispatched before the command runs, then checked with every result", async () => {
  const { executor, calls, dispatched } = harness();
  const effect: Effect = { key: "check:run1.3:4", kind: "check", ticket: T, workId: 4, startedIn: null, checks: [{ ruleKey: "gate.1", command: "npm test", timeoutSec: 60 }] };
  executor.reconcile("t", [effect]);
  executor.reconcile("t", [effect]);
  await settle();
  assert.deepEqual(calls, ["dispatch workStarted", "runCheck npm test", "dispatch checked"], "one start per key");
  assert.deepEqual(dispatched[0], { by: "system", op: "workStarted", ticket: T, workId: 4, boot: "boot-a" });
  const checked = dispatched[1] as Extract<SystemCommand, { op: "checked" }>;
  assert.equal(checked.results["gate.1"]!.ok, true);
});

test("check: a failing check's detail shows the output tail from a line boundary, not mid-word", async () => {
  const longLine = "a".repeat(700);
  const failing = (tail: string) => harness({ runCheck: async () => ({ exitCode: 1, durationMs: 3, tail }) });
  const detailOf = async (tail: string) => {
    const { executor, dispatched } = failing(tail);
    executor.reconcile("t", [{ key: "check:run1.3:4", kind: "check", ticket: T, workId: 4, startedIn: null, checks: [{ ruleKey: "gate.1", command: "npm test", timeoutSec: 60 }] }]);
    await settle();
    return (dispatched[1] as Extract<SystemCommand, { op: "checked" }>).results["gate.1"]!.detail;
  };
  assert.equal(await detailOf(`${longLine}\nmiddle line\nend line`), "exit 1 after 3 ms: middle line\nend line");
  assert.equal(await detailOf("short\nfailure"), "exit 1 after 3 ms: short\nfailure", "a tail that fits is shown whole");
  const noBreak = await detailOf(longLine);
  assert.equal(noBreak, `exit 1 after 3 ms: ${"a".repeat(500)}`, "no line boundary in the slice: keep it");
});

test("check/run: a job this boot does not own is never started", async () => {
  const refused = harness({}, (c) => (c.op === "workStarted" ? { kind: "stale", reason: "started by boot-b", current: null } : { kind: "ok" }));
  refused.executor.reconcile("t", [{ key: "run:run1.3:5", kind: "run", ticket: T, workId: 5, startedIn: null, command: "make", timeoutSec: 60 }]);
  await settle();
  assert.deepEqual(refused.calls, ["dispatch workStarted"]);
  const other = harness();
  other.executor.reconcile("t", [{ key: "run:run1.3:5", kind: "run", ticket: T, workId: 5, startedIn: "boot-b", command: "make", timeoutSec: 60 }]);
  await settle();
  assert.deepEqual(other.calls, [], "started by another boot: recover interrupts it");
});

test("run: the result comes back as ran; a failing port still settles the job", async () => {
  const ok = harness({ runCheck: async () => ({ exitCode: 2, durationMs: 9, tail: "boom" }) });
  ok.executor.reconcile("t", [{ key: "run:run1.3:5", kind: "run", ticket: T, workId: 5, startedIn: null, command: "make", timeoutSec: 60 }]);
  await settle();
  assert.deepEqual(ok.dispatched[1], { by: "system", op: "ran", ticket: T, workId: 5, exitCode: 2, durationMs: 9, tail: "boom" });
  const worker = harness({ runCheck: async () => { throw new Error("host plugin worker exited (0)"); } });
  worker.executor.reconcile("t", [{ key: "run:run1.3:5", kind: "run", ticket: T, workId: 5, startedIn: null, command: "make", timeoutSec: 60 }]);
  await settle();
  assert.deepEqual(worker.dispatched[1], { by: "system", op: "interrupted", ticket: T, workId: 5, reason: "the command could not run: host plugin worker exited (0)" }, "the host worker is gone (reload): the job is interrupted");
  const broken = harness({ runCheck: async () => { throw new Error("spawn bash ENOENT"); } });
  broken.executor.reconcile("t", [{ key: "run:run1.3:5", kind: "run", ticket: T, workId: 5, startedIn: null, command: "make", timeoutSec: 60 }]);
  await settle();
  assert.deepEqual(broken.dispatched[1], { by: "system", op: "ran", ticket: T, workId: 5, exitCode: -1, durationMs: 0, tail: "the command could not run: spawn bash ENOENT" }, "any other could-not-run error stays a failed run");
});

test("check: a check that cannot start for another reason than a gone host worker is a failed check, not interrupted", async () => {
  const { executor, dispatched } = harness({ runCheck: async () => { throw new Error("the environment has no workspace path"); } });
  executor.reconcile("t", [{ key: "check:run1.3:4", kind: "check", ticket: T, workId: 4, startedIn: null, checks: [{ ruleKey: "gate.1", command: "a", timeoutSec: 60 }] }]);
  await settle();
  const checked = dispatched[1] as Extract<SystemCommand, { op: "checked" }>;
  assert.equal(checked.op, "checked");
  assert.equal(checked.results["gate.1"]!.ok, false);
  assert.match(checked.results["gate.1"]!.detail, /the command could not run: the environment has no workspace path/);
});

test("check: a check whose command could not run (the host worker exited on a plugin reload) is interrupted, not failed", async () => {
  const ran: string[] = [];
  const { executor, dispatched } = harness({ runCheck: async (_t, input) => { ran.push(input.command); throw new Error("host plugin worker exited (0)"); } });
  executor.reconcile("t", [{ key: "check:run1.3:4", kind: "check", ticket: T, workId: 4, startedIn: null, checks: [{ ruleKey: "gate.1", command: "a", timeoutSec: 60 }, { ruleKey: "gate.2", command: "b", timeoutSec: 60 }] }]);
  await settle();
  assert.deepEqual(ran, ["a"], "the next check does not run");
  assert.deepEqual(dispatched[1], { by: "system", op: "interrupted", ticket: T, workId: 4, reason: "the command could not run: host plugin worker exited (0)" });
});

test("an effect that is no longer desired is aborted and its result is not dispatched", async () => {
  let aborted = false;
  let release: (v: null) => void = () => {};
  const { executor, dispatched } = harness({
    requestInput: (_t, _form, signal) =>
      new Promise((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => { aborted = true; resolve(null); });
      }),
  });
  executor.reconcile("t", [{ key: "ask:run1.3:6", kind: "ask", runId: "run1", ticket: T, formId: 6, form: { rendererId: "gate-approval", title: "Gate", payload: {} } }]);
  await settle();
  executor.reconcile("t", []);
  await settle();
  assert.equal(aborted, true);
  void release;
  assert.deepEqual(dispatched, []);
});

test("ask: a cancelled or timed out form is a rejection", async () => {
  const { executor, dispatched } = harness({ requestInput: async () => null });
  executor.reconcile("t", [{ key: "ask:run1.3:6", kind: "ask", runId: "run1", ticket: T, formId: 6, form: { rendererId: "force-proposal", title: "F", payload: {} } }]);
  await settle();
  assert.deepEqual(dispatched, [{ by: "system", op: "answered", runId: "run1", ticket: T, formId: 6, approved: false }]);
});

test("tell and launch: send, then woke; tellOutcome: send, then outcomeTold", async () => {
  const { executor, calls, dispatched } = harness();
  executor.reconcile("t", [
    { key: "launch:run1.3", kind: "launch", runId: "run1", ticket: T, attempt: 2, text: "/autopilot --lease run1.3 x" },
    { key: "tell:run1:done", kind: "tell", runId: "run1", ticket: null, text: "done" },
    { key: "outcome:run1.3:4", kind: "tellOutcome", ticket: T, workId: 4, text: "refused" },
  ]);
  await settle();
  assert.ok(calls.indexOf("send /autopilot --lease run1.3 x") < calls.indexOf("dispatch woke"));
  assert.deepEqual(dispatched, [
    { by: "system", op: "woke", runId: "run1", ticket: T, kind: "launched", attempt: 2 },
    { by: "system", op: "woke", runId: "run1", ticket: null, kind: "told", attempt: 1 },
    { by: "system", op: "outcomeTold", ticket: T, workId: 4 },
  ]);
});

test("publish: a failed write is logged and forgotten; the next reconcile retries it", async () => {
  let fail = true;
  const { executor, calls, dispatched } = harness({
    writePolicy: async () => {
      if (fail) throw new Error("host offline");
    },
  });
  const publish: Effect = { key: "publish:7", kind: "publish", rev: 7 };
  executor.reconcile("t", [publish]);
  await settle();
  assert.ok(calls.some((c) => c.startsWith("warn") && c.includes("host offline")));
  assert.deepEqual(dispatched, []);
  fail = false;
  executor.reconcile("t", [publish]);
  await settle();
  assert.deepEqual(dispatched, [{ by: "system", op: "published", rev: 7 }]);
});

test("dispose aborts everything in flight", async () => {
  let aborted = 0;
  const { executor } = harness({
    requestInput: (_t, _f, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted++; resolve(null); })),
  });
  executor.reconcile("a", [{ key: "ask:x:1", kind: "ask", runId: "run1", ticket: T, formId: 1, form: { rendererId: "gate-approval", title: "G", payload: {} } }]);
  executor.reconcile("b", [{ key: "ask:x:1", kind: "ask", runId: "run1", ticket: T, formId: 1, form: { rendererId: "gate-approval", title: "G", payload: {} } }]);
  executor.dispose();
  await settle();
  assert.equal(aborted, 2);
});
