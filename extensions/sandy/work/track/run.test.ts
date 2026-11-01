import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMachine, type Machine } from "./machine.ts";
import {
  HEARTBEAT_SEC, LAUNCH_GRACE_SEC, LOG_LIMIT, PREVIOUS_VALUE_CHARS, TAIL_CHARS, TEXT_EVIDENCE_CHARS,
  desired, driverFor, endText, grantOf, parseLeaseRef, policyFor, stationOf, statusText, step, ticketOf, toldBy, waitingOf,
  type Command, type Lease, type Reply, type Run, type StartSource,
} from "./run.ts";

// Constant clock: every step in a test runs at a time the test names; nothing reads Date.now().
const T0 = 1_000_000;
const parsed = parseMachine({
  id: "demo",
  title: "Demo",
  stages: [
    { id: "design", title: "Design", outputs: [{ name: "plan" }, { name: "notes", optional: true }], gate: [{ type: "outputs" }], next: [{ to: "build" }] },
    {
      id: "build",
      title: "Build",
      inputs: ["design.plan"],
      outputs: [{ name: "result" }],
      autopilot: { name: "builder", args: "go fast" },
      gate: [{ type: "outputs" }, { type: "check", command: "npm test", timeoutSec: 60 }, { type: "evidence", name: "tests", ran: true }],
      next: [{ to: "review" }],
    },
    { id: "review", title: "Review", outputs: [{ name: "verdict" }], gate: [{ type: "outputs" }, { type: "user", prompt: "ok?" }], next: [{ to: "design" }, { to: "ship" }] },
    { id: "ship", title: "Ship", gate: [{ type: "evidence", name: "note" }] },
  ],
});
if (!parsed.ok) throw new Error(parsed.error);
const machine: Machine = parsed.machine;
const skill: StartSource = { kind: "skill", skill: "demo", machine };

function idsFrom(prefix = "run") {
  let n = 0;
  return { newRunId: () => `${prefix}${++n}` };
}

/** step + published, as operations commits: the policy of every committed rev is written. */
function commit(run: Run | null, command: Command, now = T0, ids = idsFrom()): { run: Run; reply: Reply } {
  const out = step(run, command, now, ids);
  assert.ok(out.run, "commit expects a run");
  const published = step(out.run, { by: "system", op: "published", rev: out.run.rev, ...toldBy(command, out.reply) }, now, ids);
  return { run: published.run!, reply: out.reply };
}

const lease = (run: Run): Lease => {
  assert.equal(run.state.kind, "active");
  return (run.state as { kind: "active"; lease: Lease }).lease;
};
const ticket = (run: Run) => ticketOf(run, lease(run));

function agentRun(): Run {
  return commit(null, { by: "agent", op: "start", source: skill }).run;
}

/** An active run at stage build, driven by autopilot builder, claimed by invocation "inv1". */
function claimedBuild(): { run: Run; grant: string } {
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "p" } }).run;
  run = commit(run, { by: "agent", op: "advance", ticket: ticket(run) }).run;
  assert.equal(lease(run).stage, "build");
  const out = commit(run, { by: "driver", op: "claim", ticket: ticket(run), invocation: "inv1" });
  assert.equal(out.reply.kind, "claimed");
  return { run: out.run, grant: (out.reply as { grant: string }).grant };
}

test("tickets and grants are derived from run id, seq and invocation; malformed refs parse to null", () => {
  const { run, grant } = claimedBuild();
  assert.equal(ticket(run), `run1.${lease(run).seq}`);
  assert.equal(grant, `run1.${lease(run).seq}.inv1`);
  assert.equal(grantOf(run, lease(run)), grant);
  assert.deepEqual(parseLeaseRef(grant), { runId: "run1", seq: lease(run).seq, invocation: "inv1" });
  assert.deepEqual(parseLeaseRef("run1.3"), { runId: "run1", seq: 3, invocation: null });
  for (const bad of ["", "run1", "run1.x", "run1.3.a.b", ".3", "run1.-1", "run1.3."]) assert.equal(parseLeaseRef(bad), null, bad);
});

test("driverFor: owner stage override > owner track override > template autopilot > agent", () => {
  const ap = (name: string) => ({ kind: "autopilot" as const, name });
  const cases: [Parameters<typeof driverFor>[1], string, unknown][] = [
    [{ stages: {} }, "design", { kind: "agent" }],
    [{ stages: {} }, "build", { kind: "autopilot", name: "builder", args: "go fast" }],
    [{ track: ap("all"), stages: {} }, "design", ap("all")],
    [{ track: ap("all"), stages: {} }, "build", ap("all")],
    [{ track: ap("all"), stages: { build: { kind: "agent" } } }, "build", { kind: "agent" }],
    [{ stages: { design: ap("x") } }, "design", ap("x")],
  ];
  for (const [plan, stage, want] of cases) assert.deepEqual(driverFor(machine, plan, stage), want, `${JSON.stringify(plan)} ${stage}`);
});

test("agent start mints lease 1; the reply tells the agent only once its rev is published, otherwise a message does", () => {
  const out = step(null, { by: "agent", op: "start", source: skill }, T0, idsFrom());
  assert.equal(out.reply.kind, "started");
  const run = out.run!;
  assert.equal(run.rev, 1);
  assert.equal(run.publishedRev, 0);
  assert.equal(lease(run).seq, 1);
  assert.equal(lease(run).cause, "start");
  assert.deepEqual(lease(run).wake, { kind: "none" }, "not told before the policy is written");
  assert.deepEqual(desired(run).map((e) => e.kind), ["publish"]);
  assert.deepEqual(toldBy({ by: "agent", op: "start", source: skill }, out.reply), { told: ticket(run), replied: true });
  assert.deepEqual(run.pendingTell, { rev: 1 });
  const published = step(run, { by: "system", op: "published", rev: 1, told: ticket(run), replied: true }, T0, idsFrom()).run!;
  assert.equal(published.pendingTell, null);
  assert.equal(published.rev, 1, "published does not bump rev");
  assert.deepEqual(lease(published).wake, { kind: "told", at: T0 }, "the agent learned its ticket from the tool result");
  assert.deepEqual(desired(published), []);
  // Published by the executor's retry (the commit's own write failed, so its reply was no success): a message tells.
  const retried = step(run, { by: "system", op: "published", rev: 1 }, T0, idsFrom()).run!;
  assert.deepEqual(desired(retried).map((e) => e.kind), ["tell"], "the lease's tell covers the owed message");
  const told = step(retried, { by: "system", op: "woke", runId: "run1", ticket: ticket(run), kind: "told", attempt: 1 }, T0, idsFrom()).run!;
  assert.equal(told.pendingTell, null);
});

test("an agent call that mints no lease is owed a message when its own commit could not publish; told once, after the retry", () => {
  const run = agentRun();
  const out = step(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "p" } }, T0, idsFrom());
  assert.equal(out.reply.kind, "accepted");
  assert.deepEqual(out.run!.pendingTell, { rev: out.run!.rev });
  assert.deepEqual(desired(out.run).map((e) => e.kind), ["publish"], "nothing is told before publication");
  const retried = step(out.run, { by: "system", op: "published", rev: out.run!.rev }, T0, idsFrom()).run!;
  const [tell] = desired(retried);
  assert.equal(tell?.kind, "tellPending");
  assert.match((tell as { text: string }).text, /in effect[\s\S]*plan = p/);
  const told = step(retried, { by: "system", op: "pendingTold", runId: "run1", rev: out.run!.rev }, T0, idsFrom()).run!;
  assert.equal(told.pendingTell, null);
  assert.deepEqual(desired(told).map((e) => e.kind), ["publish"]);
  assert.equal(step(told, { by: "system", op: "pendingTold", runId: "run1", rev: out.run!.rev }, T0, idsFrom()).run, told, "a repeated report is inert");
  // Published in its own commit (replied): the tool result was the success, no message.
  assert.deepEqual(desired(commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "p" } }).run), []);
});

