# /autopilot resume

## Problem

`/autopilot plan-run <task>` keeps its whole state in the memory of one call: the plan, the check, the step it is on and
the task list it writes. When pi reloads (`/reload`, `ctx.reload()`) or restarts in the middle of a run, that memory is
gone. The session keeps only the `work-tasks` snapshots, with one step left `in_progress`, and nothing can continue
from there. `/autopilot resume` continues the newest unfinished plan-run of the session where it stopped.

A reloaded pi is a new extension instance. It sees the old run only through the session
(`ctx.sessionManager.getBranch()`), and autopilot modules are imported fresh on every call (`runAutopilot` appends
`?t=Date.now()`), so module-level state does not survive from one `/autopilot` call to the next either.

## What happens to a running step on reload (from pi's sources)

- `AgentSession.reload()` emits `session_shutdown` (reason `reload`) to the old extension runner, calls
  `oldRunner.invalidate()` and builds a new runner with freshly loaded extensions. From then on every action on the old
  `pi` and the old command `ctx` throws "This extension ctx is stale ..." (`assertActive` in the runner and in
  `createExtensionRuntime`).
- Agent events (`agent_start`, `agent_end`, ...) are emitted to `this._extensionRunner`, which is the new runner. The
  old instance's `agent_end` listener in `session.ts` never fires again, so an old step waiting for its turn to end never
  settles: the old run hangs forever. (Interactive `/reload` refuses while a response streams, but a reload between two
  steps, during the check's `exec`, or through `ctx.reload()` and the sandy bridge still lands mid-run.)
- An old run that is not waiting for `agent_end` (between steps, or in the check's `exec`) throws on its next call to the
  stale `pi` (`sendUserMessage`, `appendEntry`, `exec`). Either way it never writes to the session again.
- A restart ends the process, and with it any in-memory state.

So "a plan-run is still going in this pi process" must not be a process-global flag: the old run neither ends nor throws
in the hanging case, so a flag in `globalThis` set by it would block resume forever after a reload.

## Designs considered

Where the run's state lives:

1. **A run-state entry of its own (chosen).** plan-run appends a custom entry `autopilot-plan-run` next to the
   `work-tasks` snapshots at every transition: run id, task, plan (steps and check) once there is one, phase (planning,
   step, check, blocked, passed, failed), the step index and the fixes used. The task list is derived from the plan, so the
   resumed run rebuilds the same ids and subjects.
2. **Extend the `work-tasks` snapshots** with a `run` field. One entry fewer, but it couples the run's control state to
   the task list's format (`tasks/state.ts`, read by sandy/work/goals), and the list alone cannot carry the task text or a
   finished outcome without misusing it.
3. **A file under `.pi/`.** Survives anything, but is not scoped to the session or its branch: forks, `/tree` and two
   sessions in one repo would see each other's runs.

The session entry follows the branch for free, is what the task tools already do, and needs no new I/O.

How "still going in this pi process" is detected:

1. **A flag in `globalThis`.** Survives fresh imports, but outlives a reload: the old run hangs and never clears it.
2. **A marker keyed on the extension instance (chosen).** A `WeakMap` in `globalThis` counts the plan-runs going
   per extension instance, keyed by its `api.pi`; plan-run counts up on start and down in `finally`, so it is true while a run
   goes and false after it ended or threw. `api.pi` is the gate's proxy, created once per extension load: after a
   reload the new instance has a new `pi`, so the hung old run does not block it, and the old object can be collected.
3. **Ask whether the old `pi` is stale.** Would also work, but needs a registry of runs and a probe call that throws.

## Chosen behavior

- `/autopilot resume` (`autopilots/resume.ts`, which re-exports `resume` from `plan-run.ts`) reads the branch. The latest
  entry per run id decides the run's state, so a run that passed or failed is never resumed, also not through an older
  snapshot further back. Among the unfinished runs the newest (by its first entry) is resumed under its own id.
- Planning interrupted: it plans again with the original task. A step interrupted or blocked: completed steps stay
  completed and that step runs again from the start. Check interrupted (also during a fix step): the check runs again with
  the fix steps it has left. The resumed run writes the same task list and still denies the task tools.
- Nothing to resume, or a plan-run still going in this instance: no step runs; `pi.sendMessage` says why and the result
  is `{ resumed: false, reason }`.
