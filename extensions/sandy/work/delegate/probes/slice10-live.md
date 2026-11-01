# Slice 10 live evidence: send + stop with authority

Date 2026-10-27 (UTC 15:48-16:02). Project proj_ktxba3f8zg, haiku-5-5 pi parents (visible, "[delegate-test]" titles), plugin installed from this worktree (sandy plugin build . && sandy plugin install ... --yes). Parent prompts are in /tmp/sandy-delegate-live/parent-10*.txt (some parents refused to call tools "directly", so later prompts allow codemode).

## Setup
- maxConcurrentChildren = 1 for Run B/C only (restored to 4 afterwards).
- Parents are throwaway visible threads; nothing ran under thr_6vthb5nb84.

## Threads
| Run | Parent | Child(ren) | Delegation |
|---|---|---|---|
| A1 steer | thr_ad9dkcwwsb | thr_x7ay5nzu5q (scout) | dlg_b0c8adc4-7ad9-402a-8909-6fccc950232a |
| A2 steer | thr_y5myyiw64y | thr_zk3ytp86e9 (implementer-low) | dlg_2cc7b8b8-7c61-49a9-9f21-40cb93ed8788 |
| A3 parent stop | thr_57ydz7qx6q | thr_9u32jite7b (sleep 90) | dlg_2d37461e-25ea-40f3-b60d-e3adcf6abdee |
| B (queue) | thr_bqmbbcapza (B6) | thr_qzqv4tmqmr (scout B), thr_zhnwjgbkh2 (sleep 50 A) | dlg_7d43db94-a11a-4536-8228-73cbb017ea30, dlg_398b2b40-f1c8-43ed-89f5-d75db2807db5 |
| C stop/negatives | thr_bqmbbcapza | thr_f8c3mk6gxd (S1), thr_ughpw5xqqw (S2) | dlg_3518d44e-ec97-47ab-a3b3-68e905840387, dlg_fe5377c3-312c-4908-98af-2086d6459e5c |
| failed attempts (parents refused tool calls) | thr_ebrfk7v2r9, thr_xeexdup3vm, thr_4zxn78r3be | none | - |
| B2/B3 (see notes) | thr_ga9hjtintx, thr_2n7t69m2bm | thr_4sxrv4995g, thr_76i4j4vtkb | dlg_ce486a44-..., dlg_d5a11b02-... |

## Run A: steer reaches a running child
- A1: sandy_delegate_send steer returned {ok, status:"delivered", readmitted:false, sandyDelivery:"sent"}. Child events: seq 9 client/turn/requested source tell, target {kind:"steer", expectedTurnId}, accepted seq 11 in the running turn (1793116136724 -> 136738). The scout ignored the steer text (finished its single read), but the steer was accepted into the live turn.
- A2: target kind "auto", accepted into the running turn (seq 22). The child answered "Hello. I haven't run the sleep 70 task..." => the steer visibly changed the child's behaviour.
- The ledger rows went active -> idle (sandy delegate list) after each child's turn completed: the new active->idle transition works through the watchdog sweep. Rows from earlier slices' runs also flipped to idle.

## Run A3: parent stop leaves the child running
- Parent thr_57ydz7qx6q was in sandy_delegate_wait; "sandy thread stop thr_57ydz7qx6q" at 15:51:03Z -> "Thread ... stopped". At 15:51:34Z and 15:51:52Z the child thread was still active (parentNotifications auto), ledger state active, STOP column "-", no stop request. The child finished its sleep and the ledger went idle by 15:52:20Z. Nothing in the plugin cascades a parent stop.

## Run B: queue when the root is full, delivered FIFO after a slot frees
(maxConcurrentChildren 1.) Two tries (B2, B3) showed the SANDY-side race: a scout that has just answered still holds its slot until the next watchdog sweep, so a sandy_delegate immediately after was refused with limit_reached (existing behaviour) and the following queue send went straight through (delivered, readmitted true in B3 because the slot was free by then). Run B6 with the child known idle in the ledger:
- B (scout, thr_qzqv4tmqmr) finished "done B", ledger idle. A (implementer-low sleep 50) spawned, active, taking the only slot.
- sandy_delegate_send B mode queue -> {ok:true, status:"queued", inputId:"inp_8849d122-...", message:"the child is idle and the root's slots are full; the input is delivered when a slot frees"}.
- A finished (turn/completed 1793116788437, ledger A idle at 15:59:58); B's ledger row went active and B received client/turn/requested source tell target new-turn "queue-probe-6: reply with exactly: second B" at 1793116793554 (5 s later, the next sweep), replied "second B" and completed at 1793116796277; ledger B idle again. The queued input was delivered once, after the slot was freed by the idle transition.

