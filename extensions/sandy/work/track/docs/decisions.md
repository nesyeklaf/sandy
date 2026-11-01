# Track + Autopilot: decisions

Why the track plugin, its guard and the autopilot driver are built the way they are. D1-D8 come from the owner's
draft (D5-D7 rewritten for drivers v2); D9 on are builder defaults of drivers v2 (design: [design-v2.md](design-v2.md)).
Each can be undone; revisit when the trigger named in it happens, or when a probe or the owner contradicts it.

## Intent (owner's words)

- "eine stage hat einen (oder mehrere) input, einen (oder mehrere) output und einen gate mit regeln. ist die regel
  erfüllt, darf der agent in die nächste stage."
- "Wie hart soll gegated werden? B: hart mit pi Guard"
- "Skills können eine eigene File mit Stages als Vorlage vordefinieren - agents können ... aber auch selber den flow
  bauen (mit user approval)."
- "Track ist die Maschine, Autopilot ist ihr Fahrer." Pro Station mischen: "Jetzt". Übernehmen im Stages-Tab: "jaaaaa".
- Merge: "die arbeit muss 100% bewiesen und nachvollziehbar sein"
- Lead: "Ein Autopilot kann entweder den ganzen Track oder nur Stages steuern - hängt vom Usecase ab. Man kann
  jedenfalls beides per UI dann forcen oder wieder disablen. Vorlagen sind nur das: Vorlagen."
- Force: "Per force wechselt man manuell halt zu einer anderen stage. das soll aber auch vom agent selbst als
  vorschlag/frage möglich sein, falls es einen unentblockbaren blocker gibt"
- Autopilot benefit: "es gibt mir sicherheit. es gibt beweise. und es spart tokens."
- Re-entry outputs: "sie sollten gelesen und als context verwendet werden - z.B. um daraus zu lernen und es diesmal
  richtig zu machen - wenn es ein force war, dann sollte der agent wissen, dass es einen force gab und das die
  vorherigen ergebnisse waren"

## D1 Gate rule types ranked by trust

- Context: a gate needs rules the agent cannot fake.
- Decision: user (owner approval) > check (command exits 0) > outputs (all submitted) > evidence (self-attested,
  flagged in the UI). Evidence with `ran: true` is satisfied only by a command the plugin ran itself (D13).
- Rejected: one rule type only; free-form predicates.
- Consequences: outputs and plain evidence gates prove nothing about quality.
- Revisit when: a template needs a rule none of the four express.

## D2 The guard reads a policy file

- Context: the pi guard runs in the pi process, the track in the sandy plugin.
- Decision: the plugin's host entry writes `~/.local/state/sandy-track/threads/<thread>.json` atomically; the guard reads it
  ([POLICY.md](../POLICY.md)).
- Rejected: an HTTP call per tool call; a CLI call per tool call.
- Consequences: plugin and pi extension must agree on the format (D12). Missing file = allow all.
- Revisit when: the guard must run on a host without that file.

## D3 Stage allow inherits per key from the track

- Decision: a key a stage leaves out comes from the track's allow.
- Rejected: stage allow replaces track allow entirely (allowed every subagent in design).
- Revisit when: a template needs "nothing" for a key and the track says "any".

## D4 Deferred gate results arrive later

- Decision: `stage_advance` returns at once when the gate needs checks or the owner; the outcome arrives as a later message
  (agent) or through `status --lease` (autopilot).
- Consequences: the agent must end its turn and wait.

## D5 One lease per stage visit (v2; replaces "one lead per stage visit")

- Context: v1 spread "who drives this visit" over lead, handedBack, enteredAt and in-memory maps in plugin and pi; four
  review rounds found races at force, restart, equal timestamps and script exit.
- Decision: the driver of each stage is run state (owner stage choice > owner whole-track choice > template default >
  agent). Every ownership change (start, advance, force, driver switch, release, expiry) mints a lease with the next
  sequence number; everything a lease owns (claim, wake, deferred work, outcome, submissions) lives inside it. There
  is no lead: a whole-track autopilot is the same autopilot launched once per stage visit. Take over = set the
  current stage to Agent.
