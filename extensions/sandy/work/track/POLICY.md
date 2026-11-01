# Policy file contract (track plugin -> pi track-guard)

The plugin's host entry writes one JSON file per SANDY thread on the host the thread runs on:

    ${TRACK_STATE_DIR:-~/.local/state/sandy-track}/threads/<threadId>.json

It is rewritten atomically (a unique tmp file + rename; compare and write are serialized per thread on the host) after every committed change of the thread's run, in the same queue
slot as the commit: start, a new lease (advance, force, driver switch, release, expiry), owner pause/resume, abort,
finish. Every file carries the run's `rev`; the host never replaces a file with an older `rev` (rev never resets, also
across replacement runs). The plugin tells or launches a lease's driver only after its policy is written, and refuses
driver calls with `publishing` until then. The pi guard (pi/track-guard) reads it on each tool call; the thread id comes
from `process.env.SANDY_THREAD_ID`.

```ts
type PolicyFile = {
  version: 1;
  threadId: string;
  active: boolean;          // false: no run, run finished/aborted, or the owner paused the guard -> allow everything
  running: boolean;         // the run is live (not finished or aborted), also while the owner paused the guard.
                            // `active` is the guard's switch; `running` says whether there is a lease at all.
  runId: string;            // the run (unique per run); "" without a run
  rev: number;              // the run's revision when this file was written; only grows
  ticket: string;           // the current lease "<runId>.<seq>"; "" when no lease is live
  machine: string;          // machine id, e.g. "full-control"
  stage: string;            // current stage id ("" when no lease is live)
  stageTitle: string;
  next: string[];           // stage ids reachable from here (for block messages)
  allow: {
    skills?: string[];      // skill names whose SKILL.md may be read; absent = any skill
    edits?: boolean;        // false = block edit/write tools (except under SANDY_THREAD_STORAGE and /tmp); absent/true = allowed
    subagents?: { agent?: string; model?: string }[]; // launch patterns for subagent, sandy_delegate, sandy_workflow_*; "*" glob; absent = any; [] = no launches
    denyTools?: string[];   // tool names blocked in this stage (matched exactly or as the suffix after "__")
  };
  driver: { kind: "agent" } | { kind: "autopilot"; name: string; args?: string };
                            // who holds the current lease; { kind: "agent" } when no lease is live
  goalId: string | null;    // the pi goal the run serves (stage_start goalId); null without one
  waiting: "owner" | "track" | null;
                            // the lease's open work: "owner" = gate approval or force proposal in the composer,
                            // "track" = gate checks or a requested run; null = nothing pending, the driver works
};
```

Changes within version 1 (v2 drivers): `rev` and `ticket` were added; `enteredAt` and `updatedAt` are no longer
written (a visit is named by its ticket, not a time); an autopilot driver always has a name (there is no lead).
The guard reads `running`, `driver` and `ticket` as optional, so a file an older plugin wrote still parses.
`goalId` and `waiting` were added for the goal link and are optional for readers too. pi/work's goal reads them: while
`waiting` is set it queues no auto-continuation (the plugin messages the agent when the work ends), and a focused goal's
request context names the current stage.

The guard uses `ticket` when an agent turn starts: if the file is `running` and its driver is the agent, that ticket is the
agent's lease (also while the guard is paused). It also takes the ticket from the terminal line `⟦track-ticket⟧ <ticket>` the plugin
appends to a `stage_start` or `stage_advance` result whose own transition gave the agent a new lease (the ticket comes
from that transition's reply, never from a later reload). The plugin removes the marker `⟦track-ticket⟧` from the rest
of every tool result, so echoed outputs and inputs cannot plant a ticket; the guard reads only the last line, and writes it into every `stage_submit`, `stage_advance` and
`stage_propose_force` call (top level and nested in codemode), overwriting what the model typed; `stage_submit` and
`stage_advance` also get the lease's measured `usage`. An autopilot's lease or no live lease leaves the agent without a ticket. When a lease has ended (the newest `track-lease` marker of the session is no longer the file's ticket) the guard reports its measured usage once, late, with `sandy work track usage` (read-only, D19). pi/autopilot reads the file only for
its `session.step` loadout check (the plugin, not pi, launches autopilots): `allow.skills` / `allow.denyTools` (the tools the turn
gets: the step's list, else the inherited active tools). `autopilot_submit`, the tool a step with a schema answers
through, is always allowed: `denyTools` cannot name it, and the guard never blocks it.

Guard semantics (pi `tool_call` handler):

- No file, or `active: false`: allow.
- File present but unreadable or invalid JSON: fail closed for the guarded categories below, allow the rest.
- Always allow the plugin's own tools (name matches `/(^|__)stage_(start|status|submit|advance|propose_force)$/`), pi/autopilot's
  `autopilot_submit` (name matches `/(^|__)autopilot_submit$/`; it only hands a step's value back) and bash commands
  that start with `sandy work track`.
- `denyTools`: block a tool whose name equals an entry or ends with `__<entry>`.
- `skills`: a `read` call (name `read` or `*__read`) whose path matches `/skills/<name>/SKILL.md` is blocked when
  `<name>` is not listed. A `bash` command that contains `skills/<name>/SKILL.md` for an unlisted name is blocked too.
- `edits: false`: block `edit` and `write` unless the target path is under `$SANDY_THREAD_STORAGE` or `/tmp`.
- While active, always block `edit`/`write` of a file named `stages.json` inside a `skills/` directory and of
  anything under the state dir (templates and policy cannot be weakened from inside the run).
- `subagents`: for tool `sandy_delegate` (name `sandy_delegate` or `*__sandy_delegate`) the launch is its params `{agent, model}`; a missing `model`
  is a launch without model, as for `subagent`. For `sandy_workflow_plus_run` and `sandy_workflow_run` the agents live inside a
  script and cannot be matched: the call is one launch `(workflow)`, blocked whenever `subagents` is present (like a
  `subagent` call with `workflow`). `sandy_delegate_send`/`_wait`/`_status`/`_stop` only manage runs and are allowed.
  The blocked message names the tool, e.g. `launching sandy_delegate scout`. For tool `subagent`, collect launches from the params: top level `{agent, model}`, each `tasks[]`
  item, each `chain[]` item (and nested `parallel`/`tasks` arrays inside a chain step). Params without any
  `agent` (management actions such as status/list) are allowed. Each launch must match one pattern: a pattern
  field that is absent matches anything; a pattern `model` set while the launch has no `model` does not match.
- A block returns `{ block: true, reason }`; the reason names the stage, what is allowed, and says to call
  `stage_status` / `stage_advance` or ask the owner to pause the guard in the Stages tab.
