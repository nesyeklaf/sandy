# Slice 6 live evidence: enforcement on resume (sandy 0.47.1), 2026-10-27

Setup (this host only):
- Migration #6 (`ALTER TABLE delegation_acks ADD COLUMN turn INTEGER`) applied: `_sandy_migrations` shows id 5 (the sixth entry) at 1793103054230.
- First install failed the turn rule on every bound child: `watchdog: thr_…: HTTP 400: Thread event limit cannot exceed 100` (the turn listing asked for pages of 500). Page size set to 100 (sandy-host.ts), plugin rebuilt and reinstalled: `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`. From then on no watchdog errors; `sandy plugin list` showed `delegate@0.1.0 running`, `service watchdog: running`. The 8 older active test delegations (all idle, single-turn) were not refused.
- pi extension at ~/.pi/agent/extensions/sandy-delegate: index.ts = pi-extension.ts, shared/policy.ts = shared/policy.ts (`diff` clean).
- Project `proj_ktxba3f8zg`. Parent spawned with `env -u SANDY_THREAD_ID sandy thread spawn --project proj_ktxba3f8zg --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --title "[delegate-test] parent slice6 resume" --visibility visible --prompt-file /tmp/sandy-delegate-live/parent-6.txt --json` (one sandy_delegate call, agent scout, async).
- Follow-ups: `sandy thread send <child> "<message>" --mode auto`. Release: `sandy pi-lifecycle restart <child>` (prints `restarted`; afterwards `sandy pi-lifecycle status` lists no pi process for the child). The idle-timeout fallback was not needed: idleProviderSessionTimeoutMinutes stayed 30 throughout (`sandy settings show --json` → `generalSettings.idleProviderSessionTimeoutMinutes 30`).
- Turn times: `sandy thread log <child> --format json --all` (turn/started, turn/completed). Ack times: plugin data.db, read-only. Scripts: /tmp/sandy-delegate-live/live6.sh, live6b.sh, order6.py; logs live6.log, live6b.log.

Thread ids:
| thread | role | delegation |
|---|---|---|
| thr_dfnytgicx6 | parent ("[delegate-test] parent slice6 resume") | |
| thr_v5msvv7ag5 | scout child ("[delegate-test] scout resume") | dlg_29526653-9011-4b96-baa7-a2bac29c8122 |

## Run A: 3 follow-ups in the retained session, then 3 resumes after release (extension installed, window 120 s)
Every turn fetched a fresh policy (its own nonce, `policy issued`) and acked it before SANDY's turn/started; the ack is the one recorded after the previous turn/completed. Ack column: pi session id and the turn counter the extension sent.

| # | turn | turn/started (seq, ms) | prev turn/completed | ack: pi session, turn | policy issued | ack recorded | ack - turn/started | turn/completed |
|---|---|---|---|---|---|---|---|---|
| 1 | first turn (spawn) | 5, 1793103169728 | None | 01a17d47-044c-7631-95cc-8456c1f81a68, 1 | 1793103169329 | 1793103169669 | -59 ms | 1793103175017 |
| 2 | retained follow-up 1 (asks for sandy_delegate_brief) | 28, 1793103177508 | 1793103175017 | 01a17d47-044c-7631-95cc-8456c1f81a68, 2 | 1793103177129 | 1793103177455 | -53 ms | 1793103182329 |
| 3 | retained follow-up 2 | 47, 1793103185645 | 1793103182329 | 01a17d47-044c-7631-95cc-8456c1f81a68, 3 | 1793103185274 | 1793103185599 | -46 ms | 1793103187028 |
| 4 | retained follow-up 3 | 56, 1793103189216 | 1793103187028 | 01a17d47-044c-7631-95cc-8456c1f81a68, 4 | 1793103188844 | 1793103189169 | -47 ms | 1793103191178 |
| 5 | resume 1 after `pi-lifecycle restart` (asks for sandy_delegate_brief) | 67, 1793103197563 | 1793103191178 | 01a17d47-044c-7631-95cc-8456c1f81a68, 1 | 1793103197175 | 1793103197515 | -48 ms | 1793103202548 |
| 6 | resume 2 after restart | 88, 1793103209794 | 1793103202548 | 01a17d47-044c-7631-95cc-8456c1f81a68, 1 | 1793103209416 | 1793103209739 | -55 ms | 1793103211304 |
| 7 | resume 3 after restart | 99, 1793103217609 | 1793103211304 | 01a17d47-044c-7631-95cc-8456c1f81a68, 1 | 1793103217204 | 1793103217555 | -54 ms | 1793103219182 |