- Rejected: a lead autopilot that follows the track; both drivers may write and the last write wins.
- Consequences: one transition function (`run.ts step`); the plugin is the only launcher of autopilots.
- Revisit when: an autopilot needs to drive several stages in one process.

## D6 The ticket fences late calls (v2; replaces "visit id fences late results")

- Context: three review rounds found results that arrived late and were applied to the track as it is now.
- Decision: every driver call names its lease: ticket `<runId>.<seq>` (agent, injected by the guard) or grant
  `<ticket>.<invocation>` (autopilot, per launch). A call for any other lease is answered stale and changes nothing.
  Deferred work is keyed by ticket and work id; work of a replaced lease is no longer desired and its result is inert.
- Rejected: visit ids from time (`enteredAt`); a fallback for the v1 `--visit` format.
- Consequences: plugin, guard and autopilot must be installed together; a v1 run is not continued (its policy is
  cleared in the thread's queue, retried every tick until the host has it, and skipped once a v2 run exists there).
  v2 formats before the first install are not migrated (e.g. snapshots without pendingTell).
- Revisit when: an upgrade with a running track hurts in practice.

## D7 Force and force proposals (v2)

- Decision: the owner's Force jumps to any stage without its gate, the current one too (a new visit); the new lease's
  driver is `driverFor` of the target. The agent or an autopilot may propose a force with a reason; the owner approves
  (acts as an owner force) or rejects (the lease stays, the driver is told) in the composer.
- Re-entry (owner decision): a visit started by start, advance or force begins with empty submissions; the stage's last
  visit is given to the new driver as read-only context with how it ended and why the new visit started
  ("Last visit (ended: forced by the owner) submitted: ..."), in stage_status, the tell message and the autopilot's
  station. A driver change within a visit keeps the submissions.
- Rejected: force makes the agent the lead (v1); old submissions satisfy the new gate.
- Revisit when: a template wants a stage that keeps its outputs on re-entry.

## D8 Owner RPCs are not discoverable

- Decision: setDriver/force/setPaused/abort stay out of `sandy plugin rpc inspect`; `call` still reaches them.
- Revisit when: owner actions need a CLI for people.

## D9 Single writer per thread

- Context: `sandy.storage.kv` has no compare-and-set. The run of a thread is one key.
- Decision: one live plugin process writes a thread's run, through one in-process queue per thread (load, step, save,
  policy write). This is an assumption, not enforced.
- Rejected: optimistic retries without CAS (cannot detect a lost update); a lock key (no atomic acquire either).
- Consequences: two plugin processes serving the same thread at once (an overlapping replacement) could lose an update.
  The host's `rev` check bounds only stale policy writes, not stale run writes.
- Revisit when: sandy storage gets CAS, or plugin replacement can overlap two live instances.

## D10 Publish the policy before waking a driver

- Context: a driver woken before the guard's file names its lease would act under the previous stage's allow list.
- Decision: `run.rev` grows on every commit and never resets (also across replacement runs). Operations write the policy
  right after the commit; tell and launch wait until `publishedRev` reaches `rev`; driver mutations answer `publishing`
  until then. The host refuses to write an older rev.
- Rejected: write the policy as a fire-and-forget effect; a timestamp order.
- Consequences: a host that cannot write the policy stalls the run visibly (the Stages tab shows the error) instead of
  running unguarded.
- Revisit when: the guard reads the policy from somewhere with its own ordering.

## D11 Interrupted, never replayed

- Context: a plugin restart in the middle of a check or command used to leave it unknown or re-run it.
- Decision: the executor records `workStarted` with its boot id before it spawns; on start, work another boot started is
  set to `interrupted` and shown to the driver. A retry is a new job the driver asks for.
- Rejected: replaying the command (side effects twice); treating it as passed.
- Consequences: a restart costs the driver one more advance or run.
- Revisit when: checks become idempotent by contract.

## D12 Policy file stays version 1, additive

