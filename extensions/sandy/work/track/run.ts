// Track drivers v2: the run state machine (design: docs/design-v2.md). Pure: no sandy API, no I/O, no clock reads.
// machine.ts keeps the stages.json schemas and rule helpers; this module owns the Run, its leases, every transition
// (step), and what should be happening for a run (desired).
import { clip, describeRule, effectiveAllow, parseMachine, pickEdge, rulesFor, stageOf, type Allow, type Machine, type Rule, type RuleResult, type Stage } from "./machine.ts";

export type AutopilotRef = { name: string; args?: string };
export type Driver = { kind: "agent" } | ({ kind: "autopilot" } & AutopilotRef);
/** An owner override. "Template default" is not stored: deleting the key returns to the template. */
export type DriverChoice = Driver;
/**
 * The owner's driver overrides; the template's stage.autopilot is only the last fallback.
 * Writers: the owner (setDriver) and a driver start with autopilot (sets track). Nobody else.
 * "Drives all" (setDriver scope track, a choice) replaces track and clears every stage override.
 */
export type DriverPlan = { track?: DriverChoice; stages: Record<string, DriverChoice> };

export type RunId = string;
/** "<runId>.<seq>": names a lease. Derived from (run.runId, lease.seq); never stored separately. */
export type Ticket = string & { readonly __ticket: unique symbol };
/** "<runId>.<seq>.<invocation>": names a claimed autopilot lease. Derived from (ticket, lease.claim.invocation). */
export type Grant = string & { readonly __grant: unique symbol };

export type LeaseCause =
  | "start" // first lease of a run
  | "advance" // gate passed
  | "force" // owner force, or an approved force proposal
  | "switch" // owner changed the driver of the current stage (directly or through the track choice)
  | "release" // the autopilot handed the stage back
  | "expired" // launch grace or heartbeat passed
  | "relaunch"; // the launch was not claimed in time; one more try with a fresh ticket

/** Causes that start a new visit of the stage: empty submissions, the previous visit given as read-only context. */
export const VISIT_CAUSES: readonly LeaseCause[] = ["start", "advance", "force"];

/** Whether the driver has been woken for this lease. Written after the executor sent the message (at-least-once). */
export type Wake = { kind: "none" } | { kind: "told"; at: number } | { kind: "launched"; at: number; attempt: number };

/** Autopilot only. invocation is random per /autopilot --lease run, so two launches never share a claim. */
export type Claim = { invocation: string; claimedAt: number; expiresAt: number };

/**
 * At most one deferred job per lease. id comes from run.nextSeq. startedIn is the executor boot that started the
 * check or command; a job started by another boot is interrupted at recovery, never run again.
 */
export type Work =
  | { kind: "gate"; id: number; to: string | null; note?: string; phase: "checking" | "asking"; results: Record<string, RuleResult>; startedIn: string | null }
  | { kind: "run"; id: number; label: string; command: string; timeoutSec: number; startedIn: string | null }
  | { kind: "force-proposal"; id: number; to: string; reason: string };

export type Outcome =
  | { kind: "refused"; workId: number; reasons: string[] }
  | { kind: "ran"; workId: number; label: string; exitCode: number }
  // reason: absent = a plugin restart (recover); else why the command could not run (host worker gone).
  | { kind: "interrupted"; workId: number; what: "gate" | "run"; reason?: string }
  | { kind: "force-rejected"; workId: number; to: string }
  // The work's result would not fit the stored run (MAX_RUN_BYTES); nothing of it was kept, the stage stays the driver's.
  | { kind: "unsaved"; workId: number; what: "gate" | "run" | "force-proposal"; reason: string };

export type RanEvidence = { kind: "ran"; name: string; command: string; exitCode: number; durationMs: number; tail: string; seq: number; at: number };
export type TextEvidence = { kind: "text"; name: string; text: string; seq: number; at: number };
export type Evidence = RanEvidence | TextEvidence;
/** What a driver submitted in this visit. */
export type Submissions = { outputs: Record<string, string>; evidence: Evidence[] };

/** Measured model usage of one lease, from pi's persisted assistant messages (pi/autopilot/usage.ts). */
export type LeaseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; messages: number };

export type LeaseEnd =
  | { kind: "advanced"; to: string | null }
  /** by owner: the owner's force (note: theirs); by proposal: an approved force proposal (note: its reason). */
  | { kind: "forced"; to: string; by: "owner" | "proposal"; note?: string }
  | { kind: "switched"; to: Driver }
  | { kind: "released"; reason: string }
  | { kind: "expired"; what: "launch" | "heartbeat" }
  | { kind: "aborted"; reason: string };

/** The last finished visit of a stage, shown to the next driver of that stage as read-only context. */
export type PreviousVisit = { seq: number; driver: Driver; end: LeaseEnd; endedAt: number; submissions: Submissions };

/**
 * A lease: one driver's hold on one stage visit.
 * INVARIANT L1: seq, stage, driver never change after mint. A different stage or driver is a different lease.
 * INVARIANT L2: claim !== null implies driver.kind === "autopilot".
 * INVARIANT L3: work, claim, wake, outcome are fields of this object, so whatever replaces the lease drops them.
 */
export type Lease = {
  seq: number;
  stage: string;
  driver: Driver;
  cause: LeaseCause;
  /** Why this lease exists, for its driver ("the owner forced this stage: <note>", "approved force proposal: <reason>"). */
  causeText: string;
  mintedAt: number;
  wake: Wake;
  claim: Claim | null;
  work: Work | null;
  /** The last settled job; delivered = the driver has seen it (agent: told; autopilot: read via status). */
  outcome: (Outcome & { delivered: boolean }) | null;
  /** Empty for a new visit (VISIT_CAUSES); carried from the replaced lease on switch, release, expired, relaunch. */
  submissions: Submissions;
  /** Set at mint for a new visit of a stage visited before. */
  previous: PreviousVisit | null;
  /** Last usage report for this lease; null = not measured (unknown, never zero). */
  usage: LeaseUsage | null;
};

/** The audit row of a finished lease. */
export type ClosedLease = { seq: number; stage: string; driver: Driver; cause: LeaseCause; mintedAt: number; endedAt: number; end: LeaseEnd; usage: LeaseUsage | null; usagePartial: boolean; ran: { name: string; exitCode: number }[] };

/**
 * INVARIANT R1: state.kind === "active" iff the run has exactly one lease.
 * INVARIANT R2: nextSeq > every seq, work id and form id used in this run. Only mint() and work starts bump it.
 * INVARIANT R3: rev increases by one per committed change and never resets, also across replacement runs;
 *               publishedRev <= rev is the last rev whose policy file was written.
 */
export type RunState =
  | { kind: "proposed"; formId: number; note?: string }
  | { kind: "active"; lease: Lease }
  | { kind: "done"; at: number; told: boolean }
  | { kind: "aborted"; at: number; reason: string };

export type Run = {
  version: 2;
  runId: RunId;
  machine: Machine;
  source: { kind: "skill"; skill: string } | { kind: "adhoc" };
  /** Accepted outputs per stage: written when a visit advances out of the stage; later stages' inputs read them. */
  outputs: Record<string, Record<string, string>>;
  /** Ran evidence of the visit that advanced out of the stage. */
  evidence: Record<string, Evidence[]>;
  lastVisit: Record<string, PreviousVisit>;
  /**
   * INVARIANT T1: an agent call that changed the run is owed a message until its tool result was a success (the
   * policy of its rev was written in the same commit: published replied) or a wake of the run reached the agent.
   * Set by step for every agent change; desired() emits the tellPending message once published.
   */
  pendingTell: { rev: number } | null;
  plan: DriverPlan;
  /** The goal focused in the thread when the track started (absent in runs stored before goals linked); a goal rule reads its verdict. */
  goalId?: string | null;
  /** Guard enforcement only. Paused never stops driving, launching or telling. */
  paused: boolean;
  rev: number;
  publishedRev: number;
  nextSeq: number;
  state: RunState;
  /** The last LOG_LIMIT closed leases, oldest first; logDropped counts the ones cut off. */
  log: ClosedLease[];
  logDropped: number;
};

// Commands: everything that may change a run. Adapters build them; only step() interprets them.

/** skill: the template the adapter loaded from the skill's stages.json; adhoc: a machine the owner must approve. */
export type StartSource = { kind: "skill"; skill: string; machine: Machine } | { kind: "adhoc"; machine: unknown };

/** The goal's latest auditor verdict, read by the adapter before an advance (goals part: audits()). */
export type GoalVerdict = { goalId: string; verdict: string; at: string | null };

export type AgentCommand =
  | { by: "agent"; op: "start"; source: StartSource; note?: string; goalId?: string }
  | { by: "agent"; op: "status" }
  | { by: "agent"; op: "submit"; ticket: string; outputs?: Record<string, string>; evidence?: Record<string, string>; usage?: LeaseUsage }
  | { by: "agent"; op: "advance"; ticket: string; to?: string; note?: string; usage?: LeaseUsage; goal?: GoalVerdict }
  | { by: "agent"; op: "proposeForce"; ticket: string; to: string; reason: string };

