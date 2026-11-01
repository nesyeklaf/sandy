# Slice 5 live evidence: spawn reconcile (sandy 0.47.1, plugin SDK 0.6.79), 2026-10-27

Setup (this host only):
- Plugin rebuilt and reinstalled from path: `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`. `sandy plugin list` then showed `delegate@0.1.0 running` with `service watchdog: running`, and `sandy plugin logs delegate` showed `watchdog: startup reconciliation done`. Migration #5 (delegation_markers) was applied on this host.
- Window unchanged: briefWatchdogSeconds 120 (the run 1 refusal logs `no ack within 120000 ms`).
- The pi extension is installed at ~/.pi/agent/extensions/sandy-delegate (index.ts = pi-extension.ts, shared/policy.ts). Run 2 used the fixed copy; `diff` against the repo was clean.
- Project `proj_ktxba3f8zg` (/tmp/sandy-delegate-live/repo). Every parent is a throwaway visible thread, spawned with `env -u SANDY_THREAD_ID sandy thread spawn --project proj_ktxba3f8zg --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --title "[delegate-test] ..." --visibility visible --prompt-file ... --json`. Each prompt asks for one sandy_delegate call (agent scout, async).
- Ledger reads: plugin data.db, opened read-only.

Thread ids:
| thread | role | delegation |
|---|---|---|
| thr_mywa957ntq | parent, marker timing ("[delegate-test] parent reconcile timing") | |
| thr_hhhyy53bbk | scout child, normal launch (no bind delay) | dlg_35dd803e-debd-4d80-83ac-39d48576d480 |
| thr_qbbpc5jejy | parent, run 1 ("[delegate-test] parent reload during bind") | |
| thr_7y7f3yn7zt | scout child, run 1 | dlg_62a62bb2-170c-4171-b424-6c4a19e300ef |
| thr_aiaaetsfmy | parent, run 2 ("[delegate-test] parent reload during bind 2") | |
| thr_zvzuyi4rpx | scout child, run 2 | dlg_2ebf2ecc-7319-4ef8-b463-4fb4baa902c1 |

## The "running unmarked" rule, and why it can be read from SANDY data
A child runs unmarked when SANDY started a turn on it before agents.configure handed it sandy_delegate_brief (the marker). Without the marker the pi extension installs no gate. The plugin records when configure grants the marker (`delegation_markers.granted_at`). The watchdog reads the thread's first `turn/started` event (`threads.events.list`). A bound row in `starting` is unmarked when a turn started and the marker was never granted, or was granted only after that turn started. Such a child is refused and stopped, and never repaired.

Measured on a normal launch (thr_hhhyy53bbk, from `sandy thread log --format json --all` and the ledger):
```
client/thread/start   1793101131693
marker granted        1793101131750   (configure, 57 ms later)
policy ack            1793101133084
turn/started          1793101133135   (1.4 s after the grant)
```
Run 1 and run 2 below show the same order: the grant came 53 ms and 42 ms after client/thread/start, and before turn/started. So a marked child never trips the rule.

## Run 1: plugin reinstalled during the bind delay. This run found the extension gap.
`env -u SANDY_THREAD_ID sandy delegate debug bind-delay 20000`, then /tmp/sandy-delegate-live/live5.sh. It spawns the parent and waits for the reserved row. Then it waits 5 s, lists the parent's children, and reinstalls the plugin. Log (/tmp/sandy-delegate-live/live5.log):
```
11:43:22.840 row: [{"delegation_id":"dlg_62a62bb2-…","state":"reserved","child_thread_id":null,"created_at":1793101402769,"bound_at":null}]
11:43:27.845 children of parent:  thr_7y7f3yn7zt starting hidden 1793101402777
11:43:28.082 row before reload: state reserved, child null
11:43:28.127 reinstall start
11:43:34.275 reinstall done
11:43:34.278 [{"state":"starting","child_thread_id":"thr_7y7f3yn7zt","bound_at":1793101413809,"acked":null,"brief":null}]
... unchanged (no ack) through 11:44:34
```
`sandy plugin logs delegate`:
```
{"ts":1793101413829,"level":"info","message":"watchdog: startup reconciliation done"}
{"ts":1793101413829,"level":"info","message":"watchdog: reservation dlg_62a62bb2-170c-4171-b424-6c4a19e300ef bound to thr_7y7f3yn7zt"}
{"ts":1793101533949,"level":"warn","message":"watchdog: dlg_62a62bb2-170c-4171-b424-6c4a19e300ef (child thr_7y7f3yn7zt) refused, no ack within 120000 ms"}
{"ts":1793101533950,"level":"info","message":"watchdog: stopped thr_7y7f3yn7zt"}
```
The server side worked. The startup pass of the new process bound the one child SANDY had spawned for the reservation, 11 s after the spawn. There was no second spawn: the parent has exactly one child. The marker was granted at 1793101402843, before the child's turn/started at 1793101409262, so the child was not flagged unmarked.

The gap was in the child. Its pi extension called `sandy delegate policy` while the plugin was reloading. That call threw, and a thrown call was not "pending", so `cliPolicySource.load` failed at once. The gate stayed pending (deny-all) for the whole first turn. The child's log (`sandy thread log thr_7y7f3yn7zt`) shows codemode and sandy_delegate_brief blocked with `the delegation policy is not applied yet`. The child then ended its turn ("I could not get my role and task"). With no ack, the watchdog refused it at bound + 120.1 s. The ledger has delegation_stops `{reason: no_ack, requested_at: 1793101533937, stopped_at: 1793101533937, attempts: 1}`. The gate stayed closed throughout, but a reload in the bind window left the child unable to ever ack.

