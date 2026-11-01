# sandy-plugin-track

Tracks for the main agent session. A track is a state machine of stages; each stage has inputs, outputs, a
gate with rules and branches. The agent moves through it with the `stage_*` tools, the owner watches and steers it in
the thread's **Stages** tab, and the pi extension [`pi/track-guard`](../../pi/track-guard) blocks tool calls the
current stage does not allow. A stage may name a pi autopilot ([`pi/autopilot`](../../pi/autopilot)) that drives it
instead of the agent, through `sandy work track drive`; an autopilot may also start and drive a whole track.

## Pieces

- `machine.ts` — the track schema (zod) and the pure rule helpers.
- `run.ts` — the run state machine (design: [docs/design-v2.md](docs/design-v2.md)): one lease drives the
  current stage visit; `step` is the only transition, `desired` derives the effects a run needs (publish the
  policy, run checks, ask the owner, launch or tell the driver). Pure: no sandy API, no clock reads.
- `operations.ts` — one queue per thread: load, step, size check, save, policy write, then the effects.
- `effects.ts` — the level-triggered executor of `desired` effects; work a restarted plugin had started is
  reported as interrupted, never run again.
- `server.ts` — wires operations to sandy: the agent tools (`stage_start`, `stage_status`, `stage_submit`,
  `stage_advance`, `stage_propose_force`), per-thread run state in `sandy.storage.kv`, owner RPC (driver choice,
  pause guard, force, abort) and the `sandy work track` CLI with the autopilot's lease commands.
- `host.ts` — runs on the thread's host: writes the guard's policy file (never over a newer `rev`) and runs
  `check` and `run` commands in the workspace.
- `app.tsx` — the Stages tab (driver pickers, force, pause, abort, lease log), a stage pill in the thread header,
  and the composer forms for gate approval, track approval and force proposals.
- `POLICY.md` — the policy file contract between this plugin and the guard.
- `docs/decisions.md` — why it is built this way; `skills/track/SKILL.md` tells agents how to use the tools;
  `templates/` holds example `stages.json` files.
- Tests: `node --test --test-timeout=20000 --experimental-strip-types *.test.ts`, `npx tsc --noEmit -p .`.

## Where tracks come from

- A skill ships `stages.json` next to its `SKILL.md`; the agent calls `stage_start({skill})`.
- The agent proposes an ad-hoc track with `stage_start({machine})`; it starts only after the owner approves it.
- An autopilot starts one with `sandy work track drive start`.

## Drivers and leases

Each stage visit is driven by one driver at a time: the agent or a named pi autopilot. Who drives a stage is run state:
the owner's choice for that stage, else the owner's choice for the whole track, else the template's
`"autopilot": {"name", "args"?}`, else the agent. Templates are only defaults. In the Stages tab each stage row has a
driver picker (Template default, Agent, an autopilot by name) and **Whole track** picks one driver for every stage
(it clears the stage choices). **Take over** sets the current stage to Agent. A whole-track autopilot is the same
autopilot launched once per stage visit; there is no lead.

Every ownership change mints a new **lease** with the next sequence number: start, a passed gate, a force, a driver
switch, a release, an expiry. Its ticket is `<runId>.<seq>`; every driver call names it, and a call for any other
lease is answered `stale` and changes nothing. That is the whole fence against late calls.

- **Agent**: the plugin tells the agent in a message (with the ticket). The pi track-guard captures the ticket and
  writes it into every `stage_submit`, `stage_advance` and `stage_propose_force` call; the model never types it.
- **Autopilot**: the plugin sends `/autopilot --lease <ticket> <name> <args>` into the thread. The autopilot claims the
  lease (`claim` with a per-launch invocation id; the grant is `<ticket>.<invocation>`), renews it while it runs and
  releases it to the agent when it returns without advancing. A launch not claimed within 120 s is retried once, then
  the stage goes to the agent; a claim not renewed for 90 s goes to the agent too.
- **Re-entry**: a visit entered by start, advance or force starts with empty submissions; the stage's last visit (what it
  submitted and how it ended) is shown to the driver as read-only context, with why the new visit started. A driver
  switch within a visit keeps the submissions.
- **Force**: the owner jumps to any stage without its gate (to the current stage too: a new visit). The agent or an
  autopilot may propose a force with a reason; the owner approves or rejects it in the composer.
- **Evidence**: `sandy work track drive run` runs a command on the host and records `ran` evidence (command, exit code, the output's
  tail), written only by the plugin. A gate rule `{"type": "evidence", "name": "tests", "ran": true}` passes only on such a record
  with exit 0 from this visit.
- **Usage**: each lease records the model tokens pi measured for it (session entries after its `track-lease` marker);
  the lease log shows them, `tokens unknown` when pi could not measure.

The autopilot's CLI (thread: the calling thread; `--thread` for debugging), JSON on stdout:

    sandy work track drive start --skill <name> | --machine <json> [--note <text>] [--autopilot <name> [--args <text>]]
    sandy work track drive status [--lease <ticket|grant>]           the station; with the grant it renews the claim
    sandy work track drive claim --ticket <ticket> --invocation <id>  takes the launched lease; replies the grant
    sandy work track drive submit --grant <grant> [--outputs <json>] [--evidence <json>] [--usage <json>]
    sandy work track drive run --grant <grant> --label <name> --command <text> [--timeout <sec>]
    sandy work track drive advance --grant <grant> [--to <id>] [--note <text>] [--usage <json>]
    sandy work track drive propose-force --grant <grant> --to <id> --reason <text>
    sandy work track drive release --grant <grant> --reason <text> [--usage <json>]

Every call is short. Deferred work (gate checks, owner approval, `run`, a force proposal) answers `pending`; its outcome is
read through `status --lease <grant>`. A mutation the guard's policy file does not show yet answers `publishing` (retry).
The pi client `pi/autopilot/track.ts` (`api.lease`) wraps all of this: `submit`, `run`, `advance`, `proposeForce`, `release`.

`--machine` takes the ad-hoc track's JSON itself, not a path (the plugin's server may not see the driver's files). A
plugin call carries at most 64 KiB, so the pi client refuses a machine above 60 KiB of JSON with a clear error.

## Gate rules, by trust

`user` (owner approves) > `check` (a command exits 0) > `outputs` (all submitted) > `evidence` (the driver attests;
`ran: true` evidence is a command the plugin ran itself, so it ranks with `check`).

## Install

```
npm install && sandy plugin build . && sandy plugin install "$PWD"
../../scripts/install-pi.sh   # links pi/track-guard and pi/autopilot into ~/.pi/agent (same checkout: decisions.md)
```

Pi loads the guard on the next session start or reload. Without it nothing is enforced, and the agent cannot drive a
stage: its `stage_submit`/`stage_advance` calls carry no ticket and are refused. Autopilot stages still run.