export type DriverCommand =
  | { by: "driver"; op: "start"; source: StartSource; autopilot?: AutopilotRef; note?: string; goalId?: string }
  | { by: "driver"; op: "status"; lease?: string }
  | { by: "driver"; op: "claim"; ticket: string; invocation: string }
  | { by: "driver"; op: "submit"; grant: string; outputs?: Record<string, string>; evidence?: Record<string, string>; usage?: LeaseUsage }
  | { by: "driver"; op: "run"; grant: string; label: string; command: string; timeoutSec?: number }
  | { by: "driver"; op: "advance"; grant: string; to?: string; note?: string; usage?: LeaseUsage; goal?: GoalVerdict }
  | { by: "driver"; op: "proposeForce"; grant: string; to: string; reason: string }
  | { by: "driver"; op: "release"; grant: string; reason: string; usage?: LeaseUsage };

export type OwnerCommand =
  | { by: "owner"; op: "force"; to: string; note?: string }
  | { by: "owner"; op: "setDriver"; scope: "track" | "stage"; stage?: string; choice: DriverChoice | "default" }
  | { by: "owner"; op: "setPaused"; paused: boolean }
  | { by: "owner"; op: "abort"; reason?: string };

/** Results of effects, recovery and the clock. Each names the ticket (or form id) and work id it was started for. */
export type SystemCommand =
  | { by: "system"; op: "reconcile" } // no-op step; re-derives effects and retries an unpublished policy
  | { by: "system"; op: "recover"; boot: string } // plugin start: work started by another boot becomes interrupted
  | { by: "system"; op: "tick" } // deadlines
  // told: the reply of the published command already handed this lease (or the finish) to the agent, so no message.
  // replied: the published command was the agent's and its reply went out as a success (T1).
  | { by: "system"; op: "published"; rev: number; told?: Ticket | "done"; replied?: true }
  | { by: "system"; op: "workStarted"; ticket: Ticket; workId: number; boot: string }
  | { by: "system"; op: "checked"; ticket: Ticket; workId: number; results: Record<string, RuleResult> }
  | { by: "system"; op: "ran"; ticket: Ticket; workId: number; exitCode: number; durationMs: number; tail: string }
  | { by: "system"; op: "interrupted"; ticket: Ticket; workId: number; reason: string } // a started job's command could not run: no exit code, never run again
  // answered and woke name their run: a ticket-less (run-scoped) form or tell of one run never settles a later one.
  | { by: "system"; op: "answered"; runId: RunId; ticket: Ticket | null; formId: number; approved: boolean; note?: string }
  | { by: "system"; op: "woke"; runId: RunId; ticket: Ticket | null; kind: "told" | "launched"; attempt: number }
  | { by: "system"; op: "outcomeTold"; ticket: Ticket; workId: number }
  | { by: "system"; op: "pendingTold"; runId: RunId; rev: number }
  // operations: the settlement of this work would not fit the stored run; the work ends as outcome unsaved.
  | { by: "system"; op: "unsaved"; ticket: Ticket; workId: number; reason: string };

/**
 * The track guard's late, read-only usage report (pi/track-guard): the model work its pi session measured for a lease,
 * also after the lease closed. It never authorizes anything and changes nothing but a usage field.
 */
export type MeterCommand = { by: "meter"; op: "usage"; ticket: string; usage: LeaseUsage };

export type Command = AgentCommand | DriverCommand | OwnerCommand | SystemCommand | MeterCommand;

export type StationView = {
  runId: RunId;
  ticket: Ticket;
  track: string;
  stage: string;
  title: string;
  driver: Driver;
  cause: LeaseCause;
  causeText: string;
  inputs: Record<string, string>;
  submissions: Submissions;
  missingOutputs: string[];
  next: string[];
  work: Work | null;
  outcome: Outcome | null;
  previous: PreviousVisit | null;
};

export type Reply =
  | { kind: "started"; ticket: Ticket; station: StationView }
  | { kind: "proposed" }
  | { kind: "current"; station: StationView }
  | { kind: "claimed"; grant: Grant; station: StationView; heartbeatSec: number }
  | { kind: "accepted"; station: StationView }
  | { kind: "pending"; workId: number }
  | { kind: "entered"; station: StationView }
  | { kind: "finished" }
  | { kind: "refused"; reasons: string[] }
  | { kind: "busy"; work: Work }
  | { kind: "publishing"; rev: number } // the guard policy of this rev is not written yet; retry
  | { kind: "released" }
  | { kind: "closed"; end: LeaseEnd; current: StationView | null }
  | { kind: "stale"; reason: string; current: StationView | null }
  | { kind: "none" }
  | { kind: "ok" };

export const HEARTBEAT_SEC = 90;
export const LAUNCH_GRACE_SEC = 120;
export const MAX_LAUNCH_ATTEMPTS = 2;
export const LOG_LIMIT = 50;
export const TAIL_CHARS = 2000;
export const TEXT_EVIDENCE_CHARS = 4000;
/** Below the sandy.storage.kv value limit (256 KB) with room for JSON overhead. */
export const MAX_RUN_BYTES = 200_000;
/** Default and upper bound of a host-run command (sandy work track drive run) and of a check without timeoutSec. */
export const RUN_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 1800;
const REASON_CHARS = 500;
const SHOWN_VALUE_CHARS = 300;
/**
 * Fixed caps of everything a transition copies into the run from the machine, a driver or the owner (finding: copies
 * must not grow the stored run past MAX_RUN_BYTES). Values longer than a cap are refused at the boundary or clipped.
 */
const CAUSE_CHARS = 500;
const ARGS_CHARS = 500;
const COMMAND_CHARS = 4000;
/** Per output value and evidence text of a previous visit carried into a new lease (tellText shows less). */
export const PREVIOUS_VALUE_CHARS = 2000;
const PREVIOUS_EVIDENCE = 20;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const AUTOPILOT_NAME = /^[a-z][a-z0-9-]{0,47}$/;

type Ids = { newRunId(): RunId };
type Step = { run: Run | null; reply: Reply };
type Active = Run & { state: { kind: "active"; lease: Lease } };

const EMPTY: Submissions = { outputs: {}, evidence: [] };

/**
 * The only transition function. Pure: now and ids are arguments.
 * INVARIANT S1: a command naming a ticket/grant/work id/form id that is not current returns the run unchanged (same
 *               object), with reply stale or closed. Checked before anything else.
 * INVARIANT S2: only mint() changes the lease identity.
 * INVARIANT S3: step(run, reconcile) returns run unchanged.
 * INVARIANT S4: submit while lease.work is a gate job replies busy (submissions are frozen while the gate is judged).
 * INVARIANT S5: while publishedRev < rev, claim, submit, run, advance, proposeForce and release reply publishing.
 * INVARIANT S6: a meter report changes only a usage field: no rev bump (the guard policy does not depend on it, so it
 *               is not published again), no pendingTell. A report that lowers any counter of the stored usage is ignored.
 * Every changed run gets rev + 1 here (R3), except published and meter reports.
 */
export function step(run: Run | null, command: Command, now: number, ids: Ids): Step {
  const out = transition(run, command, now, ids);
  if (out.run === run || out.run === null) return out;
  if (command.by === "meter" || (command.by === "system" && command.op === "published")) return out;
  const rev = (run?.rev ?? 0) + 1;
  return { run: { ...out.run, rev, ...(command.by === "agent" ? { pendingTell: { rev } } : {}) }, reply: out.reply };
}

function transition(run: Run | null, c: Command, now: number, ids: Ids): Step {
  switch (c.by) {
    case "agent":
      return agentStep(run, c, now, ids);
    case "driver":
      return driverStep(run, c, now, ids);
    case "owner":
      return ownerStep(run, c, now);
    case "system":
      return systemStep(run, c, now);
    case "meter":
      return meterStep(run, c);
  }
}

// ---- meter ----------------------------------------------------------------------------------------------------------

/** The current lease's checkpoint, or the closed row of this run that the ticket names; anything else is a stale reply. */
function meterStep(run: Run | null, c: MeterCommand): Step {
  if (run === null) return { run, reply: { kind: "none" } };
  const parsed = parseLeaseRef(c.ticket);
  if (parsed === null || parsed.invocation !== null) return { run, reply: stale(run, `"${clip(c.ticket, 80)}" is not a lease ticket`) };
  if (parsed.runId !== run.runId) return { run, reply: stale(run, "that lease belongs to another run") };
  // Counters only grow, but not together (tool results and standalone entries add tokens, not messages): a report that
  // lowers any one is an older snapshot.
  const older = (stored: LeaseUsage | null) => stored !== null && (Object.keys(stored) as (keyof LeaseUsage)[]).some((counter) => c.usage[counter] < stored[counter]);
  if (isActive(run) && run.state.lease.seq === parsed.seq) {
    const lease = run.state.lease;
    if (older(lease.usage)) return { run, reply: stale(run, "an older report than the stored one") };
    return { run: withLease(run, { ...lease, usage: c.usage }), reply: { kind: "ok" } };
  }
  const index = run.log.findIndex((row) => row.seq === parsed.seq);
  if (index < 0) return { run, reply: stale(run, "no such closed lease in this run") };
  const row = run.log[index]!;
  if (older(row.usage)) return { run, reply: stale(run, "an older report than the stored one") };
  const log = run.log.map((r, i) => (i === index ? { ...r, usage: c.usage, usagePartial: false } : r));
  return { run: { ...run, log }, reply: { kind: "ok" } };
}

// ---- agent and driver ---------------------------------------------------------------------------------------------