test("driver start with autopilot sets the track driver; launch waits for publication", () => {
  const out = step(null, { by: "driver", op: "start", source: skill, autopilot: { name: "delivery", args: "x" } }, T0, idsFrom());
  const run = out.run!;
  assert.deepEqual(run.plan, { track: { kind: "autopilot", name: "delivery", args: "x" }, stages: {} });
  assert.deepEqual(lease(run).driver, { kind: "autopilot", name: "delivery", args: "x" });
  assert.deepEqual(desired(run).map((e) => e.kind), ["publish"], "no launch before the policy of this rev is written");
  const published = step(run, { by: "system", op: "published", rev: run.rev }, T0, idsFrom()).run!;
  const launch = desired(published).find((e) => e.kind === "launch");
  assert.ok(launch && launch.kind === "launch");
  assert.equal(launch.text, `/autopilot --lease ${ticket(run)} delivery x`);
  assert.equal(launch.attempt, 1);
  assert.ok(launch.key.includes(ticket(run)));
});

test("start refuses while a track is active; an ad-hoc machine is proposed and asked", () => {
  const run = agentRun();
  const again = step(run, { by: "agent", op: "start", source: skill }, T0, idsFrom());
  assert.equal(again.reply.kind, "refused");
  assert.equal(again.run, run);

  const bad = step(null, { by: "agent", op: "start", source: { kind: "adhoc", machine: { id: "x" } } }, T0, idsFrom());
  assert.equal(bad.reply.kind, "refused");
  assert.equal(bad.run, null);

  const proposed = commit(null, { by: "agent", op: "start", source: { kind: "adhoc", machine }, note: "why" });
  assert.equal(proposed.reply.kind, "proposed");
  assert.equal(proposed.run.state.kind, "proposed");
  const ask = desired(proposed.run).find((e) => e.kind === "ask");
  assert.ok(ask && ask.kind === "ask" && ask.ticket === null && ask.form.rendererId === "track-approval");
  const formId = ask.formId;
  const late = step(proposed.run, { by: "system", op: "answered", runId: "run1", ticket: null, formId: formId + 1, approved: true }, T0, idsFrom());
  assert.equal(late.run, proposed.run, "an answer for another form is inert");
  assert.equal(ask.runId, "run1");
  const otherRun = step(proposed.run, { by: "system", op: "answered", runId: "run0", ticket: null, formId, approved: true }, T0, idsFrom());
  assert.equal(otherRun.run, proposed.run, "an answer to the same form id of an earlier run is inert");
  const approved = commit(proposed.run, { by: "system", op: "answered", runId: "run1", ticket: null, formId, approved: true });
  assert.equal(lease(approved.run).stage, "design");
  assert.deepEqual(lease(approved.run).wake, { kind: "none" }, "the agent is told by message after an owner answer");
  assert.ok(desired(approved.run).some((e) => e.kind === "tell"));
  const rejected = commit(proposed.run, { by: "system", op: "answered", runId: "run1", ticket: null, formId, approved: false });
  assert.equal(rejected.run.state.kind, "aborted");
});

test("S1: commands naming a stale ticket or grant leave the run unchanged (same object)", () => {
  const { run, grant } = claimedBuild();
  const t = ticket(run);
  const oldTicket = `run1.${lease(run).seq - 1}`;
  const cases: [string, Command, string[]][] = [
    ["agent submit, old seq", { by: "agent", op: "submit", ticket: oldTicket, outputs: { plan: "x" } }, ["closed"]],
    ["agent submit on an autopilot lease", { by: "agent", op: "submit", ticket: t, outputs: { result: "x" } }, ["stale"]],
    ["agent advance, other run", { by: "agent", op: "advance", ticket: `other.${lease(run).seq}` }, ["stale"]],
    ["agent propose, malformed", { by: "agent", op: "proposeForce", ticket: "nonsense", to: "design", reason: "r" }, ["stale"]],
    ["driver submit with a ticket, not a grant", { by: "driver", op: "submit", grant: t, outputs: { result: "x" } }, ["stale"]],
    ["driver submit, other invocation", { by: "driver", op: "submit", grant: `${t}.inv2`, outputs: { result: "x" } }, ["stale"]],
    ["driver run, old seq", { by: "driver", op: "run", grant: `${oldTicket}.inv1`, label: "tests", command: "true" }, ["closed"]],
    ["driver advance, other run", { by: "driver", op: "advance", grant: grant.replace("run1", "run9") }, ["stale"]],
    ["driver release, other invocation", { by: "driver", op: "release", grant: `${t}.zzz`, reason: "r" }, ["stale"]],
    ["driver claim, other invocation", { by: "driver", op: "claim", ticket: t, invocation: "inv2" }, ["stale"]],
    ["driver claim, old seq", { by: "driver", op: "claim", ticket: oldTicket, invocation: "inv1" }, ["closed"]],
    ["driver status, other invocation", { by: "driver", op: "status", lease: `${t}.inv2` }, ["stale"]],
    ["system checked, old ticket", { by: "system", op: "checked", ticket: oldTicket as never, workId: 1, results: {} }, ["stale"]],
    ["system ran, no work", { by: "system", op: "ran", ticket: t as never, workId: 99, exitCode: 0, durationMs: 1, tail: "" }, ["stale"]],
    ["system answered, no form", { by: "system", op: "answered", runId: run?.runId ?? "run1", ticket: t as never, formId: 99, approved: true }, ["stale"]],
    ["system woke, old ticket", { by: "system", op: "woke", runId: "run1", ticket: oldTicket as never, kind: "launched", attempt: 1 }, ["stale"]],
    ["system workStarted, no work", { by: "system", op: "workStarted", ticket: t as never, workId: 99, boot: "b" }, ["stale"]],
    ["system outcomeTold, no outcome", { by: "system", op: "outcomeTold", ticket: t as never, workId: 99 }, ["stale"]],
  ];
  for (const [name, command, kinds] of cases) {
    const out = step(run, command, T0, idsFrom());
    assert.equal(out.run, run, name);
    assert.ok(kinds.includes(out.reply.kind), `${name}: ${out.reply.kind}`);
  }
  const closed = step(run, { by: "agent", op: "submit", ticket: oldTicket, outputs: {} }, T0, idsFrom()).reply;
  assert.ok(closed.kind === "closed" && closed.end.kind === "advanced" && closed.current?.ticket === t, "closed names how it ended and the current lease");
});

test("S5: while the policy of the current rev is unpublished, mutations reply publishing", () => {
  const run = step(null, { by: "agent", op: "start", source: skill }, T0, idsFrom()).run!;
  const t = ticket(run);
  for (const command of [
    { by: "agent", op: "submit", ticket: t, outputs: { plan: "x" } },
    { by: "agent", op: "advance", ticket: t },
    { by: "agent", op: "proposeForce", ticket: t, to: "ship", reason: "r" },
  ] as Command[]) {
    const out = step(run, command, T0, idsFrom());
    assert.equal(out.run, run);
    assert.deepEqual(out.reply, { kind: "publishing", rev: 1 });
  }
  assert.equal(step(run, { by: "agent", op: "status" }, T0, idsFrom()).reply.kind, "current", "reads are not held back");
  assert.equal(step(run, { by: "system", op: "published", rev: 0 }, T0, idsFrom()).run, run, "an older publication is inert");
});

