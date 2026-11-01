---
name: track
description: Work through a track in the main session with the stage_* tools. Use when a skill ships a stages.json, when the owner asks for a track, or when a track guard blocked a tool call.
---

# Stage gate

A track is a list of stages. Each stage has inputs (earlier outputs), outputs you submit, a gate with rules and
`next` edges (branches). While a track is active, the pi track-guard blocks tool calls the current stage does not
allow: skills it does not list, file edits when `edits: false`, subagent launches that match no allowed
agent/model pattern, and tools in `denyTools`. The owner sees the track in the thread's **Stages** tab and can pick
who drives each stage, pause the guard, force a stage or abort.

## Tools

- `stage_start({skill})` loads `<skill>/stages.json`. Call it before you follow a skill that ships one.
- `stage_start({machine, note})` proposes an ad-hoc track. The owner approves or rejects it in the composer. Propose
  one only when the owner asked for a track or a skill tells you to.
- `stage_status()` shows the current stage, who drives it and why, its inputs, outputs, gate, what is allowed, the
  branches, and what the stage's last visit submitted.
- `stage_submit({outputs, evidence})` records values for the current stage.
- `stage_advance({to, note})` checks the gate and moves on. Pass `to` when the stage branches, and say why in
  `note`. Omit `to` on the final stage to finish. Checks and owner approval may take a while: the outcome arrives as a
  later message; end your turn and wait for it.
- `stage_propose_force({to, reason})` asks the owner to switch to another stage without the gate, when something
  you cannot fix blocks it. Explain the blocker. The owner's answer arrives as a message.

You never pass a ticket. The pi track-guard adds the ticket of the stage visit you were told about to every call. If a
call answers that your ticket is not current, the owner forced, switched or aborted meanwhile: read the message or
call `stage_status()` and continue from there.

## A new visit of a stage

When a stage is entered again (a gate branch back, or a force), it starts empty: what you submitted last time does
not count for its gate. `stage_status` and the message that hands you the stage show why the visit started and what the
last visit submitted and how it ended. Use that as context (learn from it, reuse what still holds) and submit again.

## Gate rules

| rule | passes when |
|---|---|
| `outputs` | every non-optional output of the stage is submitted |
| `check` | `command` exits 0 in the thread's workspace (`timeoutSec`, default 120) |
| `evidence` | you submitted `evidence.<name>`: what you ran or observed, with the result |
| `evidence` with `"ran": true` | the plugin itself ran a command recorded under that name in this visit (`sandy work track drive run`, an autopilot's) and it exited 0 |
| `goal` | the goal focused when the track started has an approved auditor verdict (complete it with `update_goal` so the auditor runs); `"optional": true` passes when the track serves no goal |
| `user` | the owner approves in the composer; checked last, after the other rules pass |

Edges can carry their own `gate`, checked only for that branch.

## Stages an autopilot drives

A stage may be driven by a pi autopilot instead of you: the template names one (`"autopilot": {"name": "..."}`), or the
owner picks one for the stage or the whole track in the Stages tab. The plugin launches it; when `stage_advance` enters
such a stage, end your turn. While it drives, you hold no ticket and your `stage_submit` and `stage_advance` are
refused. Do not drive it yourself with `sandy work track drive`; that CLI is the autopilot's. When the autopilot returns, fails
or the owner takes over, the plugin tells you that you drive again.

## When the guard blocks you

The block reason names the stage and what it allows. Do not work around it (another tool, bash, a different path).
Either finish the stage and advance, or tell the owner why the block is wrong and let them decide.

## stages.json

```json
{
  "id": "my-track", "title": "My track", "start": "plan",
  "allow": { "edits": false },
  "stages": [
    { "id": "plan", "title": "Plan", "outputs": [{ "name": "plan" }],
      "allow": { "skills": ["architect"], "edits": false, "subagents": [{ "agent": "scout", "model": "anthropic/*" }] },
      "gate": [{ "type": "outputs" }, { "type": "user", "prompt": "Plan ok?" }],
      "next": [{ "to": "build" }] },
    { "id": "build", "title": "Build", "inputs": ["plan.plan"], "allow": { "edits": true },
      "autopilot": { "name": "build-loop" },
      "gate": [{ "type": "check", "command": "npm test" }] }
  ]
}
```

Ids are lowercase (`a-z0-9_-`). A stage's `allow` overrides the track's `allow` per key; a key the stage leaves out inherits the track's, and a key neither sets is unrestricted. Validate a file with
`sandy work track validate <path>`.
