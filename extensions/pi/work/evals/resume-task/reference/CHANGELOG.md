# Changelog

## 0.2.0

- `/autopilot resume` continues a plan-run that a pi reload cut off, or one that ended blocked: completed steps are
  skipped, the interrupted step runs again, the task list keeps its ids. plan-run records its state as
  `autopilot-run` session entries for this. See docs/autopilot-resume.md.

## 0.1.0

- `/autopilot <name> [args]` command.
- plan-run autopilot: planning step, one turn per step with the task list kept by code, the check run by code with
  up to two fix steps.