test("a closed lease's usage is final only when its driver's own closing call reported it; otherwise the total is marked partial", () => {
  const u = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, messages: 1 });
  const row = (run: Run) => run.log.at(-1)!;
  // Submit reports 10 tokens, more model work happens, then the owner forces: the 10 are a checkpoint, not the total.
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "p" }, usage: u(10) }).run;
  const forced = commit(run, { by: "owner", op: "force", to: "review" }).run;
  assert.deepEqual(row(forced).usage, u(10));
  assert.equal(row(forced).usagePartial, true, "a forced lease's last checkpoint is partial");
  // Advancing with a usage report closes the lease on the driver's own call: final.
  const advanced = commit(run, { by: "agent", op: "advance", ticket: ticket(run), usage: u(12) }).run;
  assert.deepEqual(row(advanced).usage, u(12));
  assert.equal(row(advanced).usagePartial, false);
  // A release with usage is final; a release without it keeps the checkpoint as partial.
  const { run: claimed, grant } = claimedBuild();
  const released = commit(claimed, { by: "driver", op: "release", grant, reason: "done", usage: u(30) }).run;
  assert.equal(row(released).usagePartial, false);
  const measured = commit(claimed, { by: "driver", op: "submit", grant, outputs: { result: "r" }, usage: u(20) }).run;
  assert.equal(row(commit(measured, { by: "driver", op: "release", grant, reason: "done" }).run).usagePartial, true);
  // Never measured stays unknown, not partial.
  const unknown = commit(agentRun(), { by: "owner", op: "force", to: "review" }).run;
  assert.equal(row(unknown).usage, null);
  assert.equal(row(unknown).usagePartial, false);
});

const meterUsage = (total: number, messages = 1) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, messages });
const meterStep = (run: Run | null, ref: string, usage: ReturnType<typeof meterUsage>) => step(run, { by: "meter", op: "usage", ticket: ref, usage }, T0, idsFrom());

test("meter usage: the guard's late report sets the current lease's checkpoint and completes a closed row of this run", () => {
  const u = meterUsage;
  // Current lease: a checkpoint; the run's rev, state and policy stay as they are.
  let run = agentRun();
  const first = ticket(run);
  const current = meterStep(run, first, u(10));
  assert.equal(current.reply.kind, "ok");
  assert.deepEqual(lease(current.run!).usage, u(10));
  assert.equal(current.run!.rev, run.rev, "a measurement is no committed change: no rev, no policy");
  assert.equal(current.run!.pendingTell, run.pendingTell);
  // A forced lease: partial checkpoint, then the late report completes the row.
  run = commit(current.run!, { by: "owner", op: "force", to: "review" }).run;
  assert.equal(run.log.at(-1)!.usagePartial, true);
  const late = meterStep(run, first, u(25, 3));
  assert.equal(late.reply.kind, "ok");
  assert.deepEqual(late.run!.log.at(-1)!.usage, u(25, 3));
  assert.equal(late.run!.log.at(-1)!.usagePartial, false);
  assert.equal(late.run!.rev, run.rev);
  assert.equal(lease(late.run!).seq, lease(run).seq, "the current lease is untouched");
  // A row never measured (a lease closed with no submit) gets its usage.
  const fresh = agentRun();
  const bare = commit(fresh, { by: "owner", op: "force", to: "review" }).run;
  assert.equal(bare.log.at(-1)!.usage, null);
  assert.deepEqual(meterStep(bare, ticket(fresh), u(7, 2)).run!.log.at(-1)!.usage, u(7, 2));
});

test("meter usage: a report of an older measurement, another run or an unknown lease is ignored", () => {
  const u = meterUsage;
  let run = agentRun();
  const first = ticket(run);
  run = commit(run, { by: "agent", op: "submit", ticket: first, outputs: { plan: "p" }, usage: u(20, 2) }).run;
  const older = meterStep(run, first, u(10, 1));
  assert.equal(older.run, run);
  assert.equal(older.reply.kind, "stale");
  const closed = commit(run, { by: "agent", op: "advance", ticket: first, usage: u(30, 3) }).run;
  assert.equal(meterStep(closed, first, u(10, 1)).run, closed, "older than the closed row's usage");
  assert.equal(meterStep(closed, "other.1", u(99, 9)).run, closed, "another run");
  assert.equal(meterStep(closed, "run1.999", u(99, 9)).run, closed, "no such lease");
  assert.equal(meterStep(closed, "run1.1.inv", u(99, 9)).run, closed, "a grant is no ticket");
  assert.equal(meterStep(closed, "garbage", u(99, 9)).reply.kind, "stale");
  assert.equal(meterStep(null, first, u(1, 1)).reply.kind, "none");
});

test("meter usage: a report that lowers any cumulative counter is ignored, an equal or higher one is kept (message count alone does not order reports)", () => {
  const full = (over: Partial<ReturnType<typeof meterUsage>>) => ({ input: 100, output: 20, cacheRead: 30, cacheWrite: 40, total: 190, messages: 2, ...over });
  let run = agentRun();
  const first = ticket(run);
  run = commit(run, { by: "agent", op: "submit", ticket: first, outputs: { plan: "p" }, usage: full({}) }).run;
  // Current checkpoint: same messages with fewer tokens is an older snapshot.
  const smaller = meterStep(run, first, meterUsage(10, 2));
  assert.equal(smaller.run, run, "equal messages, smaller tokens vs the checkpoint");
  assert.equal(smaller.reply.kind, "stale");
  for (const lowered of [{ input: 99 }, { output: 19 }, { cacheRead: 29 }, { cacheWrite: 39 }, { total: 189 }, { messages: 1 }]) {
    assert.equal(meterStep(run, first, full(lowered)).run, run, `lowering ${Object.keys(lowered)[0]} is rejected`);
  }
  assert.equal(meterStep(run, first, full({ messages: 3, total: 100 })).run, run, "a mixed report (messages up, total down) is rejected");
  assert.deepEqual(lease(meterStep(run, first, full({ messages: 3, total: 250, output: 80 })).run!).usage, full({ messages: 3, total: 250, output: 80 }), "higher on some, equal on the rest");
  // A fully measured closed row.
  const closed = commit(run, { by: "agent", op: "advance", ticket: first, usage: full({}) }).run;
  assert.equal(closed.log.at(-1)!.usagePartial, false);
  assert.equal(meterStep(closed, first, meterUsage(10, 2)).run, closed, "equal messages, smaller tokens vs a fully measured closed row");
  assert.equal(meterStep(closed, first, full({ messages: 3, total: 100 })).run, closed, "a mixed report on a closed row");
  assert.deepEqual(meterStep(closed, first, full({ total: 200 })).run!.log.at(-1)!.usage, full({ total: 200 }));
  // Equal values still complete a partial row.
  const partialRun = commit(run, { by: "owner", op: "force", to: "review" }).run;
  assert.equal(partialRun.log.at(-1)!.usagePartial, true);
  const done = meterStep(partialRun, first, full({}));
  assert.equal(done.reply.kind, "ok");
  assert.equal(done.run!.log.at(-1)!.usagePartial, false);
});

test("meter usage: the row of a run that is done or aborted is completed too", () => {
  let run = agentRun();
  const first = ticket(run);
  const aborted = commit(run, { by: "owner", op: "abort", reason: "enough" }).run;
  assert.equal(aborted.state.kind, "aborted");
  assert.equal(aborted.log.at(-1)!.usage, null);
  const out = meterStep(aborted, first, meterUsage(40, 2));
  assert.equal(out.reply.kind, "ok");
  assert.deepEqual(out.run!.log.at(-1)!.usage, meterUsage(40, 2));
  assert.equal(out.run!.state.kind, "aborted");
  assert.equal(out.run!.rev, aborted.rev);
  // Finished run: the last stage's lease is closed, the run is done.
  run = commit(run, { by: "owner", op: "force", to: "ship" }).run;
  const shipTicket = ticket(run);
  run = commit(run, { by: "agent", op: "submit", ticket: shipTicket, evidence: { note: "n" } }).run;
  const done = commit(run, { by: "agent", op: "advance", ticket: shipTicket }).run;
  assert.equal(done.state.kind, "done");
  const finished = meterStep(done, shipTicket, meterUsage(40, 2));
  assert.equal(finished.reply.kind, "ok");
  assert.deepEqual(finished.run!.log.at(-1)!.usage, meterUsage(40, 2));
});

