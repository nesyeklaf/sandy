import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMachine } from "./machine.ts";
import { createExecutor } from "./effects.ts";
import { createOperations, settledBytes, type OperationDeps } from "./operations.ts";
import { MAX_RUN_BYTES, type Effect, type PolicyFile, type Run, type StartSource } from "./run.ts";

const parsed = parseMachine({
  id: "demo",
  title: "Demo",
  stages: [
    { id: "design", title: "Design", outputs: [{ name: "plan" }], gate: [{ type: "outputs" }], next: [{ to: "build" }] },
    { id: "build", title: "Build", autopilot: { name: "builder" }, gate: [{ type: "check", command: "npm test" }] },
  ],
});
if (!parsed.ok) throw new Error(parsed.error);
const skill: StartSource = { kind: "skill", skill: "demo", machine: parsed.machine };
const checkedParsed = parseMachine({
  id: "checked",
  title: "Checked",
  stages: [
    { id: "design", title: "Design", outputs: [{ name: "plan" }], gate: [{ type: "outputs" }, { type: "check", command: "npm test" }], next: [{ to: "build" }] },
    { id: "build", title: "Build" },
  ],
});
if (!checkedParsed.ok) throw new Error(checkedParsed.error);
const checkedSkill: StartSource = { kind: "skill", skill: "checked", machine: checkedParsed.machine };

type HarnessOptions = {
  failPolicy?: boolean;
  /** Awaited inside save, while the command holds the thread's queue. */
  beforeSave?: (threadId: string, run: Run) => Promise<void>;
  /** Also gets every reconcile (wire an executor here). */
  onEffects?: (threadId: string, effects: Effect[]) => void;
  /** sandy KV refuses a value above this many bytes (256 kB in sandy). */
  maxSaveBytes?: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(opts: HarnessOptions = {}) {
  const clock = { now: 1000 };
  const store = new Map<string, Run | null>();
  const policies: PolicyFile[] = [];
  const reconciled: { threadId: string; effects: Effect[] }[] = [];
  const notified: string[] = [];
  let n = 0;
  const deps: OperationDeps = {
    load: async (t) => structuredClone(store.get(t) ?? null),
    save: async (t, run) => {
      await opts.beforeSave?.(t, run);
      const bytes = Buffer.byteLength(JSON.stringify(run));
      if (opts.maxSaveBytes !== undefined && bytes > opts.maxSaveBytes) throw new Error(`kv value too large: ${bytes} bytes`);
      store.set(t, structuredClone(run));
    },
    writePolicy: async (_t, policy) => {
      if (opts.failPolicy) throw new Error("host offline");
      policies.push(policy);
    },
    effects: (threadId, effects) => {
      reconciled.push({ threadId, effects });
      opts.onEffects?.(threadId, effects);
    },
    notify: (t) => notified.push(t),
    warn: () => {},
    now: () => clock.now,
    newRunId: () => `r${++n}`,
    boot: "boot-a",
  };
  return { ops: createOperations(deps), store, policies, reconciled, notified, clock };
}

test("dispatch commits, writes the policy of the new rev and records its publication before replying", async () => {
  const h = harness();
  const reply = await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  assert.equal(reply.kind, "started");
  const run = h.store.get("t")!;
  assert.equal(run.rev, 1);
  assert.equal(run.publishedRev, 1);
  assert.deepEqual(h.policies.map((p) => [p.rev, p.stage, p.ticket]), [[1, "design", "r1.1"]]);
  assert.deepEqual(h.reconciled.at(-1), { threadId: "t", effects: [] });
  assert.deepEqual(h.notified, ["t"]);
});

test("a failed policy write leaves the run unpublished: mutations reply publishing, the publish effect is desired", async () => {
  const h = harness({ failPolicy: true });
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  assert.equal(h.store.get("t")!.publishedRev, 0);
  assert.deepEqual(h.reconciled.at(-1)!.effects.map((e) => e.kind), ["publish"]);
  const reply = await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "p" } });
  assert.deepEqual(reply, { kind: "publishing", rev: 1 });
});

test("writePolicy (the executor's publish retry) writes only the policy of the current rev", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  await h.ops.writePolicy("t", 1);
  assert.deepEqual(h.policies.map((p) => p.rev), [1, 1]);
  await assert.rejects(h.ops.writePolicy("t", 0), /rev 0 is not current/);
  assert.equal(h.policies.length, 2);
});

