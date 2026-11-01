# Slice 4b live evidence: brief watchdog (sandy 0.47.1, plugin SDK 0.6.79), 2026-10-27

Setup (this host only):
- Plugin rebuilt and reinstalled from path: `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`. `sandy plugin list` then showed `delegate@0.1.0 running` with `service watchdog: running`.
- Window: `sandy plugin config delegate set briefWatchdogSeconds 20` (it was 120 before).
- No other delegate children were running. `sandy delegate list` showed only the 5 slice-4 rows, and every one of their threads was archived and idle.
- pi extension moved aside: `mv ~/.pi/agent/extensions/sandy-delegate /tmp/sandy-delegate-ext-aside`. Afterwards `ls ~/.pi/agent/extensions/ | grep -c sandy-delegate` printed 0.
- Project `proj_ktxba3f8zg` (/tmp/sandy-delegate-live/repo). Throwaway visible parent spawned at 10:54:48Z:
  `sandy thread spawn --project proj_ktxba3f8zg --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --title "[delegate-test] parent watchdog" --visibility visible --prompt-file /tmp/sandy-delegate-live/parent-4b.txt`.
  The prompt asks for one sandy_delegate call (agent scout, async, title "[delegate-test] scout watchdog").

Thread ids:
| thread | role | delegation |
|---|---|---|
| thr_wdydtkviwg | parent (env_2p8t9u23w8, worktree branch sandy/delegate-test-parent-watchdog-thr_wdydtkviwg) | |
| thr_wpke9rdyr3 | scout child, hidden, without the pi extension | dlg_43046586-e063-4904-b683-9679199f6412 |

## Spawn
The parent's sandy_delegate result:
```json
{"ok":true,"delegationId":"dlg_43046586-e063-4904-b683-9679199f6412","threadId":"thr_wpke9rdyr3","agent":"scout","agentVersion":1,"status":"starting","model":"anthropic/claude-haiku-5-5","thinking":"medium","reasoningLevel":"medium","permissionMode":"full","workspace":"parent","reused":false}
```

## No ack, so the brief is withheld
Without the extension the child never asked for a policy or acked one. Its log (`sandy thread log thr_wpke9rdyr3 --format verbose --all`) shows sandy_delegate_brief called 3 times, each answered with `no_ack: no unused policy ack for this delegation; the brief is returned once per ack`. The child then ended its turn by itself (turn/completed at 1793098501634, 8.5 s after the bind) with the words "I could not get my brief, so I have not started the scout task."

## Refused and stopped within the window
`sandy delegate list --json`, polled every ~2.3 s:
```
10:54:52 [('dlg_43046586', 'starting', 'thr_wpke9rdyr3', None)]
...
10:55:14 [('dlg_43046586', 'starting', 'thr_wpke9rdyr3', None)]
10:55:16 [('dlg_43046586', 'refused', 'thr_wpke9rdyr3', None)]
... (refused until 10:56:01)
```
Ledger (plugin data.db, opened read-only):
- delegations: created_at 1793098493131, bound_at 1793098493182, state refused, updated_at 1793098514801. That is 21.6 s after the bind: the 20 s window plus at most one tick of 2 s.
- delegation_stops: `{child_thread_id: thr_wpke9rdyr3, reason: no_ack, requested_at: 1793098514801, stopped_at: 1793098514815, attempts: 1, last_error: null}`.
- delegation_acks: 0 rows. delegation_briefs.delivered_at: null. pending_inputs: none.

`sandy plugin logs delegate`:
```
{"ts":1793098514816,"level":"warn","message":"watchdog: dlg_43046586-e063-4904-b683-9679199f6412 (child thr_wpke9rdyr3) refused, no ack within 20000 ms"}
{"ts":1793098514816,"level":"info","message":"watchdog: stopped thr_wpke9rdyr3"}
```
`sandy delegate list`:
```
DELEGATION                                STATE    AGENT            PARENT          CHILD           MODEL                       REASONING  ACKED                     BRIEF      CREATED
dlg_43046586-e063-4904-b683-9679199f6412  refused  scout            thr_wdydtkviwg  thr_wpke9rdyr3  anthropic/claude-haiku-5-5  medium     no                        no         2026-10-27T10:54:53.131Z
```
`sandy thread show thr_wpke9rdyr3`: status idle, visibility hidden, parentThreadId thr_wdydtkviwg.