function agentStep(run: Run | null, c: AgentCommand, now: number, ids: Ids): Step {
  if (c.op === "start") return startRun(run, c.source, c.note, undefined, now, ids, c.goalId);
  if (c.op === "status") return { run, reply: currentReply(run) };
  const held = holder(run, c.ticket, "agent", "ticket");
  if ("reply" in held) return { run, reply: held.reply };
  const active = held.run;
  if (active.publishedRev < active.rev) return { run, reply: { kind: "publishing", rev: active.rev } };
  switch (c.op) {
    case "submit":
      return submit(active, c, now);
    case "advance":
      return advance(active, c.to, c.note, c.usage, c.goal, now);
    case "proposeForce":
      return proposeForce(active, c.to, c.reason);
  }
}

function driverStep(run: Run | null, c: DriverCommand, now: number, ids: Ids): Step {
  if (c.op === "start") return startRun(run, c.source, c.note, c.autopilot, now, ids, c.goalId);
  if (c.op === "status") {
    if (c.lease === undefined) return { run, reply: currentReply(run) };
    const held = holder(run, c.lease, "driver", "any");
    if ("reply" in held) return { run, reply: held.reply };
    if (!held.granted) return { run, reply: { kind: "current", station: stationOf(held.run)! } };
    // A grant renews the claim and delivers the settled outcome: the autopilot reads it here.
    const lease = held.run.state.lease;
    const outcome = lease.outcome && !lease.outcome.delivered ? { ...lease.outcome, delivered: true } : lease.outcome;
    const next = withLease(held.run, { ...lease, claim: renewed(lease.claim!, now), outcome });
    return { run: next, reply: { kind: "current", station: stationOf(next)! } };
  }
  if (c.op === "claim") {
    const held = holder(run, c.ticket, "driver", "ticket");
    if ("reply" in held) return { run, reply: held.reply };
    const active = held.run;
    if (active.publishedRev < active.rev) return { run, reply: { kind: "publishing", rev: active.rev } };
    if (!NAME.test(c.invocation)) return { run, reply: refusedReply("invocation must be 1-64 characters of A-Z a-z 0-9 _ -") };
    const lease = active.state.lease;
    if (lease.claim !== null && lease.claim.invocation !== c.invocation)
      return { run, reply: stale(active, "another launch of the autopilot holds this lease") };
    const claim = lease.claim ?? { invocation: c.invocation, claimedAt: now, expiresAt: 0 };
    const next = withLease(active, { ...lease, claim: renewed(claim, now) });
    return { run: next, reply: { kind: "claimed", grant: grantOf(next, next.state.lease)!, station: stationOf(next)!, heartbeatSec: HEARTBEAT_SEC } };
  }
  const held = holder(run, c.grant, "driver", "grant");
  if ("reply" in held) return { run, reply: held.reply };
  if (held.run.publishedRev < held.run.rev) return { run, reply: { kind: "publishing", rev: held.run.rev } };
  // Every grant command renews the claim; the renewal is committed only together with a change the command makes.
  const lease = held.run.state.lease;
  const active = withLease(held.run, { ...lease, claim: renewed(lease.claim!, now) });
  const out = grantCommand(active, c, now);
  return out.run === active ? { run, reply: out.reply } : out;
}

function grantCommand(run: Active, c: Exclude<DriverCommand, { op: "start" | "status" | "claim" }>, now: number): Step {
  switch (c.op) {
    case "submit":
      return submit(run, c, now);
    case "run": {
      const lease = run.state.lease;
      if (lease.work !== null) return { run, reply: { kind: "busy", work: lease.work } };
      const label = c.label.trim();
      if (!NAME.test(label)) return { run, reply: refusedReply("label must be 1-64 characters of A-Z a-z 0-9 _ - (it names the ran evidence)") };
      if (!c.command.trim()) return { run, reply: refusedReply("command is empty") };
      if (c.command.length > COMMAND_CHARS) return { run, reply: refusedReply(`command is longer than ${COMMAND_CHARS} characters; put it in a script`) };
      const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(c.timeoutSec ?? RUN_TIMEOUT_SEC)));
      const work: Work = { kind: "run", id: run.nextSeq, label, command: c.command, timeoutSec, startedIn: null };
      return { run: { ...withLease(run, { ...lease, work }), nextSeq: run.nextSeq + 1 }, reply: { kind: "pending", workId: work.id } };
    }
    case "advance":
      return advance(run, c.to, c.note, c.usage, c.goal, now);
    case "proposeForce":
      return proposeForce(run, c.to, c.reason);
    case "release": {
      const lease = run.state.lease;
      const reason = clip(c.reason.trim() || "no reason given", REASON_CHARS);
      const closed = closeLease(run, { kind: "released", reason }, now, c.usage);
      const next = mint(closed, lease.stage, { kind: "agent" }, "release", now, `${driverLabel(lease.driver)} released this stage: ${reason}`);
      return { run: next, reply: { kind: "released" } };
    }
  }
}

function startRun(run: Run | null, source: StartSource, note: string | undefined, autopilot: AutopilotRef | undefined, now: number, ids: Ids, goalId?: string): Step {
  if (run !== null && (run.state.kind === "active" || run.state.kind === "proposed"))
    return { run, reply: refusedReply(`A track is already running (${run.machine.id}). Finish it, or ask the owner to abort it in the Stages tab.`) };
  let machine: Machine;
  if (source.kind === "skill") machine = source.machine;
  else {
    const parsed = parseMachine(source.machine);
    if (!parsed.ok) return { run, reply: refusedReply(`The track is invalid: ${parsed.error}`) };
    machine = parsed.machine;
  }
  const badAutopilot = autopilot === undefined ? null : autopilotRefusal(autopilot);
  if (badAutopilot) return { run, reply: refusedReply(badAutopilot) };
  const plan: DriverPlan = autopilot ? { track: { kind: "autopilot", ...autopilot }, stages: {} } : { stages: {} };
  const fresh: Run = {
    version: 2,
    runId: ids.newRunId(),
    machine,
    source: source.kind === "skill" ? { kind: "skill", skill: source.skill } : { kind: "adhoc" },
    outputs: {},
    evidence: {},
    lastVisit: {},
    pendingTell: null,
    plan,
    goalId: goalId ?? null,
    paused: false,
    // R3: rev and publication carry over from the run this one replaces.
    rev: run?.rev ?? 0,
    publishedRev: run?.publishedRev ?? 0,
    nextSeq: 1,
    state: { kind: "proposed", formId: 1, ...(note ? { note: clip(note, 2000) } : {}) },
    log: [],
    logDropped: 0,
  };
  if (source.kind === "adhoc") return { run: { ...fresh, nextSeq: 2 }, reply: { kind: "proposed" } };
  const first = firstStage(machine);
  const started = mint(fresh, first, driverFor(machine, plan, first), "start", now, "the track started") as Active;
  return { run: started, reply: { kind: "started", ticket: ticketOf(started, started.state.lease), station: stationOf(started)! } };
}

function submit(run: Active, input: { outputs?: Record<string, string>; evidence?: Record<string, string>; usage?: LeaseUsage }, now: number): Step {
  const lease = run.state.lease;
  if (lease.work?.kind === "gate") return { run, reply: { kind: "busy", work: lease.work } };
  const stage = stageOf(run.machine, lease.stage);
  const outputNames = new Set(stage.outputs.map((o) => o.name));
  const rules = gateRules(stage);
  const evidenceNames = new Set(rules.flatMap((r) => (r.type === "evidence" ? [r.name] : [])));
  const ranOnly = new Set(rules.flatMap((r) => (r.type === "evidence" && r.ran ? [r.name] : [])));
  const outputs = input.outputs ?? {};
  const evidence = input.evidence ?? {};
  const unknownOut = Object.keys(outputs).filter((n) => !outputNames.has(n));
  const unknownEv = Object.keys(evidence).filter((n) => !evidenceNames.has(n));
  const typedRan = Object.keys(evidence).filter((n) => ranOnly.has(n));
  const reasons = [
    unknownOut.length ? `Unknown outputs for stage "${stage.id}": ${unknownOut.join(", ")} (expected: ${[...outputNames].join(", ") || "none"})` : "",
    unknownEv.length ? `Unknown evidence: ${unknownEv.join(", ")} (expected: ${[...evidenceNames].join(", ") || "none"})` : "",
    typedRan.length ? `Evidence ${typedRan.join(", ")} is recorded only by a plugin-run command (sandy work track drive run --label <name>)` : "",
  ].filter(Boolean);
  if (reasons.length) return { run, reply: { kind: "refused", reasons } };
  if (!Object.keys(outputs).length && !Object.keys(evidence).length && input.usage === undefined)
    return { run, reply: refusedReply("Nothing to submit: pass outputs and/or evidence.") };
  const texts: TextEvidence[] = Object.entries(evidence).map(([name, text]) => ({ kind: "text", name, text: clip(text, TEXT_EVIDENCE_CHARS), seq: lease.seq, at: now }));
  const submissions: Submissions = {
    outputs: { ...lease.submissions.outputs, ...outputs },
    evidence: [...lease.submissions.evidence.filter((e) => !(e.kind === "text" && e.name in evidence)), ...texts],
  };
  const next = withLease(run, { ...lease, submissions, usage: input.usage ?? lease.usage });
  return { run: next, reply: { kind: "accepted", station: stationOf(next)! } };
}

