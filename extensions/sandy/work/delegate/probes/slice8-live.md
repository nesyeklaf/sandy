# Slice 8 live evidence: wait mode (sandy 0.47.1), 2026-10-27

Setup: plugin built and installed from this worktree (`sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`), project `proj_ktxba3f8zg`. `sandy plugin config delegate set waitCeilingMs 60000` for the runs, restored to 270000 afterwards. Parents are visible threads spawned with `env -u SANDY_THREAD_ID sandy thread spawn --project proj_ktxba3f8zg --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --visibility visible --prompt-file …`; children are scouts (haiku). Poll lines come from `sandy thread show <child> --json`; parent transcripts from `sandy thread log <parent> --format json --all`. Scripts and prompts: /tmp/sandy-delegate-live/parent-8*.txt.

Another worker reinstalled the plugin from /home/aemon/projects/plugins-wt/sandy-delegate-s7 at 15:14:30Z (plugin log `startup reconciliation done` 1793114070387); from then on the installed plugin lacked wait mode (a parent got `Validation failed … mode: must be equal to constant`, runs C and D1-D3 below). I reinstalled this worktree at 15:18Z; runs C2 and D4 are on it.

| thread | role |
|---|---|
| thr_dz3wmwugdt / thr_qh5fuxfmts | run A parent / scout |
| thr_5qtqu5fgkd / thr_d7y8hevtth | run B parent / scout |
| thr_v4uxfcydiz / thr_hev9wawner | run C2 parent / scout (dlg_f4f072a4-a485-46d8-9b70-1bac32c6d5a8) |
| thr_ypkvcypdg2 / thr_823m83ujq3 | run D4 parent / scout (dlg_ea124e87-c96f-4f18-be5c-3f73295025f5) |
| thr_byct468dsy, thr_c4tikirfw6, thr_dsr44j23qp | parents of failed attempts (wrong plugin installed / model never called the tool), no child |
| thr_wvnwdtq5pa / thr_h36jacu3r4 | D3: scout answered "read 1" and finished at once, nothing to abort |

## A: child finishes inside the ceiling
`sandy_delegate(mode:"wait")` returned in under 40 s with `status:"completed"`, `waitTimedOut:false`, `result` = the scout's report, `parentNotifications:"auto"`. No wake of the parent afterwards.

## C2: ceiling (60 s) three times, then the result (child ~144 s)
Child polled while the parent waited: `parentNotifications "off"` from 15:18:33Z, `auto` seen at 15:20:25Z (between two chunks), `off` again, `idle`+`auto` at 15:20:51Z.
Parent transcript (ms since epoch):
- seq 23 sandy_delegate(wait) started 1793114303254; seq 25 done 1793114363330 (60.1 s): `status:"running", waitTimedOut:true, parentNotifications:"auto"`, with delegationId and threadId.
- seq 30 sandy_delegate_wait started 1793114364601; seq 31 done 1793114424631 (60.0 s): `waitTimedOut:true`.
- seq 33 sandy_delegate_wait started 1793114425874; seq 34 done 1793114447932 (22.1 s): `status:"completed", waitTimedOut:false, result:"done 90"`.
The child kept running through both timeouts. The parent has no `child-completed` system message and no extra turn after the wait returned the result (checked 8 minutes later: only its own turn/started seq 16 and turn/completed seq 65). So flipping an already finished child to `auto` does not wake the parent: flip-on-finish is safe.

## D4: parent turn stopped while waiting
Child `active`, `parentNotifications:"off"` at 15:25:26Z. `sandy thread stop thr_ypkvcypdg2` at 15:25:27Z (system/thread/interrupted manual-stop, parent turn/completed interrupted, seq 26-30, 1793114727799). Polls 15:25:30, :34, :38Z: child `active`, `parentNotifications:"auto"`, parent `idle`. The child finished (idle at 15:27:18Z, output `done 90`); at 1793114836115 SANDY woke the idle parent natively (seq 31 client/turn/requested systemMessageKind `child-completed` for thr_823m83ujq3, then a new parent turn, seq 34-44).

## B (accident): plugin reload mid-wait
Run B's parent was waiting (60 s ceiling) when the other worker reinstalled the plugin at 15:14:30Z. The tool call returned `aborted:true, waitTimedOut:false, status:"running", parentNotifications:"auto"` after about 40 s (the plugin dispose aborts ctx.signal), the child was flipped to `auto` (poll 15:14:30Z), kept running, and its finish woke the parent natively (seq 39 child-completed 1793114104239).

## Restore
- `sandy plugin config delegate` → `waitCeilingMs = 270000`.
- Installed plugin: `delegate@0.1.0 running`, source path:/home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate (this worktree; the slice 7 worker may reinstall its own tree again).
- All eight parents and five children above archived (`sandy thread archive`); threads of other workers untouched.