## Run C: stop and negatives (parent thr_bqmbbcapza)
- sandy_delegate_send / sandy_delegate_stop with another parent's delegation (dlg_2d37461e-...) -> {ok:false, code:"not_parent", message:"delegation ... was not started by this thread"}. The other parent's ledger row (idle, STOP "-") and its child thread are unchanged (no "intruder" in the child's events).
- Unknown id dlg_00000000-0000-4000-8000-000000000000, send and stop -> {ok:false, code:"unknown_delegation"}.
- Stop one: S1 (sleep 120) -> {ok:true, stopped:[{state:"stopped", stopConfirmed:true}]}; ledger row stopped, SANDY thread idle.
- Stop all ({all:true}) with S2 running plus the idle B and A children of this parent -> stopped three delegations, all stopConfirmed:true. Ledger rows stopped, S2's SANDY thread idle.
- Delegate callers: the plugin offers children only sandy_delegate_brief (delegateToolsFor), so a delegate cannot see send/stop; the refusal for a delegate caller is covered in tests/control.test.ts only.

## Restore
- sandy plugin config delegate set maxConcurrentChildren 4 (verified 4); sandy plugin build . && sandy plugin install <this worktree>/sandy/delegate --yes; plugin running, watchdog service running.
- All threads above archived (sandy thread archive; related child threads archived with their parent).

## Fix round (Sol's review, 6 findings): live rerun
Date 2026-10-27 (UTC 17:21-17:25). Same project, haiku-5-5 pi parent (visible, "[delegate-test]"), plugin rebuilt and reinstalled from this worktree; migration #10 applied on the live DB (delegation_deliveries present, existing pending_inputs copied). maxConcurrentChildren 1 for the run, restored to 4 afterwards. Nothing ran under thr_6vthb5nb84.

| Role | Thread | Delegation |
|---|---|---|
| parent | thr_rr4886fz5i | - |
| B (scout, "done B") | thr_cvsa2k5rcy | dlg_a5e34248-887b-4247-8f26-2f1a250112fc |
| A (implementer-low, sleep 50) | thr_efbxtungg9 | dlg_48f1058e-f833-4a75-9cde-ac6a41777667 |

### (a) queue to an idle child while another runs (1 slot)
- B ran "done B" (turn seq 5-21), ledger idle. A spawned async (takes the only slot), then sandy_delegate_send B mode queue -> {ok:true, status:"queued", inputId:"inp_701462f1-ab2a-4572-9175-ee82f25e4724"}.
- A's turn completed at 1793121765728 (seq 37); the next sweep freed its slot (A idle) and the drain delivered the input at 1793121769989 (17:22:49Z): delegation_deliveries dlv_137e50bb-... state sent, generation 1, after_seq 21 (the watermark), reservation_owner rsv_e6375e95-...; input delivered; B active, delivery_generation 2.
- B's events: exactly one client/turn/requested (seq 22, source tell) after its first turn, turn 23-35 completed, output "second B"; ledger B back to idle. Delivered once.

### (b) send, then an immediate stop
- One parent codemode script, no pause: sandy_delegate_send B mode queue ("stop-probe-fix: run sleep 30 ...") -> {status:"delivered", readmitted:true, sandyDelivery:"sent"}; then sandy_delegate_stop B -> {state:"stopped", stopConfirmed:true}. Both inside 0.6 s.
- The send reached SANDY before the stop (the per-delegation lock orders them): delivery dlv_652cdbc5-... sent at 1793121804823, B client/turn/requested seq 36, turn/started seq 38, turn/completed seq 40 status "interrupted" (1793121805357). Stop request parent_stop, stopped_at 1793121804977, 1 attempt.
- 50 s later (17:24:23Z): no event after seq 40, SANDY status idle, ledger stopped, delivery_generation 4. The child stayed stopped.

### Restore
- sandy plugin config delegate set maxConcurrentChildren 4 (verified 4).
- Threads listed above archived (sandy thread archive; archivedAt set on all three).