test("meter usage: a gate that settles after the advance leaves the row partial until the guard's report completes it", () => {
  const u = meterUsage(9);
  const { run: claimed, grant } = claimedBuild();
  const t = ticket(claimed) as never;
  let run = commit(claimed, { by: "driver", op: "submit", grant, outputs: { result: "r" } }).run;
  const started = commit(run, { by: "driver", op: "run", grant, label: "tests", command: "npm test" });
  run = commit(started.run, { by: "system", op: "ran", ticket: t, workId: (started.reply as { workId: number }).workId, exitCode: 0, durationMs: 1, tail: "ok" }).run;
  const advanced = commit(run, { by: "driver", op: "advance", grant, usage: u });
  assert.equal(advanced.reply.kind, "pending");
  const check = desired(advanced.run).find((e) => e.kind === "check");
  assert.ok(check && check.kind === "check");
  const settled = commit(advanced.run, { by: "system", op: "checked", ticket: t, workId: (advanced.reply as { workId: number }).workId, results: { [check.checks[0]!.ruleKey]: { ok: true, detail: "exit 0", at: T0 } } }).run;
  assert.equal(settled.log.at(-1)!.usagePartial, true, "pass() closed the lease without the advance's final usage");
  const metered = meterStep(settled, t, u);
  assert.equal(metered.run!.log.at(-1)!.usagePartial, false);
  assert.deepEqual(metered.run!.log.at(-1)!.usage, u);
});

test("what a transition copies into the run is capped: previous-visit values, autopilot args, run commands", () => {
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "p".repeat(PREVIOUS_VALUE_CHARS * 3) } }).run;
  const reentered = commit(commit(run, { by: "owner", op: "force", to: "review" }).run, { by: "owner", op: "force", to: "design" }).run;
  assert.ok(lease(reentered).previous!.submissions.outputs.plan!.length <= PREVIOUS_VALUE_CHARS, "previous carries a clipped copy");
  assert.equal(reentered.lastVisit.design!.submissions.outputs.plan!.length, PREVIOUS_VALUE_CHARS * 3, "the last visit itself is kept whole");
  const longArgs = { by: "owner", op: "setDriver", scope: "track", choice: { kind: "autopilot", name: "builder", args: "a".repeat(501) } } as const;
  assert.equal(step(run, longArgs, T0, idsFrom()).reply.kind, "refused");
  assert.equal(step(null, { by: "driver", op: "start", source: skill, autopilot: { name: "b".repeat(49) } }, T0, idsFrom()).reply.kind, "refused");
  const { run: claimed, grant } = claimedBuild();
  assert.equal(step(claimed, { by: "driver", op: "run", grant, label: "t", command: "x".repeat(4001) }, T0, idsFrom()).reply.kind, "refused");
});

test("submit validates names, clips text evidence, merges outputs and records usage", () => {
  let run = agentRun();
  const unknown = step(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { nope: "x" }, evidence: { what: "y" } }, T0, idsFrom());
  assert.equal(unknown.reply.kind, "refused");
  assert.equal(unknown.run, run);
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "a" } }).run;
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, messages: 1 };
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { notes: "n" }, usage }).run;
  assert.deepEqual(lease(run).submissions.outputs, { plan: "a", notes: "n" });
  assert.deepEqual(lease(run).usage, usage);
  const shipRun = commit(run, { by: "owner", op: "force", to: "ship" }).run;
  const long = "x".repeat(TEXT_EVIDENCE_CHARS + 100);
  const withNote = commit(shipRun, { by: "agent", op: "submit", ticket: ticket(shipRun), evidence: { note: long } }).run;
  const ev = lease(withNote).submissions.evidence;
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.kind === "text" && ev[0]!.text.length <= TEXT_EVIDENCE_CHARS);
});

test("advance: local rules refuse synchronously; a passing gate moves outputs and mints the next driver's lease", () => {
  let run = agentRun();
  const refused = step(run, { by: "agent", op: "advance", ticket: ticket(run) }, T0, idsFrom());
  assert.equal(refused.reply.kind, "refused");
  assert.equal(refused.run, run);
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "the plan" } }).run;
  const out = commit(run, { by: "agent", op: "advance", ticket: ticket(run) }, T0 + 5);
  assert.equal(out.reply.kind, "entered");
  const next = lease(out.run);
  assert.equal(next.stage, "build");
  assert.equal(next.cause, "advance");
  assert.match(next.causeText, /design/);
  assert.deepEqual(next.driver, { kind: "autopilot", name: "builder", args: "go fast" });
  assert.deepEqual(next.submissions, { outputs: {}, evidence: [] });
  assert.deepEqual(out.run.outputs.design, { plan: "the plan" });
  assert.deepEqual(stationOf(out.run)!.inputs, { "design.plan": "the plan" });
  assert.deepEqual(out.run.log.at(-1)?.end, { kind: "advanced", to: "build" });
  assert.equal(next.seq > out.run.log.at(-1)!.seq, true);
});

test("gate with checks: workStarted claims the job for one boot, checked settles it; submit is busy meanwhile", () => {
  let { run, grant } = claimedBuild();
  run = commit(run, { by: "driver", op: "submit", grant, outputs: { result: "built" } }).run;
  // ran:true evidence is not satisfied by typed text
  const typed = step(run, { by: "driver", op: "submit", grant, evidence: { tests: "I ran them" } }, T0, idsFrom());
  run = commit(run, { by: "driver", op: "submit", grant, evidence: { tests: "I ran them" } }).run;
  void typed;
  const noRan = step(run, { by: "driver", op: "advance", grant }, T0, idsFrom());
  assert.equal(noRan.reply.kind, "refused");
  assert.match((noRan.reply as { reasons: string[] }).reasons.join("\n"), /tests/);

  // a plugin-run command leaves ran evidence
  const started = commit(run, { by: "driver", op: "run", grant, label: "tests", command: "npm test" });
  assert.equal(started.reply.kind, "pending");
  run = started.run;
  const workId = (started.reply as { workId: number }).workId;
  assert.equal(step(run, { by: "driver", op: "advance", grant }, T0, idsFrom()).reply.kind, "busy", "single-flight");
  const runEffect = desired(run).find((e) => e.kind === "run");
  assert.ok(runEffect && runEffect.kind === "run" && runEffect.workId === workId);
  const t = ticket(run) as never;
  run = commit(run, { by: "system", op: "ran", ticket: t, workId, exitCode: 0, durationMs: 42, tail: "y".repeat(TAIL_CHARS + 500) + "END" }).run;
  const ran = lease(run).submissions.evidence.find((e) => e.kind === "ran");
  assert.ok(ran && ran.kind === "ran" && ran.exitCode === 0 && ran.command === "npm test" && ran.name === "tests");
  assert.ok(ran.tail.length <= TAIL_CHARS && ran.tail.endsWith("END"), "the tail keeps the end of the output");
  assert.deepEqual(lease(run).outcome, { kind: "ran", workId, label: "tests", exitCode: 0, delivered: false });

  const advanced = commit(run, { by: "driver", op: "advance", grant, note: "done" });
  assert.equal(advanced.reply.kind, "pending");
  run = advanced.run;
  const gateId = (advanced.reply as { workId: number }).workId;
  assert.equal(step(run, { by: "driver", op: "submit", grant, outputs: { result: "changed" } }, T0, idsFrom()).reply.kind, "busy", "S4");
  const check = desired(run).find((e) => e.kind === "check");
  assert.ok(check && check.kind === "check" && check.checks.length === 1 && check.checks[0]!.command === "npm test");
  const claimedBoot = commit(run, { by: "system", op: "workStarted", ticket: t, workId: gateId, boot: "boot-a" });
  assert.equal(claimedBoot.reply.kind, "ok");
  run = claimedBoot.run;
  const otherBoot = step(run, { by: "system", op: "workStarted", ticket: t, workId: gateId, boot: "boot-b" }, T0, idsFrom());
  assert.equal(otherBoot.reply.kind, "stale");
  assert.equal(otherBoot.run, run);
  const failed = commit(run, { by: "system", op: "checked", ticket: t, workId: gateId, results: { [check.checks[0]!.ruleKey]: { ok: false, detail: "exit 1", at: T0 } } }).run;
  assert.equal(lease(failed).work, null);
  assert.equal(lease(failed).outcome?.kind, "refused");
  const passed = commit(run, { by: "system", op: "checked", ticket: t, workId: gateId, results: { [check.checks[0]!.ruleKey]: { ok: true, detail: "exit 0", at: T0 } } }).run;
  assert.equal(lease(passed).stage, "review");
  assert.equal(passed.evidence.build?.some((e) => e.kind === "ran" && e.name === "tests"), true, "accepted evidence moves with the outputs");
});

