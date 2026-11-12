# Main integration verification

The owner approved merging the skill-selection work and delegated installation to the orchestrator. `origin/main` at `5ae82b7f625f02f9a4702078117d9c5a5b743d55` was merged into `6fa8628a6e56f53fb9a566e92bebad00348e4d71` without conflicts as `fba49723b519cb6f565e95550116c9400653c74f`. No feature code changed during integration. Both pre-existing untracked Holon drafts remain untouched and unstaged.

Checks ran serially on Node `v26.13.0`, at nice level 10, with `VITEST_MAX_WORKERS=1`, explicit Vitest `--maxWorkers=1`, and Turbo `--concurrency=1`:

- Full provider-pi suite: 347 passed, 30 skipped, 0 failed. Turbo's strict environment omitted the opt-in installed-Pi variable, so this run is default-suite evidence, not real-worker evidence. The skips are 22 installed-Pi cases and eight Windows-only cases.
- Separate installed-Pi run with `--env-mode=loose` and `SANDY_TEST_REAL_PI_COMMAND=/home/feysen/.pi/agent/bin/pi`: 23 passed, 0 skipped, 0 failed. This includes all 22 actual SDK-worker selection cases plus managed-package discovery. Pi version remains 1.5.1. Only fixture/RPC operations ran; no live model turn.
- App: 145 passed, 0 skipped, 0 failed across `SkillsView`, `realtime-cache-effects`, and `detail-page-recipes`.
- CLI: nine passed, 0 skipped, 0 failed in `command-output/skill.test.ts`.
- Typechecks for every changed workspace package: 24 Turbo tasks successful, eight cached and 16 executed. The filter includes app, CLI, host daemon, server, agent runtime, db, domain, host-daemon contract, Plugin SDK, bridge protocol, SDK, server contract, templates, Plugin Guide, all three provider plugins, and Sandy Guide; upstream tasks are included by Turbo.
- `openspec validate sandy-agent-skill-selection --strict --no-interactive --json` and `git diff --check` pass.

Raw JSON reports, command logs and exit files are saved under `/home/feysen/.sandy-local/data/thread-storage/thr_m8k92wkhv2/land-skill-selection/`. CI results are recorded on the pull request, not inferred from these local checks.

The complete feature changes the host-daemon protocol from 265 to 266; server and enrolled daemons must therefore be updated together through the supported installation path. Design A itself adds no further wire change. Installing only provider-pi does not install the core UI, API, selection storage, SDK or CLI.

The [SDK-worker verification](verification-pi-sdk-a.md) still defines the proof limits. OpenSpec 5.2 and 6.1 remain open; Pi full-thread/subagent acceptance is not claimed. Claude Code and Codex gaps remain unverified, not accepted: **Owner: später**. No browser, production configuration change, installation or deployment was performed during this integration run.
