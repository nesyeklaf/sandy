# Track drivers v2: design

Status: slice 1 (merged sketch). Base: arena candidate 1 ("the lease is the visit"), with the eight grafts of
`/tmp/arena-autopilot/synthesis.md`; candidate 2 supplies the detail of grafts 1, 2, 3, 6, 7 and the re-entry rule.
Probes that this design rests on: [probes-v2.md](probes-v2.md). Compiled scaffold: `sandy/track/run.ts` (pure core),
`sandy/track/effects.ts` (executor), `pi/autopilot/usage.ts`, the v2 block at the end of `pi/autopilot/track.ts` and
`handleLeaseCommand` in `pi/autopilot/autopilot.ts`. Bodies throw until their slice.

## 1. Usage (caller's view)

Agent (tool names unchanged; the model never types a ticket):

```ts
await stage_start({ skill: "dev" });             // result text ends with "⟦track-ticket⟧ <runId>.<seq>"; the guard captures it
await stage_submit({ outputs: { goal: "..." } }); // guard injects ticket + measured usage
await stage_advance({ to: "design" });           // pending -> the plugin tells the outcome in a later message
await stage_propose_force({ to: "explore", reason: "input X is unavailable" }); // owner approves/rejects in the composer
```

Autopilot (one claimed lease per process; never follows the track to another stage):

```ts
export default async function build(args: string, api) {
  const lease = api.lease;                       // LeaseTrack, set only under /autopilot --lease
  const tests = await lease.run({ label: "tests", command: "npm test" }); // host-run, recorded as ran evidence
  await lease.submit({ outputs: { result: "..." } });
  return lease.advance();                        // entered | finished | refused | lost; the plugin launches the next lease
}
```

Owner (Stages tab): per-stage driver picker (Agent / autopilot name / Template default), a "Drives all" picker,
Force (to a stage, with note), Pause guard, Abort, a lease log with cause, end and usage, and the force-proposal form.

```ts
await rpc.call("setDriver", { threadId, scope: "track", choice: { kind: "autopilot", name: "delivery" } });
await rpc.call("setDriver", { threadId, scope: "stage", stage: "review", choice: "default" });
```

## 2. Problem

v1 spreads "who drives this visit" over `lead`, `handedBack`, `enteredAt` (time as identity), the plugin's
`pendingDrives`/`pendingForms`/`checking` maps and the pi station launcher's launched/unreleased sets. Four review
rounds found races at force, restart, equal timestamps and script exit. v2 makes the lease the only owner: every
ownership change mints a new lease with a new sequence number, and everything a lease owns lives inside it.

## 3. Data (`run.ts`)

One `Run` per thread in `sandy.storage.kv` (single key, as v1). Key types: `Lease`, `Claim`, `Work`, `Outcome`,
`Submissions`, `DriverPlan`, `ClosedLease`, `RunState`. Invariants R1-R3, L1-L3 are on the types.

- Ticket = `<runId>.<seq>`; grant = `<runId>.<seq>.<invocation>` (graft 5). Both derived, never stored.
- Driver resolution: `driverFor` = owner stage override > owner track override > template `stage.autopilot` > agent.
  Templates are never edited.
- Re-entry (owner decision): a lease minted by start/advance/force (`VISIT_CAUSES`) starts with empty submissions and
  `previous` = the last visit of that stage (read-only context: its driver, how it ended as `LeaseEnd`, what it
  submitted); a lease minted by switch, release, expired or relaunch carries the replaced lease's submissions and
  previous (same visit, other driver). Every lease has `causeText`, set at mint ("the owner forced this stage: <note>",
  "approved force proposal: <reason>", "advanced from Review (review): its gate passed"). `forced` ends record
  `by: owner | proposal` and the note. stage_status, the tell message and the autopilot's station show both:
  "Why: <causeText>" and "Last visit (ended: forced by the owner: <note>) submitted: ..." (`endText`, `previousText`). Accepted outputs move to
  `run.outputs[stage]` on a passing advance; later stages' inputs read only those.
- `paused` is guard enforcement only; it never stops launching, telling or expiry.

## 4. Transitions (`step`, `mint`, `closeLease`)

`step(run, command, now, ids)` is the only transition function. Commands: agent (tool calls), driver (CLI), owner
(RPC), system (effect results, clock, recovery). S1: a command naming a non-current ticket/grant/work/form returns the
same object (stale/closed reply). S2: only `mint` changes lease identity. S3: `reconcile` is a no-op.