test("user rule asks the owner; reject is an outcome, a late answer is inert", () => {
  let run = agentRun();
  run = commit(run, { by: "owner", op: "force", to: "review" }).run;
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { verdict: "ok" } }).run;
  const out = commit(run, { by: "agent", op: "advance", ticket: ticket(run), to: "ship" });
  assert.equal(out.reply.kind, "pending");
  run = out.run;
  const work = lease(run).work!;
  assert.ok(work.kind === "gate" && work.phase === "asking");
  const ask = desired(run).find((e) => e.kind === "ask");
  assert.ok(ask && ask.kind === "ask" && ask.form.rendererId === "gate-approval" && ask.formId === work.id);
  const t = ticket(run) as never;
  const rejected = commit(run, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: false, note: "no" }).run;
  assert.equal(lease(rejected).work, null);
  assert.equal(lease(rejected).outcome?.kind, "refused");
  const tellOutcome = desired(rejected).find((e) => e.kind === "tellOutcome");
  assert.ok(tellOutcome, "the agent is told the outcome by message");
  const told = commit(rejected, { by: "system", op: "outcomeTold", ticket: t, workId: work.id }).run;
  assert.equal(lease(told).outcome?.delivered, true);
  assert.equal(desired(told).some((e) => e.kind === "tellOutcome"), false);
  const late = step(told, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: true }, T0, idsFrom());
  assert.equal(late.run, told);
  const approved = commit(run, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: true }).run;
  assert.equal(lease(approved).stage, "ship");
});

test("claim: one invocation holds the lease; heartbeat expiry hands the same visit to the agent", () => {
  const { run, grant } = claimedBuild();
  const renew = commit(run, { by: "driver", op: "claim", ticket: ticket(run), invocation: "inv1" }, T0 + 1000);
  assert.equal(renew.reply.kind, "claimed");
  assert.equal(lease(renew.run).claim!.expiresAt, T0 + 1000 + HEARTBEAT_SEC * 1000);
  let r = commit(run, { by: "driver", op: "submit", grant, outputs: { result: "half" } }).run;
  assert.equal(step(r, { by: "system", op: "tick" }, T0 + HEARTBEAT_SEC * 1000 - 1, idsFrom()).run, r, "no deadline passed");
  r = commit(r, { by: "system", op: "tick" }, T0 + HEARTBEAT_SEC * 1000 + 1).run;
  assert.deepEqual(lease(r).driver, { kind: "agent" });
  assert.equal(lease(r).cause, "expired");
  assert.deepEqual(lease(r).submissions.outputs, { result: "half" }, "same visit: submissions carried");
  assert.deepEqual(r.log.at(-1)?.end, { kind: "expired", what: "heartbeat" });
  assert.equal(desired(r).some((e) => e.kind === "tell"), true);
});

test("launch grace: one relaunch with a fresh ticket, then the agent; the old ticket's late claim is stale", () => {
  let run = commit(null, { by: "driver", op: "start", source: skill, autopilot: { name: "all" } }).run;
  const first = ticket(run);
  run = commit(run, { by: "system", op: "woke", runId: "run1", ticket: first as never, kind: "launched", attempt: 1 }, T0).run;
  assert.equal(desired(run).some((e) => e.kind === "launch"), false, "launched once");
  run = commit(run, { by: "system", op: "tick" }, T0 + LAUNCH_GRACE_SEC * 1000 + 1).run;
  assert.equal(lease(run).cause, "relaunch");
  assert.notEqual(ticket(run), first);
  const relaunch = desired(run).find((e) => e.kind === "launch");
  assert.ok(relaunch && relaunch.kind === "launch" && relaunch.attempt === 2);
  const lateClaim = step(run, { by: "driver", op: "claim", ticket: first, invocation: "slow" }, T0, idsFrom());
  assert.equal(lateClaim.run, run);
  assert.equal(lateClaim.reply.kind, "closed");
  run = commit(run, { by: "system", op: "woke", runId: "run1", ticket: ticket(run) as never, kind: "launched", attempt: 2 }, T0 + LAUNCH_GRACE_SEC * 1000 + 2).run;
  run = commit(run, { by: "system", op: "tick" }, T0 + 2 * LAUNCH_GRACE_SEC * 1000 + 3).run;
  assert.deepEqual(lease(run).driver, { kind: "agent" });
  assert.equal(lease(run).cause, "expired");
});

test("owner force to the same stage is a new visit: empty submissions, previous visit with its end and the new cause", () => {
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "old plan" } }).run;
  const before = lease(run).seq;
  run = commit(run, { by: "owner", op: "force", to: "design", note: "rethink" }, T0 + 10).run;
  const l = lease(run);
  assert.notEqual(l.seq, before);
  assert.equal(l.cause, "force");
  assert.deepEqual(l.submissions, { outputs: {}, evidence: [] });
  assert.ok(l.previous);
  assert.equal(l.previous.seq, before);
  assert.deepEqual(l.previous.submissions.outputs, { plan: "old plan" });
  assert.deepEqual(l.previous.end, { kind: "forced", to: "design", by: "owner", note: "rethink" });
  assert.equal(endText(l.previous.end), "forced by the owner: rethink");
  assert.match(l.causeText, /the owner forced this stage/);
  assert.deepEqual(stationOf(run)!.previous, l.previous);
  const tell = desired(run).find((e) => e.kind === "tell");
  assert.ok(tell && tell.kind === "tell");
  assert.match(tell.text, /the owner forced this stage/);
  assert.match(tell.text, /Last visit \(ended: forced by the owner: rethink\) submitted:/);
  assert.match(tell.text, /plan: old plan/);
  assert.match(tell.text, new RegExp(`ticket ${ticket(run).replace(".", "\\.")}`));
  // old work never satisfies the new gate
  assert.equal(step(run, { by: "agent", op: "advance", ticket: ticket(run) }, T0, idsFrom()).reply.kind, "refused");
});

