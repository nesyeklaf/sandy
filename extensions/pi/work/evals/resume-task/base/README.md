# pi-autopilot

Autopilots for pi: TypeScript functions that steer a pi session turn by turn, so code decides the order of the work
and the model does the work.

## /autopilot

`/autopilot <name> [args]` runs the autopilot <name> in this session and posts its JSON result as a message
(`[autopilot] <name> -> <result>`). An unknown name or a thrown error is posted as `{"error": ...}`.

## plan-run

`/autopilot plan-run <task>` does a multi-step task with a task list that the code keeps:

1. A task "Plan the work" shows in the list from the first second. The model reads what it needs and submits 2 to 4
   steps and the one shell command that checks the whole work.
2. Each step runs as its own turn. The autopilot sets it in_progress before and completed after, so the list and the
   composer banner's Now line follow the work. A step the model reports blocked stays in_progress and the run stops.
3. The check runs by code. When it is red, the model gets the output tail in a fix step, at most twice.

The task tools (TaskCreate, TaskUpdate, TaskList, TaskGet) are blocked in every step: while it runs, the autopilot is
the list's only owner. The list is written as `work-tasks` session entries, the same entry the task tools write.

Result: `{steps, check, passed: true}`, `{blocked, note, steps}` or `{failed, code, killed, tail, steps}`.

## Development

`npm test` runs the tests (node --test with type stripping, Node 23 or newer).
