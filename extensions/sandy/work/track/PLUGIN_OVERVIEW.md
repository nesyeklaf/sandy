Gate your agent's main session by stages: each stage names its inputs, the outputs it must produce, a gate that has
to pass and the branches that follow.

## What you get

- A **Stages** tab on every thread with a track: the stages, the current one, its inputs and outputs, gate status and
  the branches ahead.
- A stage pill in the thread header.
- Approval forms in the composer for gates that need you, for tracks the agent proposes and for stage switches an
  agent or autopilot proposes when it is blocked.
- Pick who drives each stage, or the whole track: the agent or a named pi autopilot (templates only set defaults).
- Pause the guard, force a stage or abort from the tab; a lease log shows who drove each visit, why it ended, the
  tokens it used and the commands the plugin ran for it.

## How it works

Skills ship a `stages.json` template, or the agent proposes a track for your approval. The plugin checks each gate
(outputs, commands, evidence, your approval) and writes the current stage's allow list to a policy file on the
thread's host. The pi `track-guard` extension reads it and blocks skills, edits and subagent routing the stage does
not allow.