test("an agent lease's tell carries the stage brief (outputs, gate, next), so the agent starts without a stage_status call", () => {
  const run = commit(agentRun(), { by: "owner", op: "force", to: "design", note: "again" }, T0 + 10).run;
  const tell = desired(run).find((e) => e.kind === "tell");
  assert.ok(tell && tell.kind === "tell");
  assert.match(tell.text, /you drive stage .* now, ticket /);
  assert.match(tell.text, /Outputs \(submit with stage_submit\):/);
  assert.match(tell.text, /Gate:/);
  assert.equal(tell.text.match(/Why: /g)?.length, 1, "the cause is said once");
  assert.doesNotMatch(tell.text, /Call stage_status/);
});

test("force proposal: the owner approves (force with the reason as cause) or rejects (the lease stays)", () => {
  let run = agentRun();
  const out = commit(run, { by: "agent", op: "proposeForce", ticket: ticket(run), to: "review", reason: "the design is given" });
  assert.equal(out.reply.kind, "pending");
  run = out.run;
  const work = lease(run).work!;
  assert.equal(work.kind, "force-proposal");
  const ask = desired(run).find((e) => e.kind === "ask");
  assert.ok(ask && ask.kind === "ask" && ask.form.rendererId === "force-proposal");
  const t = ticket(run) as never;
  const approved = commit(run, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: true }).run;
  assert.equal(lease(approved).stage, "review");
  assert.equal(lease(approved).cause, "force");
  assert.equal(lease(approved).causeText, "approved force proposal: the design is given");
  assert.deepEqual(approved.log.at(-1)?.end, { kind: "forced", to: "review", by: "proposal", note: "the design is given" });
  const rejected = commit(run, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: false }).run;
  assert.equal(lease(rejected).seq, lease(run).seq);
  assert.deepEqual(lease(rejected).outcome, { kind: "force-rejected", workId: work.id, to: "review", delivered: false });
  assert.equal(step(rejected, { by: "system", op: "answered", runId: "run1", ticket: t, formId: work.id, approved: true }, T0, idsFrom()).run, rejected, "late answer");
  assert.equal(step(run, { by: "agent", op: "proposeForce", ticket: ticket(run), to: "nowhere", reason: "r" }, T0, idsFrom()).reply.kind, "busy");
});

test("setDriver (graft 4): drives all replaces stage rows; defaults delete; a changed current driver switches the lease, keeping submissions", () => {
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "keep me" } }).run;
  const ap = (name: string) => ({ kind: "autopilot" as const, name });
  run = commit(run, { by: "owner", op: "setDriver", scope: "stage", stage: "review", choice: ap("rev") }).run;
  assert.deepEqual(run.plan, { stages: { review: ap("rev") } });
  run = commit(run, { by: "owner", op: "setDriver", scope: "track", choice: ap("all") }).run;
  assert.deepEqual(run.plan, { track: ap("all"), stages: {} }, "drives all replaces every stage override");
  const switched = lease(run);
  assert.equal(switched.cause, "switch");
  assert.deepEqual(switched.driver, ap("all"));
  assert.deepEqual(switched.submissions.outputs, { plan: "keep me" }, "driver change within a visit keeps submissions");
  assert.deepEqual(run.log.at(-1)?.end, { kind: "switched", to: ap("all") });
  run = commit(run, { by: "owner", op: "setDriver", scope: "stage", stage: "design", choice: { kind: "agent" } }).run;
  assert.deepEqual(lease(run).driver, { kind: "agent" });
  assert.deepEqual(run.plan, { track: ap("all"), stages: { design: { kind: "agent" } } });
  const same = step(run, { by: "owner", op: "setDriver", scope: "stage", stage: "design", choice: { kind: "agent" } }, T0, idsFrom());
  assert.equal(same.run, run, "no change, no new lease");
  run = commit(run, { by: "owner", op: "setDriver", scope: "stage", stage: "design", choice: "default" }).run;
  assert.deepEqual(run.plan, { track: ap("all"), stages: {} });
  run = commit(run, { by: "owner", op: "setDriver", scope: "track", choice: "default" }).run;
  assert.deepEqual(run.plan, { stages: {} });
  assert.deepEqual(lease(run).driver, { kind: "agent" });
  const bad = step(run, { by: "owner", op: "setDriver", scope: "stage", stage: "nope", choice: { kind: "agent" } }, T0, idsFrom());
  assert.equal(bad.reply.kind, "refused");
});

test("release hands the same visit to the agent", () => {
  const { run, grant } = claimedBuild();
  let r = commit(run, { by: "driver", op: "submit", grant, outputs: { result: "half" } }).run;
  const out = commit(r, { by: "driver", op: "release", grant, reason: "stuck on X" });
  assert.equal(out.reply.kind, "released");
  r = out.run;
  assert.deepEqual(lease(r).driver, { kind: "agent" });
  assert.equal(lease(r).cause, "release");
  assert.deepEqual(lease(r).submissions.outputs, { result: "half" });
  assert.match(lease(r).causeText, /stuck on X/);
  assert.deepEqual(r.log.at(-1)?.end, { kind: "released", reason: "stuck on X" });
});

test("recover: work started by another boot becomes interrupted; reconcile and an idle tick change nothing (S3)", () => {
  let { run, grant } = claimedBuild();
  run = commit(run, { by: "driver", op: "run", grant, label: "tests", command: "npm test" }).run;
  const workId = lease(run).work!.id;
  assert.equal(step(run, { by: "system", op: "recover", boot: "boot-b" }, T0, idsFrom()).run, run, "not started yet: nothing to interrupt");
  run = commit(run, { by: "system", op: "workStarted", ticket: ticket(run) as never, workId, boot: "boot-a" }).run;
  assert.equal(step(run, { by: "system", op: "recover", boot: "boot-a" }, T0, idsFrom()).run, run);
  const recovered = commit(run, { by: "system", op: "recover", boot: "boot-b" }).run;
  assert.equal(lease(recovered).work, null);
  assert.deepEqual(lease(recovered).outcome, { kind: "interrupted", workId, what: "run", delivered: false });
  assert.equal(desired(recovered).some((e) => e.kind === "run"), false, "never re-run");
  assert.equal(step(run, { by: "system", op: "reconcile" }, T0, idsFrom()).run, run);
  assert.equal(step(run, { by: "system", op: "tick" }, T0 + 1, idsFrom()).run, run);
});

test("a started job whose command could not run is interrupted with its reason, never re-run; a stale report is ignored", () => {
  let { run, grant } = claimedBuild();
  run = commit(run, { by: "driver", op: "run", grant, label: "tests", command: "npm test" }).run;
  const workId = lease(run).work!.id;
  run = commit(run, { by: "system", op: "workStarted", ticket: ticket(run) as never, workId, boot: "boot-a" }).run;
  assert.equal(step(run, { by: "system", op: "interrupted", ticket: ticket(run) as never, workId: workId + 99, reason: "x" }, T0, idsFrom()).reply.kind, "stale");
  const after = commit(run, { by: "system", op: "interrupted", ticket: ticket(run) as never, workId, reason: "the command could not run: host plugin worker exited (0)" }).run;
  assert.equal(lease(after).work, null);
  assert.deepEqual(lease(after).outcome, { kind: "interrupted", workId, what: "run", reason: "the command could not run: host plugin worker exited (0)", delivered: false });
  assert.deepEqual(lease(after).submissions.evidence, [], "no ran evidence without an exit code");
  assert.equal(desired(after).some((e) => e.kind === "run"), false, "never re-run");
});

