# Slice 18 live evidence: workers through admission and isolation

Date: 2026-10-27, UTC 20:11 to 20:14. Project proj_ktxba3f8zg. Both plugins were built and installed from this worktree: `sandy plugin build . && sandy plugin install <worktree>/sandy/delegate --yes` and the same for `sandy/workflows-plus`. maxConcurrentChildren stayed at 4 for the whole run, checked afterwards with `sandy plugin config delegate`. Nothing ran under thr_6vthb5nb84. Ledger rows were read with /tmp/sandy-delegate-live/q.cjs (better-sqlite3, read-only). The parent prompt is /tmp/sandy-delegate-live/parent-18.txt and the workflow is /tmp/sandy-delegate-live/wf-18.js.

## Threads (all archived afterwards)
| Role | Thread | Ledger row |
|---|---|---|
| parent, visible, haiku-5-5 pi, permission full | thr_wzeuweuiwd | root |
| delegate 1 (implementer-low, `sleep 100`) | thr_merhrrd7xt | dlg_c7762b12-... |
| delegate 2 | thr_r9t28y4f8c | dlg_51bf8a51-... |
| delegate 3 | thr_mx8p5tg5qs | dlg_cc8e061c-... |
| workflow reader worker (no `writes`) | thr_y867j96qze | dlg_ac6462a7-... (workflow-worker) |
| workflow writer worker (`writes: true`) | thr_3q7w7m5i2u | dlg_2250f282-... (workflow-worker) |

## Setup
- The parent launched 3 async delegates. All 3 rows were `active` at 20:11:28.
- The workflow was started from the CLI with the parent as origin: `SANDY_PROJECT_ID=proj_ktxba3f8zg SANDY_THREAD_ID=thr_wzeuweuiwd sandy workflows-plus run --script "$(cat wf-18.js)"`. It is `Promise.all` of two workers with an output schema `{cwd}`: one reader and one writer. Each runs `pwd && sleep 15`.
- Two earlier attempts (wfr_18ea2b10, wfr_da7fe51a) ran without SANDY_PROJECT_ID. The CLI then took proj_personal from /tmp, and the spawn failed with HTTP 409 "Environment belongs to a different project". In both, the admitted reservation (dlg_1e957fce, dlg_a777e84c) was released by workers.release as `error` with no child, so a failed spawn freed its slot. No worker thread was created.

## 3 delegates + 2 workers: the 5th waits
Run wfr_6b7110ee-c0ec-4e3f-b110-4476be040690, started 20:12:19.
- 20:12:19: delegate log "worker slot dlg_ac6462a7-... (reserved)". workflows-plus spawned thr_y867j96qze and attached it, so the row is `active` with child thr_y867j96qze. The root now holds 4 slots: 3 delegates and 1 worker.
- 20:12:19.507: workflows-plus log "[wfr_6b7110ee-...] Waiting for a worker slot: root is full (4 running)". The second worker was not spawned.
- 20:12:39.124: the first worker's call settled. workers.release moved dlg_ac6462a7 to `idle`.
- 20:12:42.167: the waiting worker was admitted on its next poll. dlg_2250f282 is `active`, bound to thr_3q7w7m5i2u, and the root again holds 4 slots.
- 20:13:04: the run succeeded with 2 of 2 calls. Both worker rows are `idle`. The delegates went `idle` when their `sleep 100` turns ended.

## Writer in its own worktree, reader in the origin's
- Reader thr_y867j96qze: environment env_43d53tev77, which is the origin's environment, path `.../worktrees/thr_wzeuweuiwd-1/repo`, branch `sandy/delegate-test-parent-slice18-workers-thr_wzeuweuiwd`. Its result was `cwd = .../worktrees/thr_wzeuweuiwd-1/repo`.
- Writer thr_3q7w7m5i2u: environment env_t4c6v2vkvy, a new managed worktree `.../worktrees/thr_3q7w7m5i2u-1/repo` on branch `sandy/delegate-test-s18-writer-thr_3q7w7m5i2u`, based on the origin's branch. Its result was `cwd = .../worktrees/thr_3q7w7m5i2u-1/repo`.
- Both workers have lifecycleOwnerThreadId thr_wzeuweuiwd.

## Worker result tool
- Both workers returned the schema value through `sandy_workflow_plus_result`, called through codemode (reader at seq 20). The run's result is the two `{cwd}` objects above. The tool call item shows status "interrupted". That is the call ending the worker's turn once the value was recorded, and the value was accepted.

## Not run live (unit tests only)
- Restart after workers.admit and before the spawn: settle-window release (tests/workers.test.ts).
- Restart after the spawn and before workers.attach: attach by pluginMetadata, plus the sweep's idle backstop (tests/workers.test.ts).
- Kept-session continuation admission, a refused nested origin, cancel while waiting, and delegate missing (src/worker-admission.test.ts).

## Restore
- maxConcurrentChildren = 4. delegate, workflows-plus and sandy-sidebar-delegate are running from this worktree.
- Archived: thr_merhrrd7xt, thr_r9t28y4f8c, thr_mx8p5tg5qs, thr_y867j96qze, thr_3q7w7m5i2u, thr_wzeuweuiwd. The ids are listed in /tmp/sandy-delegate-live/thread-ids.txt.

## Fix round (review BLOCK, four P1 findings)