- Decision: v2 adds `rev` and `ticket` and stops writing `enteredAt`/`updatedAt`; `version` stays 1.
- Rejected: version 2 (an older guard would fail closed on every file).
- Consequences: an older guard still enforces allow lists; it cannot inject tickets, so the agent cannot drive.
- Revisit when: a field changes meaning instead of being added.

## D13 Ran evidence is written only by the plugin

- Context: "die arbeit muss 100% bewiesen und nachvollziehbar sein"; self-reported evidence proves nothing.
- Decision: `sandy track drive run` runs a command on the host and records `ran` evidence (command, exit code, duration,
  the last 2000 characters of output). A gate rule `evidence` with `ran: true` needs such a record with exit 0 in this
  visit. Text evidence is clipped and flagged "self-reported" in the UI.
- Rejected: trusting an autopilot's report of what it ran.
- Revisit when: evidence must come from somewhere other than the thread's host.

## D14 Tokens per lease from pi's session

- Decision: whoever starts acting for a lease (the guard when it captures a ticket, the autopilot after its claim)
  appends a `track-lease` session entry; the lease's usage is the sum of pi's persisted assistant and tool-result usage
  after it. The guard sends it with stage_submit/advance; the autopilot with submit, advance and release. Unknown is
  `null`, shown as "tokens unknown", never 0.
- Rejected: thread-wide totals (do not attribute to a driver); estimating from text length.
- Consequences: a session that does not persist usage reports unknown. A lease closed by anything but its driver's
  own reporting call (owner force, switch, expiry, abort, a gate settled after the advance call) keeps the last
  checkpoint marked `usagePartial`, shown as "at least N tokens (partial)": no final report reaches a closed lease.
- Rejected: a fenced final-usage report after close (a closed lease accepts no driver call; it would need a
  post-close write path for one number).
- Revisit when: sandy reports usage per turn itself.

## D15 The guard imports pi/autopilot/usage.ts by relative path

- Context: the guard and the autopilot must count lease usage the same way.
- Decision: `pi/track-guard/src/extension.ts` imports `../../autopilot/usage.ts`. The track-guard tests load the extension, so they
  cover the import.
- Rejected: a copy of the code (drifts); a shared package (no workspace in this repo).
- Consequences: track-guard and pi/autopilot must be installed from the same checkout; `scripts/install-pi.sh` links both.
- Revisit when: the guard is installed without pi/autopilot.

## D16 Launch starts the sandy turn with the first step; the ticket travels as a result line

- Context: probes (a) and (b) ([probes-v2.md](probes-v2.md)): a slash command that starts no agent run leaves the sandy turn
  waiting; sandy's tool schema strips undeclared input keys; passthrough of tool `details` through the bridge is unproven.
- Decision: the plugin sends `/autopilot --lease <ticket> <name> <args>` with `threads.send`; the command claims and runs
  the autopilot detached at once, and releases the lease in `finally` if still held. The autopilot's first step is the
  agent run sandy waits for; only when no run started within 90 s (a verify that runs its command first often needs more than 20 s; sandy gives up at 120 s) does the command send one short opening message with
  `triggerTurn` (an autopilot that returns first sends its result that way), and every step of a lease session waits
  for a settled session. An unconditional opening turn was dropped: it cost one full uncached request per launch (D18). The stage tools declare `ticket` and `usage` as optional parameters; a new ticket reaches the guard as the
  terminal line `⟦track-ticket⟧ <ticket>` of the tool result text, taken from the reply of the transition that minted
  it; the plugin removes the marker from the rest of the result, the guard reads only the last line.
- Rejected: pi-side launch from the station file (v1); ticket in tool result details.
- Revisit when: sandy passes tool result details to pi, or a slash command may end a sandy turn without an agent run.

## D17 Bounded run state

- Decision: the lease log keeps 50 closed leases (older ones counted in `logDropped`), ran tails 2000 characters, text
  evidence 4000; operations refuse a driver's or owner's command whose run, with the space settling the current lease
  needs reserved, would serialize above 200 kB (kv limit 256 kB). Settlements are never refused: a result that does
  not fit ends the work as outcome `unsaved`, which the driver hears and can retry shorter; this includes owner
  answers to gate approvals and force proposals. Everything a transition copies from the machine, a driver or the
  owner has a fixed cap (cause text, previous-visit values, autopilot args, run commands), so a copy cannot outgrow
  the reservation.
