# Bounded verification at 46e4b6e0f

## Scope and result

All requested bounded checks passed against code snapshot `46e4b6e0f5604f39e63459a09271e909cf6ff380`. No product code or tests were changed during this run. Only verification documents were updated afterwards. This is not full feature acceptance: OpenSpec 4.1 and 6.1 remain open, and no provider is upgraded to `enforced`.

Node: `v26.13.0` (matches `.nvmrc`). Installed Pi: `1.5.1`. Checks ran serially through Turbo at nice level 10 with one Vitest worker; real Pi used temporary fixture homes and resolver/RPC listing requests, not model turns.

## Recorded checks

- **App:** 145/145 reported passing, 0 skipped, 0 unexpected failures. Files: `apps/app/src/hooks/realtime-cache-effects.test.ts`, `apps/app/src/views/SkillsView.test.tsx`, `apps/app/src/components/tools/detail-page-recipes.test.tsx`.
- **CLI:** 9/9 reported passing, 0 skipped, 0 unexpected failures. Files: `apps/cli/src/__tests__/command-output/skill.test.ts`.
- **Pi default:** 35/43 reported passing, 8 skipped, 0 unexpected failures. Files: `plugins/provider-pi/src/bridge/bridge.interruption-recovery.test.ts`, `plugins/provider-pi/src/bridge/skill-selection.test.ts`.
- **Pi installed:** 16/16 reported passing, 0 skipped, 0 unexpected failures. The 2 known-gap cases use `it.fails`: they count as green because the hidden-skill assertions fail, not because filtering works. Files: `plugins/provider-pi/src/pi-package-skills.test.ts`, `plugins/provider-pi/src/bridge/skill-selection.test.ts`.
- **App typecheck:** successful through Turbo; all 5 tasks were cache hits. This is a matching-input cached result, not a fresh compiler run.
- **Source CLI:** `skill selection --help`, `guide agent-configuration` and `guide commands skill` exit successfully with `SANDY_CLI` and `SANDY_CLI_REEXEC` removed. Local content assertions cover the modes, name-level scope, loaded-thread timing, reported gaps and command discovery; no server setting was mutated.
- **OpenSpec:** `openspec validate sandy-agent-skill-selection --strict --no-interactive --json` reports a valid change with no issues.

## Previously failing fixtures

- The App search fixture now gives `deploy` a description that does not contain `review`; the test also checks that `deploy` is absent before opening the bulk menu. The policy assertions remain intact.
- The Pi environment test copies `launchEnv` in its discovery callback before environment stubs are restored. Both the default and installed-Pi runs now pass this regression.
- The interruption suite passes its existing time limits on this serial run. No timeout was increased.

## Still open

- **Pi:** the two expected failures retain the `resources_discover` extension-skill gap. The previously reported dynamic `project_trust` mismatch remains unresolved; it was not newly probed.
- **Claude Code:** bundled and Marketplace-plugin skills, and unproven subagent behavior. No additional Claude run was performed.
- **Codex:** skills added after process start under `allow-only`. No additional Codex run was performed.
- **Lifecycle and UI:** no native full-thread/server end-to-end run and no new browser or screenreader/device verification. Earlier scripted-bridge and browser evidence is recorded in the handoff, not upgraded by these checks.
- Every named gap still needs a proven integration or explicit owner acceptance. None was silently accepted.

## Evidence and unchanged state

Raw evidence is local under `$SANDY_THREAD_STORAGE/final-46e4b6e0f-S4kE74/`: `commands.txt`, before/after HEAD and status snapshots, `logs/`, `reports/`, exit files and `summary.json`. Raw reports are not part of this repository; this file is the portable summary.

Before documentation edits the tracked worktree was clean. The only pre-existing untracked entries were the two legacy Holon drafts; neither was edited, staged or used as a gate. No new push, PR, merge, release, deploy, productive configuration change or live model turn was performed.