Graft decisions:

1. **Interrupted, not replayed.** `Work.startedIn` is the executor boot id. The executor dispatches `workStarted`
   before spawning and only spawns if its boot owns the work. On plugin start, `recover {boot}` turns work started by
   another boot into `outcome interrupted` (shown, never exit 0); retry is a new job. `reconcile` stays a no-op.
2. **Frozen submissions.** `submit` while `lease.work` is a gate job replies `busy` (S4).
3. **Ordered, fail-closed publication.** `run.rev` bumps on every committed change and never resets (also across
   replacement runs, carried from the previous run). Operations write the policy in the same queue slot right after
   commit, then dispatch `published {rev}` (sets `publishedRev`, no rev bump). `desired` emits a `publish` effect
   while `publishedRev < rev`; tell and launch wait for it; driver/agent mutations reply `publishing` (S5). The host
   refuses to write a rev older than the file's. An agent call whose own policy write fails gets an error without a
   ticket (`Committed.unpublished`); its lease stays untold (`wake none`), so the tell follows the retried publish.
   Only `published {rev, told, replied}` from the same queue slot marks the agent told by its reply (`toldBy`).
   Every agent change also sets `run.pendingTell {rev}` (T1), cleared by that `replied`; otherwise, once published,
   `desired()` emits `tellPending` (the stage as it is now) unless a tell/launch of the run is due, whose woke clears
   it. So a submit, advance or proposal whose own publish failed is messaged too, not only calls that mint a lease.
   The driver CLI (`sandy track drive`, every command but status) replies `{kind: "unpublished", rev, error}` instead of
   the commit's reply then: no ticket, grant or work id. The autopilot client throws on it without repeating the
   committed command (`publishing` alone, a refusal before any change, is retried).
4. **Drives all.** `setDriver track X` sets `plan = {track: X, stages: {}}`; `track default` deletes only `plan.track`;
   `stage default` deletes that stage's row. If the current lease's driver changes, the lease is closed
   (`switched`) and a `switch` lease minted.
5. **Invocation in claim.** `claim {ticket, invocation}`: an unclaimed lease takes it; the same invocation renews;
   another invocation is refused (stale). Duplicate launches never share a holder.
6. **Usage per lease.** See §8. `Lease.usage`/`ClosedLease.usage`, `null` = unknown. A closed lease's usage is final
   only if the driver's own closing call (advance passing at once, release) reported it; otherwise the last checkpoint
   is kept with `usagePartial: true` (forced, switched, expired, aborted, a deferred gate) and the UI says partial.