Date: 2026-10-27, UTC 20:49 to 20:54. Same project, both plugins rebuilt and reinstalled from this worktree; maxConcurrentChildren = 4 checked afterwards. Parent thr_wykw4rvz8f (fresh, visible, haiku-5-5 pi, from parent-18.txt); never thr_6vthb5nb84. All threads below archived afterwards.

- callRpc probes (temporary plugin, removed): a call to a plugin that is not installed fails with status 404, code null, message `HTTP 404: unknown plugin "<id>"`; a missing method on an installed plugin fails with status 404, code `unknown_method`. workflows-plus skips admission only on these two (`isDelegateAbsent`); every other failure is retried (500/1000/2000/4000 ms) and then fails the call.
- First run wfr_df7536d1: the 3 delegates (dlg_49873380, dlg_724d2694, dlg_036566b6) were active, the reader got slot dlg_fb877f0a and spawned thr_p9w47jgvj4, and the new attach provenance check refused it: "thread thr_p9w47jgvj4 is not a workflows-plus thread under thr_wykw4rvz8f". The cause: a worker is a hidden thread with `parentThreadId: null` and `lifecycleOwnerThreadId` = origin, so it is not among the origin's descendants. The run failed, and the refused spawn was stopped (fail closed). Fix: `workerCandidates(origin, threadId)` reads a named thread directly (`threads.get` plus `experimental_listPluginMetadata` for workflows-plus), and requires `lifecycleOwnerThreadId` or `parentThreadId` to be the origin.
- Second run wfr_6bfe7f73, after the fix and reinstall: both calls logged "Waiting for a worker slot: root is full (4 running)" at 20:51:48 while the delegates ran. Once they finished, both were admitted at 20:52:05 (dlg_e61a9fa1, dlg_06257942) and attached (rows `active`, bound to thr_weh8z38d3g and thr_fc5592ndy4). Both released to `idle` when the run succeeded. Reader cwd = the origin's worktree (thr_wykw4rvz8f-1); writer cwd = its own worktree (thr_fc5592ndy4-1).
- Open observation: dlg_2cb33792 (the writer call of the failed first run) was still `reserved` with no child at 20:53, so it held a root slot. It is released by the sweep after SPAWN_SETTLE_MS (10 min); release by workflows-plus was not seen. This is not investigated.
- Not live: concurrent continuations (worker_busy and lease fencing), cross-run transfer refusal, the writer-continuation refusal, and admission retry. These are unit tests only (tests/workers.test.ts, src/worker-admission.test.ts).

## Follow-up (restart reconcile by lifecycle owner, leaked admit)

Date: 2026-10-28, UTC 04:55 to 04:57. Same project; both plugins rebuilt and reinstalled from this worktree first; maxConcurrentChildren = 4 checked afterwards. Parent thr_aiz3f3839x (fresh, visible, haiku-5-5 pi, prompt /tmp/sandy-delegate-live/parent-18f.txt); never thr_6vthb5nb84. Workflow /tmp/sandy-delegate-live/wf-18f.js: one reader worker running `pwd && sleep 60`.

- Cause of the leaked dlg_2cb33792 (from the logs and the code): in run wfr_df7536d1 the reader's attach was refused at ts 1793134240229, so the run failed and its signal aborted. The writer's `workers.admit` call was still in flight. delegate committed the reservation at 1793134240249 ("worker slot dlg_2cb33792-... (reserved)"), but workflows-plus had passed the run's signal to `callRpc`, so the call rejected, `slot` stayed null and `workers.release` was never sent. The ledger row is now `error`, `reservation_owner` NULL, `updated_at` 1793134841559: the sweep released it after SPAWN_SETTLE_MS ("worker reservation ... released, no thread", +601 s). The reader's dlg_fb877f0a was released by workflows-plus 51 ms after its admit. Fix: `workers.admit` is no longer cancelled with the run. The run's cancel still ends the wait at once, and a slot granted after the abort is released (`untilAborted` in worker-admission.ts).
- Run wfr_ad9cabf4-11c2-491a-aca3-47d5699a46de: worker thr_kpfar5ejnu was admitted and attached at 04:56:11 (dlg_f0652b4e-..., `active`, bound).
- SANDY's listing of the worker (`sandy thread list --project proj_ktxba3f8zg --include-hidden --json`): `parentThreadId: null`, `lifecycleOwnerThreadId: thr_aiz3f3839x`, `originPluginId: workflows-plus`, `visibility: hidden`. These are the fields the reconcile's new `threads.list` lookup filters on.
- 04:56:27: `sandy plugin reload delegate` while the worker slept. Startup reconciliation was done at 04:56:27.690 (ts 1793163387690). The row stayed `active`, bound to thr_kpfar5ejnu, lease held, `updated_at` unchanged.
- 04:57:19: the run succeeded (result cwd = the origin's worktree thr_aiz3f3839x-1). workers.release moved the row to `idle`.
- Not exercised live: the reconcile of an *unbound* reservation after a restart (the admit-to-attach window is milliseconds). The row above was bound, so the reload covered the bound-row path. The SDK's `originPluginId` and `archived` list filters were not checked through the CLI, which has no such flag. Unit tests: tests/sandy-host.test.ts "sandy-host worker reconcile: ...".
- Archived: thr_kpfar5ejnu, thr_aiz3f3839x (listed in /tmp/sandy-delegate-live/thread-ids.txt).