test("a meter report is saved and shown but neither bumps the rev nor writes the policy again", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  const policies = h.policies.length;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, messages: 1 };
  const reply = await h.ops.dispatch("t", { by: "meter", op: "usage", ticket: "r1.1", usage });
  assert.equal(reply.kind, "ok");
  const run = h.store.get("t")!;
  assert.deepEqual((run.state as { lease: { usage: unknown } }).lease.usage, usage);
  assert.equal(run.rev, 1);
  assert.equal(run.publishedRev, 1);
  assert.equal(h.policies.length, policies);
  assert.deepEqual(h.notified, ["t", "t"]);
});

test("an unchanged run is not saved, published or notified; effects are still reconciled", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  const before = h.policies.length;
  const reply = await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.9", outputs: { plan: "p" } });
  assert.equal(reply.kind, "stale");
  assert.equal(h.policies.length, before);
  assert.deepEqual(h.notified, ["t"]);
  assert.equal(h.reconciled.length, 2);
});

test("a change that would make the stored run larger than MAX_RUN_BYTES is refused and not saved", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  const big = "x".repeat(MAX_RUN_BYTES);
  const reply = await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: big } });
  assert.equal(reply.kind, "refused");
  assert.equal(h.store.get("t")!.rev, 1);
});

test("a submission is refused when the run could not store it once the gate passes (accepted outputs and last visit copy it)", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: checkedSkill });
  // ~110 kB: the lease fits, but passing copies it into the accepted outputs and the stage's last visit.
  const reply = await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "x".repeat(110_000) } });
  assert.equal(reply.kind, "refused");
  assert.equal(h.store.get("t")!.rev, 1);
});

test("a gate settlement that would not fit the stored run is never refused: the work ends in an unsaved outcome the driver can act on", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: checkedSkill });
  await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "p" } });
  assert.equal((await h.ops.dispatch("t", { by: "agent", op: "advance", ticket: "r1.1" })).kind, "pending");
  // A run stored before the reservation existed: its submissions fit once but not twice.
  const stored = h.store.get("t")!;
  const active = stored.state as Extract<Run["state"], { kind: "active" }>;
  active.lease.submissions.outputs.plan = "x".repeat(120_000);
  const check = h.reconciled.at(-1)!.effects.find((e) => e.kind === "check")!;
  assert.equal(check.kind, "check");
  const results = Object.fromEntries((check.kind === "check" ? check.checks : []).map((c) => [c.ruleKey, { ok: true, detail: "exit 0", at: 1 }]));
  const reply = await h.ops.dispatch("t", { by: "system", op: "checked", ticket: "r1.1" as never, workId: check.workId, results });
  assert.equal(reply.kind, "ok");
  const run = h.store.get("t")!;
  assert.equal(run.state.kind, "active");
  const lease = (run.state as Extract<Run["state"], { kind: "active" }>).lease;
  assert.equal(lease.stage, "design", "the gate did not pass into an unstorable run");
  assert.equal(lease.work, null, "the gate job is not left pending");
  assert.equal(lease.outcome?.kind, "unsaved");
  assert.deepEqual(h.reconciled.at(-1)!.effects.map((e) => e.kind), ["tellOutcome"], "the driver hears it");
  assert.equal((await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "short" } })).kind, "accepted", "the driver can shorten and advance again");
});

const KV_LIMIT = 256 * 1024;
const userGateSource = (title: string): StartSource => {
  const m = parseMachine({
    id: "approved",
    title: "Approved",
    stages: [
      { id: "design", title, outputs: [{ name: "plan" }], gate: [{ type: "outputs" }, { type: "user", prompt: "ok?" }], next: [{ to: "build" }] },
      { id: "build", title: "Build" },
    ],
  });
  if (!m.ok) throw new Error(m.error);
  return { kind: "skill", skill: "approved", machine: m.machine };
};
const leaseOf = (run: Run) => (run.state as Extract<Run["state"], { kind: "active" }>).lease;

test("an owner approval never copies a machine's long stage title into the stored run: the run stays under sandy's KV limit", async () => {
  const h = harness({ maxSaveBytes: KV_LIMIT });
  await h.ops.dispatch("t", { by: "agent", op: "start", source: userGateSource("T".repeat(140_000)) });
  await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "p" } });
  assert.equal((await h.ops.dispatch("t", { by: "agent", op: "advance", ticket: "r1.1" })).kind, "pending");
  const ask = h.reconciled.at(-1)!.effects.find((e) => e.kind === "ask")!;
  assert.equal(ask.kind, "ask");
  const reply = await h.ops.dispatch("t", { by: "system", op: "answered", runId: "r1", ticket: "r1.1", formId: ask.kind === "ask" ? ask.formId : 0, approved: true });
  assert.equal(reply.kind, "ok");
  const run = h.store.get("t")!;
  assert.equal(leaseOf(run).stage, "build", "the approval passed the gate");
  assert.ok(leaseOf(run).causeText.length <= 500, `causeText is bounded (${leaseOf(run).causeText.length})`);
});