- All 7 turns gated and acked; none refused. After the run: delegation `active`, `delegation_stops` empty.
- Release is visible: after each restart `sandy pi-lifecycle status` listed 0 pi processes for the child; each resume has its own `thread/identity` + `provider.env-resolved` events (4 in total = spawn + 3 resumes); the extension's turn counter restarted at 1.
- The pi session id stays the same across restarts (`01a17d47-…`): SANDY reopens the same pi session file in the new process. So on this host a resume is a new pi process with the same session id; the "new pi session" case of the contract does not occur via restart, but every resume still fetched a fresh nonce before its ack.
- Brief: delivered once, at turn 1 (`delegation_briefs.delivered_at` 1793103171506; tool call seq 11 returned "# Role (scout) … # Task ([delegate-test] scout resume) …"). Retained follow-up 1 (seq 36, 1793103180919) and resume 1 (seq 76, 1793103201039) called sandy_delegate_brief and got `already_delivered: your role and task were delivered earlier in this conversation; they are not sent again. Continue from them and the latest message.` (tool status failed), no task text.
- The live6.sh progress labels for the resumes are wrong (`resume 3 done`, `resume 1 done`, …): wait_idle reused the loop variable. The actions were 3 restarts with 3 messages, as the table shows.

## Run B: extension moved aside, window 20 s → resumed child stopped and refused
- `sandy plugin config delegate set briefWatchdogSeconds 20` (was 120). No other delegate child running: the 9 bound live children were all `idle`.
- `mv ~/.pi/agent/extensions/sandy-delegate /tmp/sandy-delegate-ext-aside`; `ls ~/.pi/agent/extensions/ | grep -c sandy-delegate` → 0.
- Same child (thr_v5msvv7ag5): `sandy pi-lifecycle restart` → `restarted`, 0 pi processes; then a message asking for a 3000-word essay (a turn longer than the window).

```
client/turn/requested  seq 107  1793103291348
turn/started           seq 110  1793103292247   (new pi process without the extension: no policy, no ack)
stop requested         1793103312952   reason turn_no_ack   (+20.705 s)
stop confirmed         1793103312952   attempts 1
turn/completed         seq 389  1793103313019   status interrupted   (+20.772 s)
plugin log 1793103313078  warn  watchdog: dlg_29526653-9011-4b96-baa7-a2bac29c8122 (child thr_v5msvv7ag5) refused, its turn (turn/started seq 110) had no ack within 20000 ms
plugin log 1793103313078  info  watchdog: stopped thr_v5msvv7ag5
```
- Poll (every ~1.9 s): `status=active row=active` until 12:15:12.862, then `status=idle row=refused stop=turn_no_ack`; acks stayed at 7 (none for this turn).
- Delay turn/started → stop: 20.7 s with a 20 s window (window + sweep tick of 2 s at most).

## Not covered live
- A resume in a genuinely different pi session id (SANDY kept the session id across restart). Covered by the unit tests ("released resume … new pi session", watchdog "resumes after release (new pi session each)").
- A retained turn without an ack while the extension is loaded (load failure): unit test "a retained turn whose policy load fails keeps the earlier policy and sends no ack" plus the watchdog no-ack test.

## Restore
- `mv /tmp/sandy-delegate-ext-aside ~/.pi/agent/extensions/sandy-delegate`; `ls … | grep -c sandy-delegate` → 1; `diff ~/.pi/agent/extensions/sandy-delegate/index.ts pi-extension.ts && diff -r ~/.pi/agent/extensions/sandy-delegate/shared shared` → clean.
- `sandy plugin config delegate set briefWatchdogSeconds 120`; `sandy plugin config delegate` → `maxConcurrentChildren = 4`, `waitCeilingMs = 270000`, `briefWatchdogSeconds = 120`, `questionTimeoutDays = 7`.
- idleProviderSessionTimeoutMinutes: never changed, 30 before and after.
- Archived (`sandy thread archive`), archivedAt from `sandy thread show`, both idle: thr_v5msvv7ag5 1793103466302, thr_dfnytgicx6 1793103466541.
- Plugin rebuilt and reinstalled from the final tree: `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`; `sandy plugin list` → `delegate@0.1.0 running`, `service watchdog: running`; `sandy plugin logs delegate` → `watchdog: startup reconciliation done` at 1793103513971. 106 unit tests pass on that tree.

## Round 2 (after review): one ack per turn, legacy baseline, bounded turn scan

Migration #7 (`delegation_acks.turn_seq`, `delegation_turn_cursors`) applied by the reinstall at 2026-10-27T12:39:01Z (`sandy plugin build . && sandy plugin install … --yes`); `_sandy_migrations` ids 0-6.

### Upgrade: the delegations already in the live DB
Before the reinstall: 15 bound rows, 9 active (6 refused). The 9 active children, all idle and archived in SANDY (`sandy thread log` turn events, acks from the ledger):