test("autopilot status with its grant renews the claim and delivers the outcome", () => {
  let { run, grant } = claimedBuild();
  run = commit(run, { by: "driver", op: "run", grant, label: "tests", command: "false" }).run;
  const workId = lease(run).work!.id;
  run = commit(run, { by: "system", op: "ran", ticket: ticket(run) as never, workId, exitCode: 1, durationMs: 1, tail: "boom" }).run;
  const out = commit(run, { by: "driver", op: "status", lease: grant }, T0 + 5000);
  assert.equal(out.reply.kind, "current");
  assert.equal(lease(out.run).outcome?.delivered, true);
  assert.equal(lease(out.run).claim!.expiresAt, T0 + 5000 + HEARTBEAT_SEC * 1000);
  assert.equal(desired(out.run).some((e) => e.kind === "tellOutcome"), false, "autopilot outcomes are read, not told");
});

test("finishing: an autopilot finishing the track tells the agent once; the agent finishing is told by the reply", () => {
  let run = commit(null, { by: "driver", op: "start", source: skill, autopilot: { name: "all" } }).run;
  run = commit(run, { by: "owner", op: "force", to: "ship" }).run;
  const c = commit(run, { by: "driver", op: "claim", ticket: ticket(run), invocation: "i" });
  run = c.run;
  const grant = (c.reply as { grant: string }).grant;
  run = commit(run, { by: "driver", op: "submit", grant, evidence: { note: "shipped" } }).run;
  const out = commit(run, { by: "driver", op: "advance", grant });
  assert.equal(out.reply.kind, "finished");
  assert.deepEqual(out.run.state, { kind: "done", at: T0, told: false });
  const tell = desired(out.run).find((e) => e.kind === "tell");
  assert.ok(tell && tell.kind === "tell" && tell.ticket === null);
  const told = commit(out.run, { by: "system", op: "woke", runId: "run1", ticket: null, kind: "told", attempt: 1 }).run;
  assert.deepEqual(desired(told), []);

  let agent = agentRun();
  agent = commit(agent, { by: "owner", op: "force", to: "ship" }).run;
  agent = commit(agent, { by: "agent", op: "submit", ticket: ticket(agent), evidence: { note: "n" } }).run;
  const fin = commit(agent, { by: "agent", op: "advance", ticket: ticket(agent) });
  assert.equal(fin.reply.kind, "finished");
  assert.deepEqual(fin.run.state, { kind: "done", at: T0, told: true });
});

test("rev never resets: abort then a new start continues the count; nextSeq stays above every id", () => {
  let run = agentRun();
  run = commit(run, { by: "owner", op: "force", to: "review" }).run;
  run = commit(run, { by: "owner", op: "abort", reason: "enough" }).run;
  assert.equal(run.state.kind, "aborted");
  const revBefore = run.rev;
  const ids = idsFrom("next");
  const fresh = commit(run, { by: "agent", op: "start", source: skill }, T0, ids).run;
  assert.equal(fresh.rev, revBefore + 1);
  assert.equal(fresh.runId, "next1");
  assert.equal(fresh.log.length, 0);
  assert.equal(fresh.publishedRev, fresh.rev);
});

test("the log keeps the last LOG_LIMIT closed leases and counts the dropped ones", () => {
  let run = agentRun();
  for (let i = 0; i < LOG_LIMIT + 7; i++) run = commit(run, { by: "owner", op: "force", to: i % 2 ? "design" : "review" }).run;
  assert.equal(run.log.length, LOG_LIMIT);
  assert.equal(run.logDropped, 7);
  assert.ok(run.nextSeq > lease(run).seq);
});

test("policyFor: the guard's file carries rev, ticket and the stage's allow list", () => {
  assert.deepEqual(policyFor("t1", null), {
    version: 1, threadId: "t1", active: false, running: false, runId: "", rev: 0, ticket: "", machine: "", stage: "", stageTitle: "", next: [], allow: {}, driver: { kind: "agent" }, goalId: null, waiting: null,
  });
  let run = agentRun();
  const p = policyFor("t1", run);
  assert.equal(p.active, true);
  assert.equal(p.running, true);
  assert.equal(p.rev, run.rev);
  assert.equal(p.ticket, ticket(run));
  assert.equal(p.stage, "design");
  assert.deepEqual(p.next, ["build"]);
  run = commit(run, { by: "owner", op: "setPaused", paused: true }).run;
  assert.equal(policyFor("t1", run).active, false, "paused: guard off");
  assert.equal(policyFor("t1", run).running, true);
});

// Every command kind against every run state: no throw, the run invariants hold, unchanged runs are the same object.
test("every command x run state keeps the invariants", () => {
  const states: [string, () => Run | null][] = [
    ["none", () => null],
    ["proposed", () => commit(null, { by: "agent", op: "start", source: { kind: "adhoc", machine } }).run],
    ["agent lease", agentRun],
    ["agent lease, gate asking", () => {
      let r = commit(agentRun(), { by: "owner", op: "force", to: "review" }).run;
      r = commit(r, { by: "agent", op: "submit", ticket: ticket(r), outputs: { verdict: "v" } }).run;
      return commit(r, { by: "agent", op: "advance", ticket: ticket(r), to: "ship" }).run;
    }],
    ["autopilot lease, unclaimed", () => commit(null, { by: "driver", op: "start", source: skill, autopilot: { name: "a" } }).run],
    ["autopilot lease, claimed", () => claimedBuild().run],
    ["autopilot lease, unpublished", () => step(claimedBuild().run, { by: "owner", op: "setPaused", paused: true }, T0, idsFrom()).run],
    ["done", () => {
      let r = commit(agentRun(), { by: "owner", op: "force", to: "ship" }).run;
      r = commit(r, { by: "agent", op: "submit", ticket: ticket(r), evidence: { note: "n" } }).run;
      return commit(r, { by: "agent", op: "advance", ticket: ticket(r) }).run;
    }],
    ["aborted", () => commit(agentRun(), { by: "owner", op: "abort" }).run],
  ];
  const commandsFor = (run: Run | null): Command[] => {
    const t = run && run.state.kind === "active" ? ticket(run) : "run1.1";
    const g = run && run.state.kind === "active" ? (grantOf(run, lease(run)) ?? `${t}.inv1`) : "run1.1.inv1";
    const workId = run && run.state.kind === "active" ? (lease(run).work?.id ?? 1) : run?.state.kind === "proposed" ? run.state.formId : 1;
    return [
      { by: "agent", op: "start", source: skill },
      { by: "agent", op: "status" },
      { by: "agent", op: "submit", ticket: t, outputs: { plan: "p" } },
      { by: "agent", op: "advance", ticket: t },
      { by: "agent", op: "proposeForce", ticket: t, to: "ship", reason: "r" },
      { by: "driver", op: "start", source: skill, autopilot: { name: "a" } },
      { by: "driver", op: "status", lease: g },
      { by: "driver", op: "claim", ticket: t, invocation: "inv1" },
      { by: "driver", op: "submit", grant: g, outputs: { result: "r" } },
      { by: "driver", op: "run", grant: g, label: "tests", command: "true" },
      { by: "driver", op: "advance", grant: g },
      { by: "driver", op: "proposeForce", grant: g, to: "design", reason: "r" },
      { by: "driver", op: "release", grant: g, reason: "r" },
      { by: "owner", op: "force", to: "review" },
      { by: "owner", op: "setDriver", scope: "track", choice: { kind: "autopilot", name: "z" } },
      { by: "owner", op: "setPaused", paused: true },
      { by: "owner", op: "abort" },
      { by: "system", op: "reconcile" },
      { by: "system", op: "recover", boot: "b2" },
      { by: "system", op: "tick" },
      { by: "system", op: "published", rev: run?.rev ?? 0 },
      { by: "system", op: "workStarted", ticket: t as never, workId, boot: "b1" },
      { by: "system", op: "checked", ticket: t as never, workId, results: {} },
      { by: "system", op: "ran", ticket: t as never, workId, exitCode: 0, durationMs: 1, tail: "" },
      { by: "system", op: "answered", runId: run?.runId ?? "run1", ticket: run?.state.kind === "proposed" ? null : (t as never), formId: workId, approved: true },
      { by: "system", op: "woke", runId: run?.runId ?? "run1", ticket: t as never, kind: "told", attempt: 1 },
      { by: "system", op: "outcomeTold", ticket: t as never, workId },
    ];
  };
  for (const [name, make] of states) {
    for (const command of commandsFor(make())) {
      const before = make();
      const label = `${name} x ${command.by} ${command.op}`;
      const { run, reply } = step(before, command, T0 + 1, idsFrom("n"));
      assert.ok(reply && typeof reply.kind === "string", label);
      if (run === null) { assert.equal(before, null, label); continue; }
      if (run !== before) assert.equal(run.rev, (before?.rev ?? 0) + (command.op === "published" ? 0 : 1), `${label}: rev`);
      assert.ok(run.publishedRev <= run.rev, `${label}: publishedRev`);
      if (run.state.kind === "active") {
        const l = run.state.lease;
        assert.ok(run.nextSeq > l.seq, `${label}: R2`);
        if (l.work) assert.ok(run.nextSeq > l.work.id, `${label}: R2 work`);
        if (l.claim) assert.equal(l.driver.kind, "autopilot", `${label}: L2`);
      }
      assert.ok(run.log.length <= LOG_LIMIT, label);
      if (before && before.runId === run.runId) assert.ok(run.log.length >= Math.min(before.log.length, LOG_LIMIT), `${label}: log only grows`);
      void desired(run);
      void policyFor("t", run);
    }
  }
});