Fix (supervisor-approved): `cliPolicySource` now retries a thrown `delegate policy` call like "pending", every 1 s up to the 30 s pending timeout, and the gate stays deny-all meanwhile. It also retries a thrown `delegate ack` call within its own 30 s window. Denied and malformed answers are still final.

## Run 2: the same reload with the fixed extension. Exactly one child, bound, gated and acked.
Same bind delay, /tmp/sandy-delegate-live/live5b.sh. Log (/tmp/sandy-delegate-live/live5b.log):
```
11:46:54.977 row: [{"delegation_id":"dlg_2ebf2ecc-…","state":"reserved","child_thread_id":null,"created_at":1793101614939,"bound_at":null}]
11:46:59.981 children of parent:  thr_zvzuyi4rpx starting hidden 1793101614944
11:47:00.207 row before reload: state reserved, child null
11:47:00.251 reinstall start
11:47:06.380 reinstall done
11:47:06.383 [{"state":"starting","child_thread_id":"thr_zvzuyi4rpx","bound_at":1793101625958,"acked":null,"brief":null}]
11:47:07.930 [{"state":"active","child_thread_id":"thr_zvzuyi4rpx","bound_at":1793101625958,"acked":1793101627074,"brief":null}]
11:47:09.472 [{"state":"active","child_thread_id":"thr_zvzuyi4rpx","bound_at":1793101625958,"acked":1793101627074,"brief":1793101628603}]
```
`sandy plugin logs delegate`:
```
{"ts":1793101625978,"level":"info","message":"watchdog: startup reconciliation done"}
{"ts":1793101625979,"level":"info","message":"watchdog: reservation dlg_2ebf2ecc-7319-4ef8-b463-4fb4baa902c1 bound to thr_zvzuyi4rpx"}
```
Ledger:
- delegations: created_at 1793101614939, bound_at 1793101625958 (bound by the startup pass, not by the launch), state active.
- delegation_markers: thr_zvzuyi4rpx granted_at 1793101615009.
- delegation_acks: one row: nonce_96ccba73-…, issued_at 1793101626727, acked_at 1793101627074, pi_session_id 01a17d2f-…, brief_delivered_at 1793101628603.
- delegation_stops: none for thr_zvzuyi4rpx.

Child log (`sandy thread log thr_zvzuyi4rpx --format json --all`):
```
2  client/thread/start  1793101614967
5  turn/started         1793101627135   (after the ack: before_agent_start waited on the retried policy load)
9  item/started         sandy_delegate_brief
13 item/started         codemode -> mcp__builtin_ls__ls (the scout task)
39 turn/completed       1793101633808
```
`sandy thread list --parent-thread thr_aiaaetsfmy --include-hidden`: only `thr_zvzuyi4rpx idle hidden`. One spawn, no second child.

`sandy delegate list`:
```
DELEGATION                                STATE    AGENT            PARENT          CHILD           MODEL                       REASONING  ACKED                     BRIEF      STOP     CREATED
dlg_2ebf2ecc-7319-4ef8-b463-4fb4baa902c1  active   scout            thr_aiaaetsfmy  thr_zvzuyi4rpx  anthropic/claude-haiku-5-5  medium     2026-10-27T11:47:07.074Z  delivered  -        2026-10-27T11:46:54.939Z
dlg_62a62bb2-170c-4171-b424-6c4a19e300ef  refused  scout            thr_qbbpc5jejy  thr_7y7f3yn7zt  anthropic/claude-haiku-5-5  medium     no                        no         stopped  2026-10-27T11:43:22.769Z
```

The parent saw the lost result. In both runs the parent's sandy_delegate call came back as `Tool "sandy_delegate" failed: The database connection is not open`, 20.1 s after the call. The old plugin process finished its bind delay after the reload had closed its DB handle. The parent's prompt allowed one call, so it did not retry. A retry with the same clientRequestId returns the bound delegation (`reused`) and does not spawn again. That is covered by tests, not shown live.

## Not shown live
- A child running unmarked. This would need SANDY to start a turn on a plugin-spawned child before configure grants the marker, and no such child could be produced here. Covered by tests/watchdog.test.ts ("startup reconcile: … running without the marker", "a child bound by its own launch whose first turn started without the marker").
- A foreign thread with copied `pluginMetadata.delegate`. `sandy thread spawn` has no metadata option. Covered end to end inside the plugin (sweep, configure, policy, ack, brief) by "startup reconcile: a foreign thread with copied metadata binds nothing and gets deny-all".
- Two candidates for one reservation. Covered by "startup reconcile: two plugin-spawned threads naming one reservation".

## Restore
- `env -u SANDY_THREAD_ID sandy delegate debug bind-delay 0` printed `bind delay 0 ms`.
- Archived threads, with archivedAt from `sandy thread show`, all idle: thr_hhhyy53bbk 1793101740567, thr_mywa957ntq 1793101740800, thr_7y7f3yn7zt 1793101741037, thr_qbbpc5jejy 1793101741279, thr_zvzuyi4rpx 1793101741527, thr_aiaaetsfmy 1793101741778.
- `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`. `sandy plugin list` then showed `delegate@0.1.0 running` and `service watchdog: running`. Its "2 errors" are the two lost sandy_delegate results above. `sandy plugin logs delegate` showed `watchdog: startup reconciliation done` at 1793101742530.
- briefWatchdogSeconds was not changed (120).
- The pi extension at ~/.pi/agent/extensions/sandy-delegate is the fixed copy, and its diff against the repo is clean.