| child | turns started/completed | newest turn event seq | acks | after upgrade: state, enforce_from_seq = checked_seq |
|---|---|---|---|---|
| thr_qvjxq2wtxm | 1/1 | 51 | 1 | active, 51 |
| thr_7aff8m3fnh | 1/1 | 42 | 1 | active, 42 |
| thr_e4ejqc24jq | 1/1 | 57 | 1 | active, 57 |
| thr_vbnc3ssren | 1/1 | 57 | 1 | active, 57 |
| thr_37a6zfhzcw | 1/1 | 34 | 1 | active, 34 |
| thr_hhhyy53bbk | 1/1 | 27 | 1 | active, 27 |
| thr_zvzuyi4rpx | 1/1 | 39 | 1 | active, 39 |
| thr_4je7nkxgjv | 1/1 | 29 | 1 | active, 29 |
| thr_nqajn57gu5 | 3/3 | 74 | 3 | active, 74 |

The first sweep (scanned_at 1793104762580) baselined all 9 (baseline_pending 0, no open turn); none refused, no stop requested, still active at the end of the runs below. None of them has more turns than acks, so the "legacy multi-turn" case is covered by the unit test `upgrade (#7): a child bound before it with several retained turns acked once …`, not live.

### Run A2: 3 follow-ups in the retained session, then 3 resumes after `sandy pi-lifecycle restart` (window 120 s)
Script /tmp/sandy-delegate-live/live6r2.sh. Parent thr_4mbs9vt4nr, child thr_fbvtxt8z5r, dlg_010412c4-c8c8-4bed-9e15-cb562432cea4; `loaded pi for child: 0` after each restart. Every ack carries the turn/started seq it was matched to (`delegation_acks.turn_seq`):

| # | turn/started (seq, ms) | prev turn/completed | ack: pi session, turn | ack recorded | ack - turn/started | ack turn_seq | turn/completed |
|---|---|---|---|---|---|---|---|
| 1 | 5, 1793104779537 | - | 01a17d5f-…, 1 | 1793104779480 | -57 ms | 5 | 1793104786710 |
| 2 | 25, 1793104789900 | 1793104786710 | 01a17d5f-…, 2 | 1793104789853 | -47 ms | 25 | 1793104795583 |
| 3 | 44, 1793104798010 | 1793104795583 | 01a17d5f-…, 3 | 1793104797966 | -44 ms | 44 | 1793104800187 |
| 4 | 53, 1793104801753 | 1793104800187 | 01a17d5f-…, 4 | 1793104801693 | -60 ms | 53 | 1793104803655 |
| 5 (restart) | 64, 1793104810266 | 1793104803655 | 01a17d5f-…, 1 | 1793104810209 | -57 ms | 64 | 1793104815139 |
| 6 (restart) | 85, 1793104822441 | 1793104815139 | 01a17d5f-…, 1 | 1793104822392 | -49 ms | 85 | 1793104824297 |
| 7 (restart) | 96, 1793104830327 | 1793104824297 | 01a17d5f-…, 1 | 1793104830268 | -59 ms | 96 | 1793104831926 |

Result: state active, no stop rows, cursor checked_seq 103 with no open turn. Brief delivered once (delivered_at 1793104782990, tool result at seq 11); the sandy_delegate_brief calls in follow-up 1 (seq 33) and resume 1 (seq 73) returned `already_delivered: …`.

### Run B2: extension moved aside, window 20 s → resumed child stopped and refused
`sandy plugin config delegate set briefWatchdogSeconds 20`; no other delegate child starting or reserved; `mv ~/.pi/agent/extensions/sandy-delegate /tmp/sandy-delegate-ext-aside` (count 0); script live6br2.sh (live6b.sh on thr_fbvtxt8z5r): restart (`loaded pi for child: 0`), send.
- turn/started seq 107 at 1793104872484; no ack (7 acks before and after).
- Stop requested and confirmed at 1793104894281 (`delegation_stops`: turn_no_ack, attempts 1); turn/completed `interrupted` seq 402 at 1793104894303; row refused.
- Plugin log 1793104894327 warn: `dlg_010412c4-… (child thr_fbvtxt8z5r) refused, its turn (turn/started seq 107) had no ack within 20000 ms`, then `stopped thr_fbvtxt8z5r`.
- Delay turn/started → stop: 21.8 s with a 20 s window (window + up to one 2 s tick + sweep).

### Restore (round 2)
- `mv /tmp/sandy-delegate-ext-aside ~/.pi/agent/extensions/sandy-delegate`; count 1; `diff ~/.pi/agent/extensions/sandy-delegate/index.ts pi-extension.ts && diff -r ~/.pi/agent/extensions/sandy-delegate/shared shared` → clean.
- `sandy plugin config delegate set briefWatchdogSeconds 120` → `briefWatchdogSeconds = 120`.
- idleProviderSessionTimeoutMinutes: never changed, 30 (`sandy settings show --json`).
- Archived (`sandy thread archive`): thr_fbvtxt8z5r (archivedAt 1793104957295), thr_4mbs9vt4nr (1793104957860), both idle.
- The installed plugin is the final tree (no source change after the 12:39:01Z reinstall; 118 unit tests pass on it); `sandy plugin list` → `delegate@0.1.0 running`, `service watchdog: running`.
