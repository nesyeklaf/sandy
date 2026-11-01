# Resuming a plan-run after a reload

## Problem

`/autopilot plan-run` keeps its plan and progress only in the memory of the running pi. When pi reloads mid-run (an
extension update, a crash, a restart of the host), the run is gone: the task list stays on a step in_progress, the
composer banner keeps showing it, and the only way on is to start the whole task again, planning included.

## Designs considered

1. **Derive the state from the task list.** The `work-tasks` entries already hold every step and its status. Resume
   would rebuild the run from the newest list. Small, but the list lacks the original task (needed when pi stopped
   during planning), the check command only survives inside a subject ("Run npm test"), and nothing says whether the
   run ended (passed, failed, blocked) or was cut off.
2. **A run record in the session.** Every list change also appends an `autopilot-run` entry with the task, the plan
   (steps and check), the list and the status (running, blocked, passed, failed). Resume reads the newest one.
3. **A state file in the repo (.pi/run.json).** Survives a new session too, but it belongs to no session: two
   sessions in one checkout would fight over it, and it leaves a file in the user's work tree.

## Decision

Design 2. The session is where pi keeps what a reload must not lose, the record is complete without parsing subjects,
and the status tells a cut-off run (still "running") from a finished one. The record costs one extra entry per list
change, a few hundred bytes each.

Rules:

- `/autopilot resume` takes the newest run record. It resumes a run with status running or blocked; passed and failed
  runs are over.
- No plan yet: plan again with the original task. Completed steps are skipped. The step that was in_progress runs again
  from the start; its prompt says it was interrupted, so the model checks what is already done. A cut-off check runs
  again.
- The resumed run writes the same list (same ids and subjects).
- While an autopilot runs in this pi process, resume refuses: that run is not cut off.