7. **Injected ticket.** See §8.
8. **Bounded run.** `LOG_LIMIT` 50 closed leases (+`logDropped`), ran-evidence tail `TAIL_CHARS` 2000, text evidence
   `TEXT_EVIDENCE_CHARS`. Operations refuse a driver's, agent's or owner's command whose run, plus what settling the
   current lease copies (`settledBytes`: its submissions and a stage's last visit), exceeds `MAX_RUN_BYTES` (200 kB <
   256 kB). A system settlement is never refused: work whose result still does not fit ends as outcome `unsaved`
   (the stage stays the driver's, who submits shorter values and retries); that covers check and run results and
   the owner's answers to a gate approval or force proposal (`settledWork`: form id = work id). Copies into the run
   have fixed caps: `causeText` 500 (stage titles reach the run only through it), a new lease's `previous`
   (`boundedPrevious`: values 2000, last 20 evidence), autopilot name 48 / args 500, run command 4000 (refused).

Force: owner `force {to}` closes the lease (`forced`) and mints a `force` lease for `to` with `driverFor` (to the
same stage too: a new visit). Agent/driver `proposeForce` stores `Work force-proposal`; `desired` asks the owner;
`answered approved` acts as owner force, rejected sets outcome `force-rejected`, the lease stays.

Expiry (`tick`): an unclaimed autopilot lease past `LAUNCH_GRACE_SEC` is relaunched (new lease, cause relaunch) up
to `MAX_LAUNCH_ATTEMPTS`, then minted to the agent (`expired`); a claimed lease without heartbeat for
`HEARTBEAT_SEC` goes to the agent (`expired`). Every chain ends in an agent lease (D1).

## 5. Effects (`desired`, `effects.ts`)

`desired(run)` derives, from the committed run only, the effects that should be in flight: publish, check, run, ask,
launch, tell, tellOutcome. Keys contain ticket + work/form id (D2), so an effect of a replaced lease is no longer
desired and the executor aborts it. Check/run are desired only while `startedIn` is null (D3). The executor
(`createExecutor`) diffs by key after every commit and at `reconcile`; its map is a cache, never an owner.
Ports: runCheck (host), requestInput, threads.send, writePolicy.

## 6. Operations and server (signatures; slice 2/3 replace v1 in place)

These collide with v1 names, so they are specified here and land when v1 is removed (slice 3):

```ts
// operations.ts
export function createOperations(deps: {
  load(threadId: string): Promise<Run | null>; save(threadId: string, run: Run | null): Promise<void>;
  writePolicy(threadId: string, policy: PolicyFile): Promise<void>; executor: Executor; now(): number;
  newRunId(): string; notify(threadId: string): void;
}): {
  dispatch(threadId: string, command: Command): Promise<Reply>; // per-thread queue: load, step, size check, save,
                                                               // policy write + published, executor.reconcile, notify
  recover(threadIds: string[]): Promise<void>;                 // plugin start: recover {boot} then reconcile
  tick(): Promise<void>;                                       // interval: tick every active thread
};
// contract.ts rpc additions; force/abort/pause stay
setDriver: { threadId: string; scope: "track" | "stage"; stage?: string; choice: Driver | "default" } -> Reply
// contract.ts host: writePolicy gains rev; returns { written: boolean } (false = an equal or newer rev is on disk)
```

Server adapters: `stage_start/status/submit/advance` keep names and add optional `ticket` and `usage` (declared
so sandy's zod does not strip them, probe b); new `stage_propose_force {to, reason, ticket?}`. A tool result whose own
transition minted an agent lease (reply started/entered) ends with the line `⟦track-ticket⟧ <ticket>`, taken from that
reply (operations.commit returns the reply with the run it committed; results never reload). The marker is removed from
the rest of every result, and the guard reads only the terminal line. CLI `sandy track drive`: start (`--autopilot` sets the track
driver), status (`--lease <grant>` renews), claim, submit, run, advance, propose-force, release. Every CLI call is short;
deferred results are read through status.

## 7. Launch (`handleLeaseCommand`)

The plugin is the only launcher. A `launch` effect sends `/autopilot --lease <ticket> <name> <args>` with
`threads.send`. Probe (a): a slash command that starts no agent run leaves the sandy turn waiting until
`provider_turn_start_timeout` (120 s) and the thread active. So `handleLeaseCommand` returns immediately, claims, appends
the lease marker and runs the autopilot detached at once; its first step is the turn sandy waits for (an extra opening
turn would cost one full uncached request, D18). Only if no agent turn started within 90 s does it send one short
opening message with `triggerTurn`; an autopilot that returns before any turn started sends its result with
`triggerTurn`. In `finally` it releases the lease if still held. A lease session waits for a settled session before
every step, so a fallback opening turn has ended first. A stale ticket gets the opening message at once
("stale launch, nothing to do"). The pi station launcher and `runLeading` are deleted in slice 4.
The autopilot's `api.session` is bound to `lease.signal` (`autopilotApi`): once the heartbeat or a call sees the
lease end (force, switch, abort, expiry), `session.step` rejects before prompting, a running turn is aborted in pi
(`ctx.abort()`, then the run settles) and no schema reminder follows; `exec` and `ask` get the signal too.
A step never changes the request prefix (decisions.md D18): it limits tools by blocking calls, not by changing the
active tools, and refuses a model or thinking level other than the session's.

## 8. Ticket and usage in pi (grafts 6, 7)

- track-guard captures the ticket once per agent run (`agent_start`: policy file `ticket` if its driver is agent),
  updates it from stage_start/stage_advance results (`ticket` line), and on `tool_call` of stage_submit,
  stage_advance and stage_propose_force overwrites `input.ticket` (model values never win). Nested codemode calls see
  the same hook (probe b). The server requires a ticket for these tools; a stale one replies stale with the current
  station, so a turn that outlived a force cannot write into the next visit.
- usage: whoever starts acting for a lease appends a custom session entry `track-lease {ticket}` (guard at capture,
  runner after claim). `usageForTicket` sums assistant `usage` after that marker until the next marker. The guard
  injects `usage` with the ticket; LeaseTrack reports it on submit, advance and release. Unknown is `null`.
  The guard imports `pi/autopilot/usage.ts` by relative path (both extensions are symlinks into this repo).

## 9. Module map

| Path | Change |
| --- | --- |
| sandy/track/run.ts (new) | Run, Lease, step, mint, desired, policyFor, stationOf. Pure. |
| sandy/track/effects.ts (new) | Executor over desired effects. |
| sandy/track/machine.ts | Keeps schemas and rule helpers (ruleKey, describeRule, rulesFor, effectiveAllow, pickEdge, clip); v1 Run, Lead, handBack, stationOf, policyFor, evaluateLocal and renderStatus removed (slice 5; run.ts evaluates rules and renders status). |
| sandy/track/operations.ts | Rewritten: one dispatch queue (slice 2/3). |
| sandy/track/server.ts, contract.ts, host.ts | Thin adapters; setDriver; rev-ordered writePolicy; stage_propose_force. |
| sandy/track/app.tsx | Driver pickers, lease log, force-proposal form (slice 5). |
| pi/autopilot/track.ts | TrackClient + LeaseTrack replace Track/createTrack (slice 4). |
| pi/autopilot/autopilot.ts | handleLeaseCommand; no implicit lead. station.ts deleted. |
| pi/autopilot/usage.ts (new) | Lease usage from session entries. |
| pi/track-guard/src | Ticket capture/injection; STAGE_TOOL regex adds propose_force; policy v1 + rev/ticket. |

## 10. Acceptance (tests by slice)

- run.test.ts: S1 (every stale ref, same object), S2/S3, S4 busy, S5 publishing, graft 4 table cases, graft 5 two
  invocations, expiry chains end at agent, re-entry vs carry submissions, force same stage = new visit, proposal
  approve/reject/late answer inert, rev never resets across abort + new start, log/tail caps.
- effects.test.ts: abort on key loss, workStarted before spawn, interrupted after restart, publish retry.
- operations.test.ts: size refusal, policy written after commit, restart recovery.
- pi: usage marker sums; guard injection overwrite (top-level + nested); handleLeaseCommand runs without an opening turn,
  one fallback opening after 90 s without a turn, stale ticket, release in finally.

## 11. Deviations from the merged sketch and open questions

- v2 core lives in new `run.ts` (not `machine.ts`) so v1 keeps compiling until slice 3 removes it.
- Launch: the autopilot's first step starts the sandy turn; a triggerTurn opening message only as a 90 s fallback or for a
  stale launch, instead of the sketch's closing turn (probe a, D16).
- Thread usage totals are not stored (synthesis: "cross-check only"); per-lease usage only.
- Ticket update after stage_start/advance comes from a `ticket` line in the tool result text (sandy tool `details` passing
  through the bridge is unproven).
- Policy file stays `version: 1` with added `rev` and `ticket` fields (optional-fields rule); `enteredAt` dropped.
- Decided (owner): outputs on re-entering a stage. A new visit starts empty with the previous visit shown, including
  how it ended and why the new visit started; same-visit driver changes carry submissions.
- Slice 4: `createTrackClient` returns null outside a sandy thread (no SANDY_THREAD_ID), as v1's createTrack did, so
  `api.track` is null there; `openLease` takes `{usage}` (the lease's measured usage, sent with submit, advance and
  release); `handleLeaseCommand(input, deps)` takes its pi, client, session branch and runner as deps (testable without
  a pi session) instead of `(input, pi, ctx)`. pi/autopilot's `commandContextOf` went with the station launcher (only
  the launcher ran autopilots from an event ctx).
- Slice 4: track-guard imports `pi/autopilot/usage.ts` by relative path (see docs/decisions.md).
- Slice 3/5: the v1 Run code in machine.ts stayed until slice 5, because app.tsx still rendered the v1 Run; slice 5
  rewrote app.tsx against run.ts and removed it.
- Slice 5: the app keeps a **Take over** button on autopilot stages; it is `setDriver {scope: stage, choice: agent}` for
  the current stage (owner decision "Take over = set current stage to Agent"), not a separate rpc.
- Risk: single live plugin writer is assumed (sandy.storage has no CAS); host rev check bounds stale policy writes only.