/**
 * An active run at design whose pending work is answered by a form, stored before reservations. Gate: its submissions
 * fit once, not in the accepted outputs and last visit too (> KV limit). Force proposal: the run is just under
 * MAX_RUN_BYTES, so the closed-lease row the approval adds tips it over.
 */
async function oversizedAsk(h: ReturnType<typeof harness>, work: "gate" | "force-proposal") {
  await h.ops.dispatch("t", { by: "agent", op: "start", source: userGateSource("Design") });
  await h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "p" } });
  const pending = work === "gate" ? await h.ops.dispatch("t", { by: "agent", op: "advance", ticket: "r1.1" }) : await h.ops.dispatch("t", { by: "agent", op: "proposeForce", ticket: "r1.1", to: "build", reason: "stuck" });
  assert.equal(pending.kind, "pending");
  const stored = h.store.get("t")!;
  const filler = MAX_RUN_BYTES - 50 - Buffer.byteLength(JSON.stringify(stored));
  leaseOf(stored).submissions.outputs.plan = "x".repeat(work === "gate" ? 140_000 : filler);
  const ask = h.reconciled.at(-1)!.effects.find((e) => e.kind === "ask")!;
  return ask.kind === "ask" ? ask.formId : -1;
}

for (const work of ["gate", "force-proposal"] as const) {
  test(`an approved ${work} whose settlement would not fit the stored run ends in an unsaved outcome, never a failed save`, async () => {
    const h = harness({ maxSaveBytes: KV_LIMIT });
    const formId = await oversizedAsk(h, work);
    const reply = await h.ops.dispatch("t", { by: "system", op: "answered", runId: "r1", ticket: "r1.1", formId, approved: true });
    assert.equal(reply.kind, "ok");
    const lease = leaseOf(h.store.get("t")!);
    assert.equal(lease.stage, "design");
    assert.equal(lease.work, null, "the answered work is not left pending");
    assert.deepEqual([lease.outcome?.kind, lease.outcome?.kind === "unsaved" ? lease.outcome.what : null], ["unsaved", work]);
    assert.ok(h.reconciled.at(-1)!.effects.some((e) => e.kind === "tellOutcome"), "the driver hears it");
  });
}

test("late meter reports that would push the run past MAX_RUN_BYTES are ignored: the size invariant holds and the owner can still abort", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "agent", op: "start", source: skill });
  const stored = h.store.get("t")!;
  const row = { seq: 1, stage: "design", driver: { kind: "agent" }, cause: { kind: "start" }, mintedAt: 1, endedAt: 2, end: { kind: "passed" }, usage: null, usagePartial: false, ran: [] };
  stored.log = Array.from({ length: 50 }, (_, i) => ({ ...row, seq: i + 2 })) as never;
  leaseOf(stored).submissions.outputs.plan = "x".repeat(Math.floor((MAX_RUN_BYTES - 1000 - settledBytes(stored)) / 2));
  assert.ok(settledBytes(stored) <= MAX_RUN_BYTES, "the stored run starts within the limit");
  const big = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, total: 4_000_000, messages: 1 };
  const replies: string[] = [];
  for (let seq = 2; seq <= 51; seq++) replies.push((await h.ops.dispatch("t", { by: "meter", op: "usage", ticket: `r1.${seq}`, usage: big })).kind);
  const after = h.store.get("t")!;
  assert.ok(replies.includes("ok") && replies.includes("refused"), `some reports fit, the rest are refused: ${replies.join(",")}`);
  assert.ok(settledBytes(after) <= MAX_RUN_BYTES, `settled size ${settledBytes(after)} within ${MAX_RUN_BYTES}`);
  assert.ok(Buffer.byteLength(JSON.stringify(after)) <= MAX_RUN_BYTES);
  assert.equal((await h.ops.dispatch("t", { by: "owner", op: "abort", reason: "stop" })).kind, "ok", "the owner can still abort");
  assert.equal(h.store.get("t")!.state.kind, "aborted");
});