- Rejected: unbounded history (a long run would stop saving).
- Revisit when: the owner needs the full history of a long track.

## D18 An autopilot step never changes the request prefix

- Context: live E2E #4 measured 150-350k uncached input tokens per autopilot lease for about 120 output tokens: each
  step set the active tools (pi rebuilds system prompt and tool list), the thinking level and maybe the model, added
  autopilot_submit for the step only, and restored all of it afterwards; every change and restore missed the prompt cache.
- Decision: system prompt, active tools and their order, thinking level and model stay byte-identical before, during
  and after a step (pi/autopilot/session.ts). autopilot_submit is active in every session; the tool_call hook refuses it
  outside a step that asks for a value. A step's tool limit is enforced by blocking calls in the tool_call hook (nested
  ones too) and named in its prompt. A step that asks for another model or thinking level is refused; they are chosen
  when the autopilot's session is launched. An accepted autopilot_submit ends the turn (`terminate: true`), so no model
  reply follows it.
- Rejected: switching loadouts per step (cache misses on every switch and restore).
- Consequences: an autopilot that needs another model or thinking level runs in a session launched with it (ship.ts
  documents this); the model sees tools it may not call in a step and is told which ones it may; pi-fabric's
  step-loadout event is no longer emitted, so fabric keeps owning the tools as in any session.
- Revisit when: pi can switch tools, thinking or model without invalidating the cached prefix.

## D19 The track guard meters every lease late and read-only

- Context: live E2E #10 found three lease usages that were wrong or missing because usage only travelled with a lease-closing call: (1) the closing reply after `stage_advance` came after the tool result, so a run counted 2 of 3 model messages and `usagePartial` was true; (2) an owner-aborted lease with no submit had usage `null` and `usagePartial` false although the session had model calls; (3) an autopilot lease whose advance returned "pending" ran `pass()` without the final usage, so `usagePartial` was true.
- Decision: the track guard meters every `track-lease` marker in its pi session, agent and autopilot runner markers alike. When a turn ends or starts it reports every marked ticket that is no longer the policy file's current ticket (other ticket, not running, no file) and not yet reported, once each, with `sandy track usage --ticket <t> --usage <json>` (`usageForTicket` sums all segments of a ticket). A ticket is reported once an end marker (`track-lease` with `ticket: null`) follows its segment or a `track-lease-metered` record `{ticket}` names it, so the state comes from the session entries and survives a restart. The end marker is appended only when the newest marker is the ended lease (`latestMarker` is then null and later work belongs to no lease); an older ended ticket behind a newer marker gets the metered record and the newer lease's attribution is untouched. The meter command (`by: "meter"`, run.ts `meterStep`) sets the current lease's checkpoint or completes the closed row of the same run (also rows of done or aborted runs, and a row a gate left partial); a report that lowers any cumulative counter (input, output, cacheRead, cacheWrite, total, messages) of the recorded usage (an older measurement; equal messages do not order reports because tool results add tokens without messages), for another run or for an unknown lease is ignored (replied stale). A report that would push the run's settled size past `MAX_RUN_BYTES` is ignored as well (replied refused, run unchanged), so late reports never use up the room that settling and owner commands (abort) need. The guard sends only tickets of the policy's current run or the newest marker's run, one CLI call at a time; ended tickets of older runs in a long session history are recorded as handled without a call (the plugin keeps only one run and would refuse them).
- S6: a meter command never bumps `rev` and never rewrites the policy file; operations.ts saves and notifies only, so no agent is re-woken and the guard does not see its own report as a policy change.
- Rejected: usage only on the lease-closing call (it misses everything after the call and every lease that ends without one); having the plugin count tokens (it has no session).
- Consequences: a lease's usage can complete after it closed; `usagePartial` remains true until the report arrives or forever if no guard runs. A failed report is dropped (no retry), the lease keeps its checkpoint usage.
- Revisit when: a report must be reliable (add an outbox) or the plugin gets the token counts from pi itself.