## After refused: no revival
- The child was told to call the brief again (`sandy thread tell thr_wpke9rdyr3 "Call sandy_delegate_brief once more ..."`; SANDY attributed the message to the shell's SANDY_THREAD_ID thr_6vthb5nb84, and no thread was created under it). Result: `not_a_delegate: this thread is not a running delegation`.
- `env -u SANDY_THREAD_ID sandy delegate policy --thread thr_wpke9rdyr3` returned `{"status":"denied","reason":"delegation dlg_43046586-… is refused","policy":{"snapshotHash":"deny-all","allowTools":[],"transportTools":[]},"nonce":null}`. So a refused row issues no new nonce to ack.
- `env -u SANDY_THREAD_ID sandy delegate ack --thread thr_wpke9rdyr3 --delegation dlg_43046586-… --hash 000… --nonce nonce_late --session pi-late` returned `nonce was not issued`. The row stayed `refused` and the brief stayed undelivered.
- Without `env -u SANDY_THREAD_ID` both CLI calls fail with `--thread differs from the calling thread`, because this shell runs inside thread thr_6vthb5nb84.

## Restore
- `mv /tmp/sandy-delegate-ext-aside ~/.pi/agent/extensions/sandy-delegate`. Then `diff -r ~/.pi/agent/extensions/sandy-delegate/index.ts pi-extension.ts && diff -r ~/.pi/agent/extensions/sandy-delegate/shared shared` printed nothing (clean).
- `sandy plugin config delegate set briefWatchdogSeconds 120` -> `briefWatchdogSeconds = 120`.
- `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes` -> `delegate@0.1.0 running`, `service watchdog: running`.
- `sandy thread archive thr_wpke9rdyr3` (archivedAt 1793098641322) and `sandy thread archive thr_wdydtkviwg` (archivedAt 1793098641547).

## Not verified live
- Stopping a child in the middle of a turn. This child had ended its own turn (8.5 s) before the window ran out, so SANDY's `threads.stop` hit an idle thread. It succeeded (stopped_at set, no error); SANDY's stop also releases the loaded runtime.
- A late ack carrying a valid nonce. Live, a refused row issues no nonce. The case where a nonce was issued before the deadline and acked after it is covered by tests/watchdog.test.ts (`ack_too_late`, then `delegation_ended`).
- Expired reservations (with and without a matching thread), a restart mid-window, and the spawn-vs-sweep race. These are covered only by tests/watchdog.test.ts.

# Fix round: a stop that interrupts a running turn, confirmed by status (2026-10-27)

Setup (same host and project as above):
- Migrations: this host had already applied the original #3 (`_sandy_migrations` id 2, sha256 `89d55f5c…b4f8`). #3 stays byte-identical, and the retry column `next_attempt_at` plus `delegation_stops_delegation_idx` are a new #4. On reinstall SANDY recorded id 3 (`29f9d6f2…f418`) without complaint, and `delegation_stops` now has `next_attempt_at`. The DB was not edited by hand.
- Temporary debug hook, only for this run: `sandy_delegate_brief` waited 45 s before it answered `no_ack`. This keeps the child's turn inside a running tool call when the window ends. `server/index.ts` was backed up to /tmp/index.ts.pre-hook before the hook went in and restored afterwards (see Restore).
- Plugin rebuilt and reinstalled with the hook. `briefWatchdogSeconds` set to 20. pi extension moved aside (`ls ~/.pi/agent/extensions/ | grep -c sandy-delegate` printed 0).
- Parent: `sandy thread spawn --project proj_ktxba3f8zg --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --title "[delegate-test] parent watchdog mid-turn" --visibility visible --prompt-file /tmp/sandy-delegate-live/parent-4b.txt`.

| thread | role | delegation |
|---|---|---|
| thr_hu5nn2exbj | parent | |
| thr_ic9y6y2atn | scout child, hidden, without the pi extension, originPluginId `delegate` | dlg_920c56af-e87d-424c-993a-cef60237929b |

## Running at expiry, then stopped and confirmed
Every ~1.3 s the probe polled `sandy delegate list --json` (state, child, `stop`) and `sandy thread show <child> --json` (status):
```
11:19:06.395 | dlg_920c56af… starting thr_ic9y6y2atn null | child status: starting
11:19:07.718 | dlg_920c56af… starting thr_ic9y6y2atn null | child status: active
... (active at every poll)
11:19:27.367 | dlg_920c56af… starting thr_ic9y6y2atn null | child status: active
11:19:28.672 | dlg_920c56af… refused thr_ic9y6y2atn {"threadId": "thr_ic9y6y2atn", "reason": "no_ack", "stoppedAt": 1793099968230, "attempts": 1, "lastError": null} | child status: idle
... (refused / stopped / idle until 11:19:34)
```
Ledger:
- delegations: created_at 1793099946657, bound_at 1793099946687, state refused, updated_at 1793099968230. That is 21.5 s after the bind.
- delegation_stops: `(thr_ic9y6y2atn, dlg_920c56af…, no_ack, requested_at 1793099968230, stopped_at 1793099968230, attempts 1, last_error NULL, next_attempt_at NULL)`. The sweep called `threads.stop` and then read the thread back with `threads.get`. The status was already `idle`, so the request was closed in the same pass. `stopping` was never observed, so no retry was needed.
- delegation_acks: 0 rows. delegation_briefs.delivered_at: null.

`sandy plugin logs delegate`:
```
{"ts":1793099968280,"level":"warn","message":"watchdog: dlg_920c56af-e87d-424c-993a-cef60237929b (child thr_ic9y6y2atn) refused, no ack within 20000 ms"}
{"ts":1793099968280,"level":"info","message":"watchdog: stopped thr_ic9y6y2atn"}
```
`sandy thread log thr_ic9y6y2atn --format verbose --all`: the stop interrupted the turn in the middle of the brief call:
```
── Worked for (21s) ──
  ── Ran 2 tools
    ── Ran tool codemode { code: return await tools.sandy_delegate_brief(... } (19s, interrupted)
    ── Ran tool sandy_delegate_brief (19s, interrupted)
── Stopped manually ──
```
After the stop, `sandy thread show thr_ic9y6y2atn` showed status idle, hidden, parentThreadId thr_hu5nn2exbj, originPluginId delegate.

The plugin's handler still ran to its 45 s end on the server side: `sandy plugin list` showed `45.0s max`. Its late `no_ack` answer went nowhere, because the turn had already ended.

`sandy delegate list` (new STOP column):
```
DELEGATION                                STATE    AGENT  PARENT          CHILD           MODEL                       REASONING  ACKED  BRIEF  STOP     CREATED
dlg_920c56af-e87d-424c-993a-cef60237929b  refused  scout  thr_hu5nn2exbj  thr_ic9y6y2atn  anthropic/claude-haiku-5-5  medium     no     no     stopped  2026-10-27T11:19:06.657Z
```

## Restore
- `cp /tmp/index.ts.pre-hook server/index.ts`, then `diff` printed nothing. No `TEMP live-probe` remains in server/ or dist/server.js.
- `sandy plugin config delegate set briefWatchdogSeconds 120` printed `briefWatchdogSeconds = 120`.
- `mv /tmp/sandy-delegate-ext-aside ~/.pi/agent/extensions/sandy-delegate`. Both diffs printed nothing: `diff ~/.pi/agent/extensions/sandy-delegate/index.ts pi-extension.ts` and `diff -r ~/.pi/agent/extensions/sandy-delegate/shared shared`.
- `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`. `sandy plugin list` then showed `delegate@0.1.0 running` with `service watchdog: running`.
- `sandy thread archive thr_ic9y6y2atn` (archivedAt 1793100002595) and `sandy thread archive thr_hu5nn2exbj` (archivedAt 1793100002835).

## Not verified live
- A stop that resolves while the thread is still `stopping`, and the retry with backoff that follows. SANDY's stop had settled before the status read. This is covered by tests/watchdog.test.ts.
- Stop failures and retries across a plugin restart, the STOP column showing `pending (n attempts: …)`, and a refused row holding its slot while the stop is open. These are covered by tests/watchdog.test.ts.
- Reservation reconciliation: proven spawn, copied metadata, ambiguous candidates, an omitted parent, and a deferred spawn. These are covered by tests/watchdog.test.ts and tests/sandy-host.test.ts.