function advance(run: Active, to: string | undefined, note: string | undefined, usage: LeaseUsage | undefined, goal: GoalVerdict | undefined, now: number): Step {
  const lease = run.state.lease;
  if (lease.work !== null) return { run, reply: { kind: "busy", work: lease.work } };
  const stage = stageOf(run.machine, lease.stage);
  const edge = pickEdge(stage, to);
  if (!edge.ok) return { run, reply: refusedReply(edge.error) };
  const rules = rulesFor(stage, edge.to);
  const results: Record<string, RuleResult> = {};
  const reasons: string[] = [];
  for (const { rule, key } of rules) {
    const result = rule.type === "goal" ? goalResult(run.goalId ?? null, goal, rule.optional === true, now) : localResult(stage, rule, lease.submissions, now);
    if (result === null) continue;
    results[key] = result;
    if (!result.ok) reasons.push(result.detail);
  }
  if (reasons.length) return { run, reply: { kind: "refused", reasons } };
  const measured = usage ? withLease(run, { ...lease, usage }) : run;
  const checking = rules.some((r) => r.rule.type === "check");
  if (checking || rules.some((r) => r.rule.type === "user")) {
    const work: Work = { kind: "gate", id: run.nextSeq, to: edge.to, ...(note ? { note: clip(note, 2000) } : {}), phase: checking ? "checking" : "asking", results, startedIn: null };
    return { run: { ...withLease(measured, { ...measured.state.lease, work }), nextSeq: run.nextSeq + 1 }, reply: { kind: "pending", workId: work.id } };
  }
  return pass(measured, edge.to, now, "its gate passed", usage);
}

function proposeForce(run: Active, to: string, reason: string): Step {
  const lease = run.state.lease;
  if (lease.work !== null) return { run, reply: { kind: "busy", work: lease.work } };
  if (!run.machine.stages.some((s) => s.id === to)) return { run, reply: refusedReply(`"${to}" is not a stage of this track`) };
  const why = clip(reason.trim(), REASON_CHARS);
  if (!why) return { run, reply: refusedReply("A force proposal needs a reason: what blocks the gate and cannot be unblocked.") };
  const work: Work = { kind: "force-proposal", id: run.nextSeq, to, reason: why };
  return { run: { ...withLease(run, { ...lease, work }), nextSeq: run.nextSeq + 1 }, reply: { kind: "pending", workId: work.id } };
}

/** The gate passed towards to: the visit's submissions become the stage's accepted outputs and evidence. */
function pass(run: Active, to: string | null, now: number, how: string, finalUsage?: LeaseUsage): Step {
  const lease = run.state.lease;
  const accepted: Run = {
    ...run,
    outputs: { ...run.outputs, [lease.stage]: lease.submissions.outputs },
    evidence: { ...run.evidence, [lease.stage]: lease.submissions.evidence },
  };
  const closed = closeLease(accepted, { kind: "advanced", to }, now, finalUsage);
  if (to === null) {
    return { run: mint(closed, null, { kind: "agent" }, "advance", now, ""), reply: { kind: "finished" } };
  }
  const stage = stageOf(run.machine, lease.stage);
  const next = mint(closed, to, driverFor(run.machine, run.plan, to), "advance", now, `advanced from ${stage.title} (${stage.id}): ${how}`);
  return { run: next, reply: { kind: "entered", station: stationOf(next)! } };
}

// ---- owner --------------------------------------------------------------------------------------------------------

function ownerStep(run: Run | null, c: OwnerCommand, now: number): Step {
  if (run === null) return { run, reply: { kind: "none" } };
  switch (c.op) {
    case "force": {
      if (!isActive(run)) return { run, reply: refusedReply("No active track to force.") };
      if (!run.machine.stages.some((s) => s.id === c.to)) return { run, reply: refusedReply(`"${c.to}" is not a stage of this track`) };
      const note = c.note?.trim() ? clip(c.note.trim(), REASON_CHARS) : undefined;
      const closed = closeLease(run, { kind: "forced", to: c.to, by: "owner", ...(note ? { note } : {}) }, now);
      const next = mint(closed, c.to, driverFor(run.machine, run.plan, c.to), "force", now, `the owner forced this stage${note ? `: ${note}` : ""}`);
      return { run: next, reply: { kind: "ok" } };
    }
    case "setDriver":
      return setDriver(run, c, now);
    case "setPaused":
      return run.paused === c.paused ? { run, reply: { kind: "ok" } } : { run: { ...run, paused: c.paused }, reply: { kind: "ok" } };
    case "abort": {
      const reason = c.reason?.trim() ? clip(c.reason.trim(), REASON_CHARS) : "aborted by the owner";
      if (isActive(run)) {
        const closed = closeLease(run, { kind: "aborted", reason }, now);
        return { run: { ...closed, state: { kind: "aborted", at: now, reason } }, reply: { kind: "ok" } };
      }
      if (run.state.kind === "proposed") return { run: { ...run, state: { kind: "aborted", at: now, reason } }, reply: { kind: "ok" } };
      return { run, reply: { kind: "ok" } };
    }
  }
}

function setDriver(run: Run, c: Extract<OwnerCommand, { op: "setDriver" }>, now: number): Step {
  if (run.state.kind === "done" || run.state.kind === "aborted") return { run, reply: refusedReply("The track is not running.") };
  const badAutopilot = c.choice !== "default" && c.choice.kind === "autopilot" ? autopilotRefusal(c.choice) : null;
  if (badAutopilot) return { run, reply: refusedReply(badAutopilot) };
  let plan: DriverPlan;
  if (c.scope === "track") {
    if (c.choice === "default") {
      const { track: _dropped, ...rest } = run.plan;
      plan = rest;
    } else plan = { track: c.choice, stages: {} }; // "Drives all" replaces every stage override.
  } else {
    const stage = c.stage;
    if (stage === undefined || !run.machine.stages.some((s) => s.id === stage)) return { run, reply: refusedReply(`"${stage ?? ""}" is not a stage of this track`) };
    const { [stage]: _dropped, ...stages } = run.plan.stages;
    plan = { ...run.plan, stages: c.choice === "default" ? stages : { ...stages, [stage]: c.choice } };
  }
  // An unchanged plan still switches a visit whose driver differs from it (e.g. after a release to the agent, the owner
  // gives the stage back with "Template default"): the owner's call means "drive this as planned now".
  const unchanged = JSON.stringify(plan) === JSON.stringify(run.plan);
  const planned: Run = unchanged ? run : { ...run, plan };
  if (!isActive(planned)) return { run: planned, reply: { kind: "ok" } };
  const lease = planned.state.lease;
  const driver = driverFor(run.machine, plan, lease.stage);
  if (sameDriver(driver, lease.driver)) return { run: planned, reply: { kind: "ok" } };
  const closed = closeLease(planned, { kind: "switched", to: driver }, now);
  return { run: mint(closed, lease.stage, driver, "switch", now, `the owner switched this stage to ${driverLabel(driver)}`), reply: { kind: "ok" } };
}

// ---- system -------------------------------------------------------------------------------------------------------