test("statusText (stage_status): driver, ticket, why, inputs, submissions, gate, previous visit and pending work", () => {
  let run = agentRun();
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "old plan" } }).run;
  run = commit(run, { by: "owner", op: "force", to: "design", note: "rethink" }, T0 + 10).run;
  const text = statusText(run);
  assert.match(text, /Track "Demo" \(demo\), active/);
  assert.match(text, /Stage design — Design, driven by you \(the agent\), ticket run1\.\d+/);
  assert.match(text, /Why: the owner forced this stage: rethink/);
  assert.match(text, /\[ \] plan/);
  assert.match(text, /Last visit \(ended: forced by the owner: rethink\) submitted: plan: old plan/);
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { plan: "new" } }).run;
  run = commit(run, { by: "agent", op: "advance", ticket: ticket(run) }).run;
  const build = statusText(run);
  assert.match(build, /driven by autopilot builder/);
  assert.match(build, /design\.plan: new/);
  assert.match(build, /check: `npm test` exits 0/);
  assert.equal(statusText(null), "No track in this thread. Start one with stage_start.");
  const aborted = commit(run, { by: "owner", op: "abort" }).run;
  assert.match(statusText(aborted), /aborted: aborted by the owner/);
});

test("after a release the owner gives the stage back to its template autopilot with setDriver default, though the plan is unchanged", () => {
  const { run, grant } = claimedBuild();
  const released = commit(run, { by: "driver", op: "release", grant, reason: "failed" }).run;
  assert.deepEqual(lease(released).driver, { kind: "agent" });
  const back = commit(released, { by: "owner", op: "setDriver", scope: "stage", stage: lease(released).stage, choice: "default" }).run;
  assert.equal(lease(back).driver.kind, "autopilot", "the current visit switches to the template autopilot");
  assert.equal(lease(back).cause, "switch");
  assert.ok(desired(back).some((e) => e.kind === "launch"), "the plugin launches it");
  const again = step(back, { by: "owner", op: "setDriver", scope: "stage", stage: lease(back).stage, choice: "default" }, T0, idsFrom());
  assert.equal(again.run, back, "already driven as planned: no new lease");
});

// Goal link: a goal rule passes only on an approved auditor verdict for the goal focused at start.
const goalTrack = (() => {
  const p = parseMachine({ id: "g", title: "G", stages: [{ id: "build", title: "Build", gate: [{ type: "goal" }], next: [{ to: "ship" }] }, { id: "ship", title: "Ship" }] });
  if (!p.ok) throw new Error(p.error);
  return { kind: "skill", skill: "g", machine: p.machine } as StartSource;
})();

test("a goal rule passes only when the auditor approved the goal the run serves", () => {
  const run = commit(null, { by: "agent", op: "start", source: goalTrack, goalId: "goal-1" }).run;
  assert.equal(run.goalId, "goal-1");
  const advance = (goal?: { goalId: string; verdict: string; at: string | null }) =>
    step(run, { by: "agent", op: "advance", ticket: ticket(run), ...(goal ? { goal } : {}) }, T0, idsFrom());
  const missing = advance();
  assert.equal(missing.reply.kind, "refused");
  assert.match(JSON.stringify(missing.reply), /could not be read/);
  const other = advance({ goalId: "goal-2", verdict: "approved", at: null });
  assert.equal(other.reply.kind, "refused", "another goal's verdict does not count");
  const disapproved = advance({ goalId: "goal-1", verdict: "disapproved", at: "t" });
  assert.equal(disapproved.reply.kind, "refused");
  assert.match(JSON.stringify(disapproved.reply), /disapproved/);
  const approved = advance({ goalId: "goal-1", verdict: "approved", at: "t" });
  assert.notEqual(approved.reply.kind, "refused");
  assert.equal(lease(approved.run!).stage, "ship");
});

test("a goal rule refuses a run that started without a focused goal", () => {
  const run = commit(null, { by: "agent", op: "start", source: goalTrack }).run;
  assert.equal(run.goalId, null);
  const out = step(run, { by: "agent", op: "advance", ticket: ticket(run), goal: { goalId: "goal-1", verdict: "approved", at: null } }, T0, idsFrom());
  assert.equal(out.reply.kind, "refused");
  assert.match(JSON.stringify(out.reply), /serves no goal/);
  const p = parseMachine({ id: "o", title: "O", stages: [{ id: "a", title: "A", gate: [{ type: "goal", optional: true }] }] });
  if (!p.ok) throw new Error(p.error);
  const loose = commit(null, { by: "agent", op: "start", source: { kind: "skill", skill: "o", machine: p.machine } }).run;
  assert.equal(step(loose, { by: "agent", op: "advance", ticket: ticket(loose) }, T0, idsFrom()).reply.kind, "finished", "optional: no goal, no block");
});

test("policyFor: waiting says who the lease waits for, goalId the goal the run serves", () => {
  let run = agentRun();
  assert.equal(policyFor("t1", run).waiting, null, "the driver works");
  assert.equal(policyFor("t1", run).goalId, null);
  run = commit(run, { by: "owner", op: "force", to: "review" }).run;
  run = commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs: { verdict: "ok" } }).run;
  run = commit(run, { by: "agent", op: "advance", ticket: ticket(run), to: "ship" }).run;
  assert.equal(policyFor("t1", run).waiting, "owner", "the user rule asks the owner");
  const gate = { kind: "gate", id: 1, to: null, results: {}, startedIn: null } as const;
  assert.equal(waitingOf({ ...gate, phase: "checking" }), "track", "checks run; the plugin tells the result");
  assert.equal(waitingOf({ kind: "run", id: 2, label: "l", command: "c", timeoutSec: 1, startedIn: null }), "track");
  assert.equal(waitingOf({ kind: "force-proposal", id: 3, to: "ship", reason: "r" }), "owner");
  const served = commit(null, { by: "agent", op: "start", source: goalTrack, goalId: "goal-1" }).run;
  assert.equal(policyFor("t1", served).goalId, "goal-1");
});
