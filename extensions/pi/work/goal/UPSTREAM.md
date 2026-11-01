# Upstream

This unit is a fork of [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x) (MIT), imported with
`git subtree add` at tag v0.34.1 (27d9fac), history kept.

## Changes in this fork

- Headless mode: `PI_GOAL_HEADLESS=1` makes pi-goal-x skip its dialogs (confirm, select, input,
  custom) even when the host reports a UI, and take the paths it already has for sessions without
  one. Status lines and widgets still render. Reason: in SANDY the pi bridge forwards dialogs raised
  by slash commands, but they never reach the user, so `/goal-clear` waited until SANDY stalled the
  turn. The sandy/work/goals pi link sets the variable in SANDY sessions. Code: `extensions/goal-headless.ts`.
- `/goal-clear [id] [--yes]`: an id targets that open goal, `--yes` archives without the dialog
  (the caller confirmed already, e.g. the Clear button in sandy/work/goals).
- `/goal-focus <id>` focuses that open goal without the selector.
- `/goal-recovery repair --yes` repairs without the dialog.

Tests: `tests/goal-headless.test.ts`.

## Pulling upstream

```
git subtree pull --prefix=pi/goal-x https://github.com/tmonk/pi-goal-x.git <tag>
```

Then run `npm ci && npm test && npx tsc --noEmit` in pi/goal-x.