function systemStep(run: Run | null, c: SystemCommand, now: number): Step {
  if (run === null) return { run, reply: { kind: "none" } };
  const ignored = (reason: string): Step => ({ run, reply: stale(run, reason) });
  if ((c.op === "answered" || c.op === "woke") && c.runId !== run.runId) return ignored("that form or message belongs to another run");
  switch (c.op) {
    case "reconcile":
      return { run, reply: { kind: "ok" } };
    case "recover":
      return { run: interruptStale(run, c.boot), reply: { kind: "ok" } };
    case "tick":
      return { run: expire(run, now), reply: { kind: "ok" } };
    case "published":
      if (c.rev > run.rev || c.rev <= run.publishedRev) return ignored(`rev ${c.rev} is not newer than the published ${run.publishedRev}`);
    {
      const published = applyTold({ ...run, publishedRev: c.rev }, c.told, now);
      const replied = c.replied === true && run.pendingTell !== null && run.pendingTell.rev <= c.rev;
      return { run: replied ? { ...published, pendingTell: null } : published, reply: { kind: "ok" } };
    }
    case "pendingTold":
      if (run.runId !== c.runId || run.pendingTell?.rev !== c.rev) return ignored("nothing owed");
      return { run: { ...run, pendingTell: null }, reply: { kind: "ok" } };
    case "answered":
      if (c.ticket === null) {
        if (run.state.kind !== "proposed" || run.state.formId !== c.formId) return ignored("no such open form");
        if (!c.approved) return { run: { ...run, state: { kind: "aborted", at: now, reason: "the owner rejected the track" } }, reply: { kind: "ok" } };
        const first = firstStage(run.machine);
        return { run: mint(run, first, driverFor(run.machine, run.plan, first), "start", now, "the owner approved the track"), reply: { kind: "ok" } };
      }
      break;
    case "woke":
      if (c.ticket === null) {
        if (run.state.kind !== "done" || run.state.told) return ignored("nothing to tell");
        return { run: { ...run, pendingTell: null, state: { ...run.state, told: true } }, reply: { kind: "ok" } };
      }
      break;
  }
  if (!isActive(run) || ticketOf(run, run.state.lease) !== c.ticket) return ignored("that lease is not current");
  const lease = run.state.lease;
  const work = lease.work;
  switch (c.op) {
    case "woke": {
      if (lease.wake.kind !== "none") return { run, reply: { kind: "ok" } };
      if ((c.kind === "told") !== (lease.driver.kind === "agent")) return ignored(`a ${c.kind} wake does not fit ${driverLabel(lease.driver)}`);
      const wake: Wake = c.kind === "told" ? { kind: "told", at: now } : { kind: "launched", at: now, attempt: c.attempt };
      // T1: the wake message (or the launch in the agent's thread) covers what an agent call was owed.
      return { run: { ...withLease(run, { ...lease, wake }), pendingTell: null }, reply: { kind: "ok" } };
    }
    case "workStarted": {
      if (work === null || work.id !== c.workId || work.kind === "force-proposal" || (work.kind === "gate" && work.phase !== "checking")) return ignored("no such job");
      if (work.startedIn === c.boot) return { run, reply: { kind: "ok" } };
      if (work.startedIn !== null) return ignored(`started by boot ${work.startedIn}`);
      return { run: withLease(run, { ...lease, work: { ...work, startedIn: c.boot } }), reply: { kind: "ok" } };
    }
    case "checked": {
      if (work?.kind !== "gate" || work.id !== c.workId || work.phase !== "checking") return ignored("no such gate check");
      const rules = rulesFor(stageOf(run.machine, lease.stage), work.to);
      const failed = rules.flatMap(({ rule, key }) => {
        if (rule.type !== "check" || c.results[key]?.ok) return [];
        const result = c.results[key];
        return [`${rule.label ?? rule.command}: ${result ? result.detail : "not checked"}`];
      });
      if (failed.length) return { run: withLease(run, { ...lease, work: null, outcome: { kind: "refused", workId: work.id, reasons: failed, delivered: false } }), reply: { kind: "ok" } };
      if (rules.some((r) => r.rule.type === "user"))
        return { run: withLease(run, { ...lease, work: { ...work, phase: "asking", results: { ...work.results, ...c.results } } }), reply: { kind: "ok" } };
      return { run: pass(run, work.to, now, "its gate passed").run, reply: { kind: "ok" } };
    }
    case "ran": {
      if (work?.kind !== "run" || work.id !== c.workId) return ignored("no such command");
      const ran: RanEvidence = { kind: "ran", name: work.label, command: work.command, exitCode: c.exitCode, durationMs: c.durationMs, tail: c.tail.slice(-TAIL_CHARS), seq: lease.seq, at: now };
      const submissions: Submissions = { ...lease.submissions, evidence: [...lease.submissions.evidence.filter((e) => !(e.kind === "ran" && e.name === ran.name)), ran] };
      const outcome = { kind: "ran" as const, workId: work.id, label: work.label, exitCode: c.exitCode, delivered: false };
      return { run: withLease(run, { ...lease, work: null, submissions, outcome }), reply: { kind: "ok" } };
    }
    case "interrupted": {
      if (work === null || work.id !== c.workId || !(work.kind === "run" || (work.kind === "gate" && work.phase === "checking"))) return ignored("no such job");
      const outcome = { kind: "interrupted" as const, workId: work.id, what: work.kind, reason: clip(c.reason, REASON_CHARS), delivered: false };
      return { run: withLease(run, { ...lease, work: null, outcome }), reply: { kind: "ok" } };
    }
    case "answered": {
      if (work === null || work.id !== c.formId || work.kind === "run" || (work.kind === "gate" && work.phase !== "asking")) return ignored("no such open form");
      const ownerNote = c.note?.trim() ? clip(c.note.trim(), REASON_CHARS) : undefined;
      if (work.kind === "gate") {
        if (c.approved) return { run: pass(run, work.to, now, `the owner approved its gate${ownerNote ? `: ${ownerNote}` : ""}`).run, reply: { kind: "ok" } };
        const reasons = ["the owner did not approve the gate", ...(ownerNote ? [`owner's note: ${ownerNote}`] : [])];
        return { run: withLease(run, { ...lease, work: null, outcome: { kind: "refused", workId: work.id, reasons, delivered: false } }), reply: { kind: "ok" } };
      }
      if (!c.approved) return { run: withLease(run, { ...lease, work: null, outcome: { kind: "force-rejected", workId: work.id, to: work.to, delivered: false } }), reply: { kind: "ok" } };
      const closed = closeLease(run, { kind: "forced", to: work.to, by: "proposal", note: work.reason }, now);
      return { run: mint(closed, work.to, driverFor(run.machine, run.plan, work.to), "force", now, `approved force proposal: ${work.reason}`), reply: { kind: "ok" } };
    }
    case "unsaved": {
      if (work === null || work.id !== c.workId) return ignored("no such job");
      const outcome = { kind: "unsaved" as const, workId: work.id, what: work.kind, reason: c.reason, delivered: false };
      return { run: withLease(run, { ...lease, work: null, outcome }), reply: { kind: "ok" } };
    }
    case "outcomeTold": {
      if (lease.outcome === null || lease.outcome.workId !== c.workId) return ignored("no such outcome");
      if (lease.outcome.delivered) return { run, reply: { kind: "ok" } };
      return { run: withLease(run, { ...lease, outcome: { ...lease.outcome, delivered: true } }), reply: { kind: "ok" } };
    }
  }
}

// ---- leases -------------------------------------------------------------------------------------------------------

/**
 * The only producer of Lease values. stage === null finishes the run (state done, told false).
 * A visit cause (VISIT_CAUSES) starts with empty submissions and the stage's last visit as previous; any other cause
 * is the same visit under another driver and carries the replaced lease's submissions and previous.
 */
export function mint(run: Run, stage: string | null, driver: Driver, cause: LeaseCause, now: number, causeText: string): Run {
  if (stage === null) return { ...run, state: { kind: "done", at: now, told: false } };
  const current = run.state.kind === "active" ? run.state.lease : null;
  const sameVisit = current !== null && !VISIT_CAUSES.includes(cause);
  const lease: Lease = {
    seq: run.nextSeq,
    stage,
    driver,
    cause,
    causeText: clip(causeText, CAUSE_CHARS),
    mintedAt: now,
    wake: { kind: "none" },
    claim: null,
    work: null,
    outcome: null,
    submissions: sameVisit ? current.submissions : EMPTY,
    previous: sameVisit ? current.previous : boundedPrevious(run.lastVisit[stage] ?? null),
    usage: null,
  };
  return { ...run, nextSeq: run.nextSeq + 1, state: { kind: "active", lease } };
}

/** A stage's last visit as a new lease carries it: values clipped, the last PREVIOUS_EVIDENCE evidence entries. */
export function boundedPrevious(visit: PreviousVisit | null): PreviousVisit | null {
  if (visit === null) return null;
  const outputs = Object.fromEntries(Object.entries(visit.submissions.outputs).map(([name, value]) => [name, clip(value, PREVIOUS_VALUE_CHARS)]));
  const evidence = visit.submissions.evidence.slice(-PREVIOUS_EVIDENCE).map((e): Evidence =>
    e.kind === "text" ? { ...e, text: clip(e.text, PREVIOUS_VALUE_CHARS) } : { ...e, command: clip(e.command, PREVIOUS_VALUE_CHARS), tail: e.tail.slice(-PREVIOUS_VALUE_CHARS) },
  );
  return { ...visit, submissions: { outputs, evidence } };
}

function autopilotRefusal(ref: AutopilotRef): string | null {
  if (!AUTOPILOT_NAME.test(ref.name)) return "autopilot name: a-z 0-9 -, at most 48 characters";
  if ((ref.args ?? "").length > ARGS_CHARS) return `autopilot args: at most ${ARGS_CHARS} characters`;
  return null;
}

/**
 * Appends the current lease to run.log (capped at LOG_LIMIT) and records it as its stage's last visit.
 * finalUsage: the usage the driver's own closing call (advance, release) reported. Without it the lease's last
 * checkpoint is kept and marked partial: model work after the last report is not counted (forced, switched, expired,
 * aborted, or a gate settled after the advance call). The track guard's late meter report (MeterCommand) replaces the
 * row's usage afterwards and clears the mark, also for a row that has none yet.
 */
export function closeLease(run: Run, end: LeaseEnd, now: number, finalUsage?: LeaseUsage): Run {
  if (run.state.kind !== "active") return run;
  const lease = run.state.lease;
  const row: ClosedLease = {
    seq: lease.seq,
    stage: lease.stage,
    driver: lease.driver,
    cause: lease.cause,
    mintedAt: lease.mintedAt,
    endedAt: now,
    end,
    usage: finalUsage ?? lease.usage,
    usagePartial: finalUsage === undefined && lease.usage !== null,
    ran: lease.submissions.evidence.flatMap((e) => (e.kind === "ran" ? [{ name: e.name, exitCode: e.exitCode }] : [])),
  };
  const log = [...run.log, row];
  const dropped = Math.max(0, log.length - LOG_LIMIT);
  return {
    ...run,
    log: log.slice(dropped),
    logDropped: run.logDropped + dropped,
    lastVisit: { ...run.lastVisit, [lease.stage]: { seq: lease.seq, driver: lease.driver, end, endedAt: now, submissions: lease.submissions } },
  };
}

