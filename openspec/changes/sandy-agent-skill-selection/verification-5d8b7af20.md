# Final checks at 5d8b7af20 (writer worktree, Node v26.13.0)
Logs: logs/*.log. Reports: reports/*.json. Start state: head-at-run.txt, dirty-at-run.txt. End state: end-state.txt.
Dirty: only untracked .holons/changes/sandy-agent-skill-selection{,-r2}.json.

| group | result |
|---|---|
| app typecheck (turbo force) | PASS (exit 0) |
| app SkillsView + realtime-cache-effects + detail-page-recipes | FAIL 144/145: SkillsView "turns every skill off, keeps only the shown skills on, and resets from the selection menu" (menuitem "Only the 2 shown skills on" not found) |
| server targeted (6 files) | PASS |
| CLI skill.test.ts | PASS |
| domain skill-selection | PASS |
| SDK provider-declaration-v3 | PASS |
| agent-runtime full (turbo force) | PASS |
| host-daemon full (turbo force) | PASS |
| provider default suites (turbo force, pi/claude/codex) | FAIL: Pi only (8/9 tasks). Pi skill-selection.test.ts "discovers skills in the thread's environment, not the bridge's" deterministic; bridge.interruption-recovery "Pi 1.0.2" timed out under load (avg 34) in the batch, passes alone 28/28 |
| real Pi gated (skill-selection, pi-package-skills) | FAIL 10/16 first run (5 timeouts SIGTERM under load + the deterministic test); rerun 15/16, one fail: same "discovers skills in the thread's environment" test. Trust cases ("loads project skills when Pi trusts by default", "skips ... when Pi would ask") and 2 it.fails known gaps pass in rerun |
| real Claude gated (skill-selection, skill-plugins) | PASS |
| real Codex gated (skill-selection) | PASS |
| pure replay Pi resolver (trust-correct) | PASS: disable-unrelated keeps pi-project and agents-project |
| pure replay Codex null listing | PASS: codexDisableNullListing now null (fail-closed) |
| pure replay native Pi trust | PASS (recorded) |

Not verified: feature enforcement end to end (left UNVERIFIED). Lifecycle probe is scripted-echo, not native. Native providers only ran gated tests, no model queries.


## Handoff qualification

This is the recorded runner summary for 5d8b7af20, not a green result for the later WIP. Raw logs and JSON were saved on the originating server and are not included in this repository. Reproduce the bounded remaining checks on the receiving server. Pi's two `it.fails` tests are expected failures demonstrating unenforced extension filtering; they do not establish enforcement. The later WIP changes the deploy fixture description (the default description matched the search term) and snapshots the Pi environment before `vi.unstubAllEnvs()` restores it. Final reruns were not collected before the owner stopped work.
