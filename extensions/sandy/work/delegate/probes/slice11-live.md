# Slice 11 live evidence: questions

Date: 2026-10-27, UTC 18:19 to 18:26. Project proj_ktxba3f8zg. The parents are haiku-5-5 pi threads, visible, with "[delegate-test]" titles. The plugin was built and installed from this worktree with `sandy plugin build . && sandy plugin install <worktree>/sandy/delegate --yes`. pi-extension and shared were unchanged, so `npm run gen` was not needed. Migration #11 (questions.form_id, questions.answer_source) was applied to the live DB. maxConcurrentChildren stayed at 4 for the whole run. Nothing ran under thr_6vthb5nb84. The parent prompts are /tmp/sandy-delegate-live/parent-11a.txt and parent-11b.txt. DB rows were read with /tmp/sandy-delegate-live/q.mjs (better-sqlite3, read-only).

## Threads (all archived afterwards)
| Run | Parent | Child | Delegation | Question |
|---|---|---|---|---|
| failed attempt: the parent invoked the tool alias directly, so no tool ran | thr_vsr3dt9hy8 | none | - | - |
| A: answer via sandy_delegate_send | thr_nhy2gkx34w | thr_rqf6eyq8j4 (scout) | dlg_31004715-34fd-4a17-be08-6c915fbd0e04 | qst_528dd313-496d-48ef-97b1-10262de2c03d |
| B: reinstall with the form open, re-ask, interactions respond | thr_uwtwpcqgay | thr_g5nugg7igh (scout) | dlg_e5b4b266-6770-4337-82cd-62cd209ac9ef | qst_f213c304-7652-4a2d-9f5b-8b4b82c32bb0 |

## Run A: the parent answers with sandy_delegate_send, and the answer arrives once
- Child seq 16-18: the child calls sandy_ask_parent. At seq 17 the interaction pint_9f9qrngq9j (renderer "question") is pending. At seq 18 the call detaches with SANDY's waiting notice. The child's turn completes at seq 28 and the ledger goes idle.
- The parent's sandy_delegate_status showed `question: {questionId: qst_528dd313-..., state: "open", options: ["PELICAN","HERON"], askedAt 1793125284879, expiresAt 1793730084879}`. expiresAt minus askedAt is 7 days.
- The parent's sandy_delegate_send (mode queue, "PELICAN") returned `{ok:true, status:"answered", questionId:"qst_528dd313-...", delivery:"delivered"}`.
- DB after the send:
  - questions: state delivered, answer_source parent_send, answered_at 1793125390269, delivered_at 1793125390283.
  - pending_inputs: one row inp_d36d2253-... with kind answer, state delivered.
  - delegation_deliveries: one row dlv_e811733a-..., state sent, generation 1. It went through admission: reservation rsv_433145c5-..., after_seq 28.
- Child seq 29: the form is closed by the plugin (interrupted, request-aborted).
- Child seq 30 is the only client/turn/requested after the ask. It is SANDY's "Your earlier sandy_ask_parent tool call has finished. Its result: answer to question qst_528dd313-...: PELICAN". The waiting call received the answer, so the plugin sent no pointer message.
- Child seq 38: "code word: PELICAN". Nothing else was delivered.
- Side observation: the parent's sandy_delegate_wait returned the child's first turn's result, the "waiting for the answer" message. The wait had already ended when the answered turn started. This is existing wait behaviour and was not changed in this slice.

## Run B: plugin reinstall with the form open, re-ask, answer via `sandy thread interactions respond`, arrives once
- Child seq 16-24: sandy_ask_parent opens pint_zdbrbg56fh and detaches. The question row is open with form frm_96a78a98-.... The model passed options as one JSON string, `["[\"OSPREY\", \"EGRET\"]"]`. The schema accepts that, so it is a model quirk and not a plugin bug.
- At 18:25:05 the plugin was reinstalled with `sandy plugin install ... --yes`.
- Child seq 25: pint_zdbrbg56fh is interrupted (request-aborted) by the reload.
- Plugin log at 1793125506069: "watchdog: question qst_f213c304-... re-asked (its form was gone)". This is the startup sweep.
- Child seq 26: a new interaction pint_p7yc5phfz8 is pending with the same questionId. The row is still open, now with form_id frm_a7156946-....
- I ran `sandy thread interactions respond pint_p7yc5phfz8 thr_g5nugg7igh --value '{"answer":"OSPREY"}'`. It returned status resolved (child seq 27, plugin_submitted).
- Nothing was waiting for the answer, because the original call was gone after the reload. So the answer went through admission as the pointer:
  - pending_inputs inp_02d0c3a6-..., kind answer, state delivered;
  - delegation_deliveries dlv_e56d9066-..., state sent, reservation rsv_b65983b3-..., after_seq 24.
- Child seq 28 is the only client/turn/requested after the ask: "answer to question qst_f213c304-... is ready, call sandy_question_answer(qst_f213c304-...)".
- Child seq 34: sandy_question_answer returns "answer to question qst_f213c304-...: OSPREY". The row moves answered to delivered (delivered_at 1793125527518, answer_source form).
- Child seq 40: a second sandy_question_answer with the same id returns "already delivered: answer to question qst_f213c304-...: OSPREY".
- Child seq 47: "code word: OSPREY". The answer was consumed once.

## Not run live (unit tests only, tests/questions.test.ts)
- Full root (maxConcurrentChildren 1, another child running): the answer stays queued until a slot frees.
- The 25-minute answer and the 7-day expiry. Both use fake clocks.
- Two answers at once, a stale form's late result, and a duplicated pointer after a reload right after the answer.

## Restore
- maxConcurrentChildren = 4, checked with `sandy plugin config delegate`. The installed plugin is the current worktree build, and the watchdog service is running.
- Archived: thr_vsr3dt9hy8, thr_nhy2gkx34w (with thr_rqf6eyq8j4), and thr_uwtwpcqgay (with thr_g5nugg7igh).