/** Owner stage override > owner track override > template stage.autopilot > agent. */
export function driverFor(machine: Machine, plan: DriverPlan, stage: string): Driver {
  const chosen = plan.stages[stage] ?? plan.track;
  if (chosen) return chosen;
  const autopilot = machine.stages.find((s) => s.id === stage)?.autopilot;
  return autopilot ? { kind: "autopilot", ...autopilot } : { kind: "agent" };
}

/** Launch grace and heartbeat deadlines (step on tick). Every chain ends in an agent lease. */
export function expire(run: Run, now: number): Run {
  if (!isActive(run)) return run;
  const lease = run.state.lease;
  if (lease.driver.kind !== "autopilot") return run;
  const label = driverLabel(lease.driver);
  if (lease.claim === null && lease.wake.kind === "launched" && now > lease.wake.at + LAUNCH_GRACE_SEC * 1000) {
    const closed = closeLease(run, { kind: "expired", what: "launch" }, now);
    if (lease.wake.attempt < MAX_LAUNCH_ATTEMPTS) return mint(closed, lease.stage, lease.driver, "relaunch", now, `${label} did not take its launch in time; launching it again`);
    return mint(closed, lease.stage, { kind: "agent" }, "expired", now, `${label} did not start after ${lease.wake.attempt} launches; the stage is yours`);
  }
  if (lease.claim !== null && now > lease.claim.expiresAt) {
    const closed = closeLease(run, { kind: "expired", what: "heartbeat" }, now);
    return mint(closed, lease.stage, { kind: "agent" }, "expired", now, `${label} stopped renewing its lease; the stage is yours`);
  }
  return run;
}

/** Work started by a boot other than this one becomes outcome interrupted (step on recover); it is never run again. */
export function interruptStale(run: Run, boot: string): Run {
  if (!isActive(run)) return run;
  const lease = run.state.lease;
  const work = lease.work;
  if (work === null || work.kind === "force-proposal" || (work.kind === "gate" && work.phase !== "checking")) return run;
  if (work.startedIn === null || work.startedIn === boot) return run;
  return withLease(run, { ...lease, work: null, outcome: { kind: "interrupted", workId: work.id, what: work.kind, delivered: false } });
}

// ---- effects ------------------------------------------------------------------------------------------------------

export type AskForm = { rendererId: "gate-approval" | "track-approval" | "force-proposal"; title: string; payload: unknown };

export type Effect =
  | { key: string; kind: "publish"; rev: number }
  | { key: string; kind: "check"; ticket: Ticket; workId: number; startedIn: string | null; checks: { ruleKey: string; command: string; timeoutSec: number }[] }
  | { key: string; kind: "run"; ticket: Ticket; workId: number; startedIn: string | null; command: string; timeoutSec: number }
  | { key: string; kind: "ask"; runId: RunId; ticket: Ticket | null; formId: number; form: AskForm }
  | { key: string; kind: "launch"; runId: RunId; ticket: Ticket; attempt: number; text: string } // "/autopilot --lease <ticket> <name> <args>"
  | { key: string; kind: "tell"; runId: RunId; ticket: Ticket | null; text: string }
  | { key: string; kind: "tellOutcome"; ticket: Ticket; workId: number; text: string }
  | { key: string; kind: "tellPending"; runId: RunId; rev: number; text: string };

/**
 * What the executor should be doing, from the committed run only.
 * INVARIANT D1: an active run always has a tell or launch effect, or a persisted deadline whose expiry mints an agent
 *               lease. Tell and launch wait for publishedRev === rev, so a driver never acts under an older policy.
 * INVARIANT D2: every effect key contains the ticket and the work/form id (publish: the rev).
 * INVARIANT D3: check and run effects carry work.startedIn; the executor starts a job only after workStarted granted it
 *               to its boot, and recover interrupts work of another boot, so a started job is never run twice.
 */
export function desired(run: Run | null): Effect[] {
  if (run === null) return [];
  const effects: Effect[] = [];
  const published = run.publishedRev >= run.rev;
  if (!published) effects.push({ key: `publish:${run.rev}`, kind: "publish", rev: run.rev });
  const state = run.state;
  if (published && run.pendingTell !== null && !wakeDue(run)) {
    const text = `Your last track call is in effect now: the guard policy of rev ${run.pendingTell.rev} is written. Do not repeat it.\n\n${statusText(run)}`;
    effects.push({ key: `pending:${run.runId}:${run.pendingTell.rev}`, kind: "tellPending", runId: run.runId, rev: run.pendingTell.rev, text });
  }
  if (state.kind === "proposed") {
    const form: AskForm = { rendererId: "track-approval", title: clip(`Approve track: ${run.machine.title}`, 120), payload: { machine: run.machine, note: state.note ?? null } };
    effects.push({ key: `ask:${run.runId}:${state.formId}`, kind: "ask", runId: run.runId, ticket: null, formId: state.formId, form });
    return effects;
  }
  if (state.kind === "done") {
    if (!state.told && published) effects.push({ key: `tell:${run.runId}:done`, kind: "tell", runId: run.runId, ticket: null, text: `Track "${run.machine.title}" finished.` });
    return effects;
  }
  if (state.kind !== "active") return effects;
  const lease = state.lease;
  const ticket = ticketOf(run, lease);
  if (published && lease.wake.kind === "none") {
    if (lease.driver.kind === "agent") effects.push({ key: `tell:${ticket}`, kind: "tell", runId: run.runId, ticket, text: tellText(run, lease) });
    else if (lease.claim === null) {
      const text = `/autopilot --lease ${ticket} ${lease.driver.name}${lease.driver.args ? ` ${lease.driver.args}` : ""}`;
      effects.push({ key: `launch:${ticket}`, kind: "launch", runId: run.runId, ticket, attempt: launchAttempt(run, lease), text });
    }
  }
  if (published && lease.driver.kind === "agent" && lease.outcome !== null && !lease.outcome.delivered)
    effects.push({ key: `outcome:${ticket}:${lease.outcome.workId}`, kind: "tellOutcome", ticket, workId: lease.outcome.workId, text: outcomeText(run, lease, lease.outcome) });
  const work = lease.work;
  if (work === null) return effects;
  const stage = stageOf(run.machine, lease.stage);
  if (work.kind === "run") {
    effects.push({ key: `run:${ticket}:${work.id}`, kind: "run", ticket, workId: work.id, startedIn: work.startedIn, command: work.command, timeoutSec: work.timeoutSec });
  } else if (work.kind === "gate" && work.phase === "checking") {
    const checks = rulesFor(stage, work.to).flatMap(({ rule, key }) => (rule.type === "check" ? [{ ruleKey: key, command: rule.command, timeoutSec: rule.timeoutSec ?? RUN_TIMEOUT_SEC }] : []));
    effects.push({ key: `check:${ticket}:${work.id}`, kind: "check", ticket, workId: work.id, startedIn: work.startedIn, checks });
  } else if (work.kind === "gate") {
    effects.push({ key: `ask:${ticket}:${work.id}`, kind: "ask", runId: run.runId, ticket, formId: work.id, form: gateForm(run, lease, stage, work) });
  } else {
    const target = stageOf(run.machine, work.to);
    const form: AskForm = {
      rendererId: "force-proposal",
      title: clip(`Force proposal: ${stage.title} → ${target.title}`, 120),
      payload: { machine: run.machine.title, from: { id: stage.id, title: stage.title }, to: { id: target.id, title: target.title }, reason: work.reason, driver: driverLabel(lease.driver) },
    };
    effects.push({ key: `ask:${ticket}:${work.id}`, kind: "ask", runId: run.runId, ticket, formId: work.id, form });
  }
  return effects;
}

/** A tell or launch of the published run is due; its woke clears pendingTell (T1), so no second message is sent. */
function wakeDue(run: Run): boolean {
  if (run.state.kind === "done") return !run.state.told;
  if (run.state.kind !== "active") return false;
  const lease = run.state.lease;
  return lease.wake.kind === "none" && (lease.driver.kind === "agent" || lease.claim === null);
}

/** 1 + the launches of this stage that expired unclaimed right before this lease. */
function launchAttempt(run: Run, lease: Lease): number {
  let attempt = 1;
  for (let i = run.log.length - 1; i >= 0; i--) {
    const row = run.log[i]!;
    if (row.stage !== lease.stage || row.end.kind !== "expired" || row.end.what !== "launch") break;
    attempt++;
  }
  return attempt;
}

function gateForm(run: Run, lease: Lease, stage: Stage, work: Extract<Work, { kind: "gate" }>): AskForm {
  const target = work.to === null ? null : stageOf(run.machine, work.to);
  const prompts = rulesFor(stage, work.to).flatMap(({ rule }) => (rule.type === "user" ? [rule.prompt ?? "Approve this gate?"] : []));
  return {
    rendererId: "gate-approval",
    title: clip(`Gate: ${stage.title} → ${target?.title ?? "finish"}`, 120),
    payload: {
      machine: run.machine.title,
      stage: { id: stage.id, title: stage.title },
      to: target === null ? null : { id: target.id, title: target.title },
      prompts,
      note: work.note ?? null,
      driver: driverLabel(lease.driver),
      outputs: stage.outputs.map((o) => ({ name: o.name, value: lease.submissions.outputs[o.name] ?? null })),
      evidence: lease.submissions.evidence.map((e) => ({ name: e.name, value: evidenceValue(e) })),
      results: Object.values(work.results).map((r) => ({ ok: r.ok, detail: clip(r.detail, SHOWN_VALUE_CHARS) })),
    },
  };
}