test("commands of one thread run one at a time, in order", async () => {
  const h = harness();
  const replies = await Promise.all([
    h.ops.dispatch("t", { by: "agent", op: "start", source: skill }),
    h.ops.dispatch("t", { by: "agent", op: "submit", ticket: "r1.1", outputs: { plan: "p" } }),
    h.ops.dispatch("t", { by: "agent", op: "advance", ticket: "r1.1" }),
  ]);
  assert.deepEqual(replies.map((r) => r.kind), ["started", "accepted", "entered"]);
  assert.equal(h.store.get("t")!.rev, 3);
});

test("recover after a restart turns work started by another boot into interrupted", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "driver", op: "start", source: skill, autopilot: { name: "all" } });
  await h.ops.dispatch("t", { by: "driver", op: "claim", ticket: "r1.1", invocation: "i" });
  await h.ops.dispatch("t", { by: "driver", op: "run", grant: "r1.1.i", label: "tests", command: "npm test" });
  await h.ops.dispatch("t", { by: "system", op: "workStarted", ticket: "r1.1" as never, workId: 2, boot: "boot-old" });
  await h.ops.recover(["t", "empty"]);
  const run = h.store.get("t")!;
  assert.equal(run.state.kind, "active");
  const lease = (run.state as Extract<Run["state"], { kind: "active" }>).lease;
  assert.equal(lease.work, null);
  assert.equal(lease.outcome?.kind, "interrupted");
  assert.equal(h.store.has("empty"), false, "no run, nothing saved");
});

test("tick expires deadlines of every thread", async () => {
  const h = harness();
  await h.ops.dispatch("t", { by: "driver", op: "start", source: skill, autopilot: { name: "all" } });
  await h.ops.dispatch("t", { by: "driver", op: "claim", ticket: "r1.1", invocation: "i" });
  await h.ops.tick(["t"]);
  assert.equal((h.store.get("t")!.state as Extract<Run["state"], { kind: "active" }>).lease.driver.kind, "autopilot", "claim still fresh");
  h.clock.now = 1000 + 91_000;
  await h.ops.tick(["t"]);
  const lease = (h.store.get("t")!.state as Extract<Run["state"], { kind: "active" }>).lease;
  assert.deepEqual(lease.driver, { kind: "agent" });
  assert.equal(lease.cause, "expired");
});

test("an approval answered for an aborted ad-hoc run, queued behind the start of the next one, does not approve the next one", async () => {
  const adhoc: StartSource = { kind: "adhoc", machine: { id: "adhoc", title: "Ad hoc", stages: [{ id: "s", title: "S" }] } };
  const answers: ReturnType<typeof deferred<{ approved: boolean } | null>>[] = [];
  const answerQueued = deferred<void>();
  let holdAbort: Promise<void> | null = null;
  const h = harness({
    beforeSave: async (_t, run) => {
      if (run.state.kind === "aborted" && holdAbort) await holdAbort;
    },
    onEffects: (t, effects) => executor.reconcile(t, effects),
  });
  const executor = createExecutor(
    {
      runCheck: async () => ({ exitCode: 0, durationMs: 0, tail: "" }),
      requestInput: () => {
        const answer = deferred<{ approved: boolean } | null>();
        answers.push(answer);
        return answer.promise;
      },
      send: async () => {},
      writePolicy: (t, rev) => h.ops.writePolicy(t, rev),
      warn: () => {},
    },
    (t, command) => {
      const reply = h.ops.dispatch(t, command);
      if (command.op === "answered") answerQueued.resolve();
      return reply;
    },
    "boot-a",
  );
  assert.equal((await h.ops.dispatch("t", { by: "agent", op: "start", source: adhoc })).kind, "proposed");
  assert.equal(answers.length, 1, "run A asks the owner");
  // The owner aborts A. While the abort holds the queue (before it reconciles A's ask away), the agent starts B and
  // the owner's answer to A's form arrives; both queue behind the abort, B first.
  const release = deferred<void>();
  holdAbort = release.promise;
  const aborted = h.ops.dispatch("t", { by: "owner", op: "abort", reason: "wrong track" });
  const startedB = h.ops.dispatch("t", { by: "agent", op: "start", source: adhoc });
  answers[0]!.resolve({ approved: true });
  await answerQueued.promise;
  release.resolve();
  await aborted;
  assert.equal((await startedB).kind, "proposed");
  await new Promise((resolve) => setImmediate(resolve));
  const run = h.store.get("t")!;
  assert.equal(run.runId, "r2");
  assert.equal(run.state.kind, "proposed", "B waits for its own approval");
  executor.dispose();
});
