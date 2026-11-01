
## /autopilot resume

When pi reloads in the middle of a plan-run, `/autopilot resume` continues it: the plan is not made again, completed
steps are skipped, the step that was running runs again from the start, and the task list keeps its ids. A run that
ended blocked resumes from its blocked step. A passed or failed run is not resumed, and neither is a run still going in
this pi; the command then says why. plan-run records its state as `autopilot-run` session entries for this
(docs/autopilot-resume.md).