// ---- texts --------------------------------------------------------------------------------------------------------

export function driverLabel(driver: Driver): string {
  return driver.kind === "agent" ? "the agent" : `autopilot ${driver.name}`;
}

/** How a lease ended, as the next driver of its stage reads it: "Last visit (ended: <endText>)". */
export function endText(end: LeaseEnd): string {
  switch (end.kind) {
    case "advanced":
      return end.to === null ? "the track finished" : `advanced to ${end.to}`;
    case "forced":
      return end.by === "owner" ? `forced by the owner${end.note ? `: ${end.note}` : ""}` : `forced by an approved proposal: ${end.note ?? ""}`;
    case "switched":
      return `the owner switched the driver to ${driverLabel(end.to)}`;
    case "released":
      return `released by the autopilot: ${end.reason}`;
    case "expired":
      return end.what === "launch" ? "the autopilot did not take its launch in time" : "the autopilot stopped renewing its lease";
    case "aborted":
      return `aborted: ${end.reason}`;
  }
}

function evidenceValue(e: Evidence): string {
  return e.kind === "text" ? e.text : "`" + e.command + "` exited " + e.exitCode + " in " + e.durationMs + " ms";
}

/** What a set of submissions holds, on one line with values clipped. */
export function submissionsText(submissions: Submissions): string {
  const parts = [
    ...Object.entries(submissions.outputs).map(([name, value]) => `${name}: ${clip(value.replace(/\s+/g, " "), SHOWN_VALUE_CHARS)}`),
    ...submissions.evidence.map((e) => `evidence ${e.name}: ${clip(evidenceValue(e).replace(/\s+/g, " "), SHOWN_VALUE_CHARS)}`),
  ];
  return parts.length ? parts.join("; ") : "nothing";
}

/** The read-only context of a new visit: how the stage's last visit ended and what it submitted. */
export function previousText(previous: PreviousVisit): string {
  return `Last visit (ended: ${endText(previous.end)}) submitted: ${submissionsText(previous.submissions)}. It does not count for this visit's gate.`;
}

/** An agent lease's start message: the whole stage brief, so the agent needs no stage_status call before it works. */
function tellText(run: Run, lease: Lease): string {
  const stage = stageOf(run.machine, lease.stage);
  return [`Track "${run.machine.title}": you drive stage "${stage.title}" (${stage.id}) now, ticket ${ticketOf(run, lease)}.`, ...briefLines(run, lease)].join("\n");
}

function outcomeText(run: Run, lease: Lease, outcome: Outcome): string {
  const stage = stageOf(run.machine, lease.stage);
  const head = `Track "${run.machine.title}", stage "${stage.title}" (ticket ${ticketOf(run, lease)}):`;
  switch (outcome.kind) {
    case "refused":
      return `${head} the gate did not pass.\n${outcome.reasons.map((r) => `- ${r}`).join("\n")}`;
    case "ran":
      return `${head} "${outcome.label}" exited ${outcome.exitCode}.`;
    case "interrupted":
      return `${head} the ${outcome.what === "gate" ? "gate check" : "command"} was interrupted (${outcome.reason ?? "a plugin restart"}) and was not run again. ${outcome.what === "gate" ? "Call stage_advance to check the gate again." : "Run it again if you still need it."}`;
    case "force-rejected":
      return `${head} the owner rejected your force proposal to "${outcome.to}". The stage stays yours.`;
    case "unsaved":
      return `${head} the result of the ${outcome.what === "gate" ? "gate" : outcome.what === "run" ? "command" : "force proposal"} was not kept: ${outcome.reason} The stage stays yours.`;
  }
}

/** stage_status and sandy work track status: the run as the driver of the current stage reads it. */
export function statusText(run: Run | null): string {
  if (run === null) return "No track in this thread. Start one with stage_start.";
  const state = run.state;
  const head = `Track "${run.machine.title}" (${run.machine.id}), ${state.kind}${run.paused ? ", guard paused by the owner" : ""}`;
  if (state.kind === "proposed") return `${head}: waiting for the owner to approve it.`;
  if (state.kind === "done") return `${head}: finished.`;
  if (state.kind === "aborted") return `${head}: ${state.reason}.`;
  const lease = state.lease;
  const stage = stageOf(run.machine, lease.stage);
  const driver = lease.driver.kind === "autopilot" ? driverLabel(lease.driver) : "you (the agent)";
  return [head, `Stage ${stage.id} — ${stage.title}, driven by ${driver}, ticket ${ticketOf(run, lease)}.`, ...briefLines(run, lease)].join("\n");
}

/** The stage of a lease as its driver reads it: why, inputs, outputs, allowed tools, gate, next, running work, results. */
function briefLines(run: Run, lease: Lease): string[] {
  const stage = stageOf(run.machine, lease.stage);
  const autopilot = lease.driver.kind === "autopilot";
  const lines = [`Why: ${lease.causeText}.`];
  if (autopilot) lines.push("Do not call stage_submit or stage_advance; end your turn and let the autopilot drive.");
  if (stage.description) lines.push(stage.description);
  if (stage.inputs.length) {
    lines.push("Inputs:");
    for (const input of stage.inputs) {
      const [from, name] = input.split(".");
      const value = name === undefined ? undefined : run.outputs[from!]?.[name];
      lines.push(`  - ${input}${value === undefined ? " (not produced)" : `: ${clip(value, 400)}`}`);
    }
  }
  if (stage.outputs.length) {
    lines.push(autopilot ? "Outputs:" : "Outputs (submit with stage_submit):");
    for (const o of stage.outputs) {
      const value = lease.submissions.outputs[o.name];
      lines.push(`  - [${value?.trim() ? "x" : " "}] ${o.name}${o.optional ? " (optional)" : ""}${o.description ? `: ${o.description}` : ""}${value?.trim() ? ` = ${clip(value.replace(/\s+/g, " "), SHOWN_VALUE_CHARS)}` : ""}`);
    }
  }
  if (lease.submissions.evidence.length) lines.push(`Evidence: ${lease.submissions.evidence.map((e) => `${e.name}: ${clip(evidenceValue(e).replace(/\s+/g, " "), SHOWN_VALUE_CHARS)}`).join("; ")}`);
  const allow = effectiveAllow(run.machine, stage);
  const allowed = [
    allow.skills ? `skills: ${allow.skills.join(", ") || "none"}` : "skills: any",
    allow.edits === false ? "no file edits" : "file edits",
    allow.subagents ? `subagents: ${allow.subagents.map((s) => `${s.agent ?? "*"}${s.model ? "@" + s.model : ""}`).join(", ") || "none"}` : "subagents: any",
    ...(allow.denyTools?.length ? [`blocked tools: ${allow.denyTools.join(", ")}`] : []),
  ];
  lines.push(`Allowed in this stage: ${allowed.join("; ")}`);
  if (stage.gate.length) {
    lines.push("Gate:");
    for (const rule of stage.gate) {
      const local = localResult(stage, rule, lease.submissions, 0);
      lines.push(`  - [${local?.ok ? "x" : " "}] ${rule.type}: ${describeRule(rule)}`);
    }
  }
  if (stage.next.length) {
    lines.push("Next:");
    for (const e of stage.next) lines.push(`  - ${e.to}${e.when ? ` — when ${e.when}` : ""}${e.gate?.length ? ` (extra gate: ${e.gate.map(describeRule).join("; ")})` : ""}`);
  } else lines.push("Final stage: stage_advance without to finishes the track.");
  const work = lease.work;
  if (work?.kind === "gate") lines.push(work.phase === "checking" ? "The gate checks are running." : "Waiting for the owner's gate approval in the composer.");
  else if (work?.kind === "run") lines.push(`Running "${work.label}": ${clip(work.command, 200)}`);
  else if (work?.kind === "force-proposal") lines.push(`Waiting for the owner on your force proposal to "${work.to}".`);
  if (lease.outcome !== null) lines.push(`Last result: ${outcomeText(run, lease, lease.outcome)}`);
  if (lease.previous) lines.push(previousText(lease.previous));
  return lines;
}

// ---- policy and views ---------------------------------------------------------------------------------------------

/** The guard's input, built only from a committed run. Additive over v1 (rev, ticket); enteredAt is gone. */
export type PolicyFile = {
  version: 1;
  threadId: string;
  active: boolean;
  running: boolean;
  runId: RunId | "";
  rev: number;
  ticket: Ticket | "";
  machine: string;
  stage: string;
  stageTitle: string;
  next: string[];
  allow: Allow;
  driver: Driver;
  /** The goal the run serves (A3), null without one. */
  goalId: string | null;
  /** Who the lease waits for: "owner" (gate approval, force proposal), "track" (checks or a run), null (the driver). */
  waiting: "owner" | "track" | null;
};

/** The lease's open work as the guard and the goal scheduler see it; the plugin tells the driver when it ends. */
export function waitingOf(work: Work | null): PolicyFile["waiting"] {
  if (work === null) return null;
  if (work.kind === "force-proposal" || (work.kind === "gate" && work.phase === "asking")) return "owner";
  return "track";
}

export function policyFor(threadId: string, run: Run | null): PolicyFile {
  if (run === null || !isActive(run))
    return { version: 1, threadId, active: false, running: false, runId: run?.runId ?? "", rev: run?.rev ?? 0, ticket: "", machine: run?.machine.id ?? "", stage: "", stageTitle: "", next: [], allow: {}, driver: { kind: "agent" }, goalId: run?.goalId ?? null, waiting: null };
  const lease = run.state.lease;
  const stage = stageOf(run.machine, lease.stage);
  return {
    version: 1,
    threadId,
    active: !run.paused,
    running: true,
    runId: run.runId,
    rev: run.rev,
    ticket: ticketOf(run, lease),
    machine: run.machine.id,
    stage: stage.id,
    stageTitle: stage.title,
    next: stage.next.map((e) => e.to),
    allow: effectiveAllow(run.machine, stage),
    driver: lease.driver,
    goalId: run.goalId ?? null,
    waiting: waitingOf(lease.work),
  };
}

export function ticketOf(run: Run, lease: Lease): Ticket {
  return `${run.runId}.${lease.seq}` as Ticket;
}

export function grantOf(run: Run, lease: Lease): Grant | null {
  return lease.claim === null ? null : (`${ticketOf(run, lease)}.${lease.claim.invocation}` as Grant);
}

const LEASE_REF = /^([A-Za-z0-9_-]+)\.(\d{1,15})(?:\.([A-Za-z0-9_-]{1,64}))?$/;
export function parseLeaseRef(ref: string): { runId: RunId; seq: number; invocation: string | null } | null {
  const match = LEASE_REF.exec(ref);
  if (match === null) return null;
  return { runId: match[1]!, seq: Number(match[2]), invocation: match[3] ?? null };
}

export function stationOf(run: Run): StationView | null {
  if (!isActive(run)) return null;
  const lease = run.state.lease;
  const stage = stageOf(run.machine, lease.stage);
  const inputs: Record<string, string> = {};
  for (const input of stage.inputs) {
    const [from, name] = input.split(".");
    const value = name === undefined ? undefined : run.outputs[from!]?.[name];
    if (value !== undefined) inputs[input] = value;
  }
  let outcome: Outcome | null = null;
  if (lease.outcome !== null) {
    const { delivered: _delivered, ...settled } = lease.outcome;
    outcome = settled;
  }
  return {
    runId: run.runId,
    ticket: ticketOf(run, lease),
    track: run.machine.title,
    stage: stage.id,
    title: stage.title,
    driver: lease.driver,
    cause: lease.cause,
    causeText: lease.causeText,
    inputs,
    submissions: lease.submissions,
    missingOutputs: stage.outputs.filter((o) => !o.optional && !(lease.submissions.outputs[o.name] ?? "").trim()).map((o) => o.name),
    next: stage.next.map((e) => e.to),
    work: lease.work,
    outcome,
    previous: lease.previous,
  };
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function isActive(run: Run): run is Active {
  return run.state.kind === "active";
}

function withLease(run: Active, lease: Lease): Active {
  return { ...run, state: { kind: "active", lease } };
}

/**
 * What the reply of an agent call told the agent, for the published command of its rev when that commit wrote the
 * policy: replied (T1), and the told mark of a call that started, entered or finished (applyTold).
 */
export function toldBy(command: Command, reply: Reply): { told?: Ticket | "done"; replied?: true } {
  if (command.by !== "agent") return {};
  if (reply.kind === "finished") return { told: "done", replied: true };
  if ((reply.kind === "started" || reply.kind === "entered") && reply.station.driver.kind === "agent") return { told: reply.station.ticket, replied: true };
  return { replied: true };
}

/**
 * Publication of a rev whose own reply handed the agent its new lease (started/entered) or the finish: the agent
 * learned it from that tool result, so no message follows. Applied only when that rev is published: a reply given
 * while the policy is unwritten is no success, and the message is sent after the retry (graft 3).
 */
function applyTold(run: Run, told: Ticket | "done" | undefined, now: number): Run {
  if (told === "done") return run.state.kind === "done" ? { ...run, state: { ...run.state, told: true } } : run;
  if (told === undefined || !isActive(run)) return run;
  const lease = run.state.lease;
  if (ticketOf(run, lease) !== told || lease.driver.kind !== "agent" || lease.wake.kind !== "none") return run;
  return withLease(run, { ...lease, wake: { kind: "told", at: now } });
}

function renewed(claim: Claim, now: number): Claim {
  return { ...claim, expiresAt: now + HEARTBEAT_SEC * 1000 };
}

function firstStage(machine: Machine): string {
  return machine.start ?? machine.stages[0]!.id;
}

function sameDriver(a: Driver, b: Driver): boolean {
  if (a.kind === "agent" || b.kind === "agent") return a.kind === b.kind;
  return a.name === b.name && (a.args ?? "") === (b.args ?? "");
}

function gateRules(stage: Stage): Rule[] {
  return [...stage.gate, ...stage.next.flatMap((e) => e.gate ?? [])];
}

/** outputs and evidence rules against the visit's submissions; check and user are deferred (null). */
/** A goal rule: the goal the run serves has an approved auditor verdict. */
function goalResult(goalId: string | null, goal: GoalVerdict | undefined, optional: boolean, now: number): RuleResult {
  if (goalId === null && optional) return { ok: true, detail: "this track serves no goal", at: now };
  if (goalId === null) return { ok: false, detail: "this track serves no goal: it started while no goal was focused, so no auditor verdict can pass this gate", at: now };
  if (goal === undefined || goal.goalId !== goalId) return { ok: false, detail: `the auditor's verdict on goal ${goalId} could not be read`, at: now };
  if (goal.verdict === "approved") return { ok: true, detail: `the auditor approved goal ${goalId}`, at: now };
  const what = goal.verdict === "none" ? "has not audited it yet" : `last said "${goal.verdict}"`;
  return { ok: false, detail: `the auditor ${what} on goal ${goalId}: complete the goal (update_goal) so the auditor runs, and fix what it reports`, at: now };
}

function localResult(stage: Stage, rule: Rule, submissions: Submissions, now: number): RuleResult | null {
  if (rule.type === "outputs") {
    const missing = stage.outputs.filter((o) => !o.optional && !(submissions.outputs[o.name] ?? "").trim()).map((o) => o.name);
    return missing.length === 0 ? { ok: true, detail: "all outputs submitted", at: now } : { ok: false, detail: `missing outputs: ${missing.join(", ")}`, at: now };
  }
  if (rule.type === "evidence") {
    const ranOk = submissions.evidence.some((e) => e.kind === "ran" && e.name === rule.name && e.exitCode === 0);
    if (rule.ran)
      return ranOk
        ? { ok: true, detail: `"${rule.name}" ran and exited 0`, at: now }
        : { ok: false, detail: `no passing run "${rule.name}" in this visit (sandy work track drive run --label ${rule.name})`, at: now };
    const typed = submissions.evidence.some((e) => e.kind === "text" && e.name === rule.name && e.text.trim());
    return ranOk || typed
      ? { ok: true, detail: "evidence submitted", at: now }
      : { ok: false, detail: `no evidence "${rule.name}" submitted (stage_submit evidence.${rule.name})`, at: now };
  }
  return null;
}

function refusedReply(reason: string): Reply {
  return { kind: "refused", reasons: [reason] };
}

function stale(run: Run | null, reason: string): Reply {
  return { kind: "stale", reason, current: run ? stationOf(run) : null };
}

function currentReply(run: Run | null): Reply {
  const station = run ? stationOf(run) : null;
  return station ? { kind: "current", station } : { kind: "none" };
}

/**
 * S1: the current lease named by ref, or the reply for a ref that is not current. form says which ref the command
 * takes: the ticket (agent commands, claim), the grant (the autopilot's lease commands) or either (status).
 */
function holder(run: Run | null, ref: string, by: "agent" | "driver", form: "ticket" | "grant" | "any"): { run: Active; granted: boolean } | { reply: Reply } {
  const parsed = parseLeaseRef(ref);
  if (parsed === null) return { reply: stale(run, `"${clip(ref, 80)}" is not a lease ticket`) };
  if (form === "ticket" && parsed.invocation !== null) return { reply: stale(run, "this command takes the lease ticket, not a grant") };
  if (form === "grant" && parsed.invocation === null) return { reply: stale(run, "this command takes the grant from claim, not the ticket") };
  if (run === null || parsed.runId !== run.runId) return { reply: stale(run, "that lease belongs to another run") };
  if (!isActive(run) || run.state.lease.seq !== parsed.seq) {
    const closed = run.log.find((row) => row.seq === parsed.seq);
    return { reply: closed ? { kind: "closed", end: closed.end, current: stationOf(run) } : stale(run, "that lease is not current") };
  }
  const lease = run.state.lease;
  if (by === "agent" && lease.driver.kind !== "agent") return { reply: stale(run, `this stage is driven by ${driverLabel(lease.driver)}`) };
  if (by === "driver") {
    if (lease.driver.kind !== "autopilot") return { reply: stale(run, "the agent drives this stage") };
    if (parsed.invocation !== null && lease.claim?.invocation !== parsed.invocation)
      return { reply: stale(run, lease.claim ? "another launch holds this lease" : "this lease is not claimed") };
  }
  return { run, granted: parsed.invocation !== null };
}
