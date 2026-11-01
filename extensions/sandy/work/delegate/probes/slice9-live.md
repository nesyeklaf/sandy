# Slice 9 live evidence: sandy_delegate_status (sandy 0.47.1), 2026-10-27

## How this was run (and what it is not)
The plugin was **not** reinstalled from this worktree (the installed plugin stays on /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate, so the installed `sandy_delegate_status` tool does not exist yet). The status logic ran from this worktree through `probes/slice9-live-run.ts`: it calls `statusFor` (server/status.ts) with the real `statusHost` adapter from server/sandy-host.ts, over a **SandyHostApi shim built on the `sandy` CLI** (the plugin SDK only exists inside the plugin host): threads.get = `sandy thread show --json`, events.list = `sandy thread log --json --all` filtered/sorted/limited like SANDY's list, defaultExecutionOptions = the execution block of the newest `client/turn/requested` event. The ledger is a throwaway in-memory DB with one delegation per child, bound to the real thread ids. So the SANDY side (real thread states, real event data: tokenUsage, contextWindowUsage, turn/*, system/error) is live; the SDK call plumbing is covered only by the fake in tests/sandy-host.test.ts. Run again with:
`node --experimental-strip-types probes/slice9-live-run.ts <parent> <finished> <running> <failed>`.

Project proj_ktxba3f8zg, provider pi, all titled "[delegate-test] s9 …":
| thread | role |
|---|---|
| thr_r3v44eurw8 | throwaway parent ("Reply exactly: parent ok") |
| thr_xh9d9n9jpy | finished child ("Reply exactly: done 42") |
| thr_cc44ebsmfi | running child (`sleep 280` through bash; stopped and archived after the run) |
| thr_dqppstm454 | failed child: first turn "first ok", then `sandy thread tell thr_dqppstm454 --model bogus/not-a-model "hi again"` → SANDY `client/turn/rejected` "Failed to resolve Pi model" + `system/error`, thread status `error` |
All four archived afterwards (`sandy thread archive`), verified archivedAt set.

## What it shows
- finished: threadStatus idle, status completed, tokens total 29787 / context 29787 / window 1000000, lastTurnMs 1928, error null.
- running: threadStatus active, status running, **tokens all null** (no tokenUsage / contextWindowUsage event until the first turn ends), lastTurnRunning true, lastTurnMs counts up to now (57862 → 62433 between two calls), stale false.
- failed: threadStatus error, status error, error = SANDY's own message `Failed to resolve Pi model "bogus/not-a-model"` (from the newest system/error; there is no failed turn/completed for this kind of failure, same as the env incident in RESULTS-sandy-0.47.1.md), model reported by SANDY is the rejected `bogus/not-a-model` (the model the thread was last asked to run), tokens from the earlier good turn.
- Refusals: another parent's delegation id → `not_your_delegation`; unknown id → same code and message shape; a bound child as caller → `child_caller`.
- `sandy delegate list` table gained STATUS / TOKENS / CONTEXT / TURN / ERROR; unknown tokens print — .
- Not exercised live: stale (needs an active thread silent for 10 min; unit-tested only), a real (non-shim) SDK call, the stop field (ledger-only, unit-tested), the CLI path of `sandy delegate list --json` inside the plugin host.

## Raw output of probes/slice9-live-run.ts
```
## sandy_delegate_status() from the parent
{
  "ok": true,
  "delegations": [
    {
      "delegationId": "dlg_66bd306f-0dc7-43ac-bf6d-a99a58b19d87",
      "threadId": "thr_dqppstm454",
      "agent": "scout",
      "agentVersion": 1,
      "state": "starting",
      "threadStatus": "error",
      "status": "error",
      "model": "bogus/not-a-model",
      "thinking": "medium",
      "reasoningLevel": "medium",
      "tokens": {
        "total": 29783,
        "context": 29783,
        "contextWindow": 1000000
      },
      "runtime": {
        "sinceBoundMs": 58657,
        "lastTurnMs": 1491,
        "lastTurnRunning": false
      },
      "lastActivityAt": 1793115819460,
      "stale": false,
      "error": "Failed to resolve Pi model \"bogus/not-a-model\"",
      "stop": null,
      "question": null
    },
    {
      "delegationId": "dlg_34638672-74b5-41d6-b20a-0443b4eab484",
      "threadId": "thr_cc44ebsmfi",
      "agent": "scout",
      "agentVersion": 1,
      "state": "starting",
      "threadStatus": "active",
      "status": "running",
      "model": "anthropic/claude-haiku-5-5",
      "thinking": "medium",
      "reasoningLevel": "medium",
      "tokens": {
        "total": null,
        "context": null,
        "contextWindow": null
      },
      "runtime": {
        "sinceBoundMs": 59367,
        "lastTurnMs": 57862,
        "lastTurnRunning": true
      },
      "lastActivityAt": 1793115794092,
      "stale": false,
      "error": null,
      "stop": null,
      "question": null
    },
    {
      "delegationId": "dlg_8173af0d-0535-48a4-9c09-dce08f2fa19a",
      "threadId": "thr_xh9d9n9jpy",
      "agent": "scout",
      "agentVersion": 1,
      "state": "starting",
      "threadStatus": "idle",
      "status": "completed",
      "model": "anthropic/claude-haiku-5-5",
      "thinking": "medium",
      "reasoningLevel": "medium",
      "tokens": {
        "total": 29787,
        "context": 29787,
        "contextWindow": 1000000
      },
      "runtime": {
        "sinceBoundMs": 60060,
        "lastTurnMs": 1928,
        "lastTurnRunning": false
      },
      "lastActivityAt": 1793115793379,
      "stale": false,
      "error": null,
      "stop": null,
      "question": null
    }
  ],
  "staleAfterMs": 600000,
  "truncated": false
}
## sandy_delegate_status({delegationId}) for the running child
{
  "ok": true,
  "delegations": [
    {
      "delegationId": "dlg_34638672-74b5-41d6-b20a-0443b4eab484",
      "threadId": "thr_cc44ebsmfi",
      "agent": "scout",
      "agentVersion": 1,
      "state": "starting",
      "threadStatus": "active",
      "status": "running",
      "model": "anthropic/claude-haiku-5-5",
      "thinking": "medium",
      "reasoningLevel": "medium",
      "tokens": {
        "total": null,
        "context": null,
        "contextWindow": null
      },
      "runtime": {
        "sinceBoundMs": 63938,
        "lastTurnMs": 62433,
        "lastTurnRunning": true
      },
      "lastActivityAt": 1793115794092,
      "stale": false,
      "error": null,
      "stop": null,
      "question": null
    }
  ],
  "staleAfterMs": 600000,
  "truncated": false
}
## foreign caller, unknown id, child caller
{
  "ok": false,
  "refusal": {
    "code": "not_your_delegation",
    "delegationId": "dlg_66bd306f-0dc7-43ac-bf6d-a99a58b19d87",
    "message": "delegation dlg_66bd306f-0dc7-43ac-bf6d-a99a58b19d87 was not started by this thread"
  }
}
{
  "ok": false,
  "refusal": {
    "code": "not_your_delegation",
    "delegationId": "dlg_unknown",
    "message": "delegation dlg_unknown was not started by this thread"
  }
}
{
  "ok": false,
  "refusal": {
    "code": "child_caller",
    "message": "a delegate child cannot query delegations"
  }
}
## sandy delegate list (table)
DELEGATION                                STATE     AGENT  PARENT          CHILD           MODEL                       REASONING  ACKED  BRIEF  STOP  CREATED                   STATUS     TOKENS  CONTEXT        TURN  ERROR
dlg_66bd306f-0dc7-43ac-bf6d-a99a58b19d87  starting  scout  thr_r3v44eurw8  thr_dqppstm454  anthropic/claude-haiku-5-5  medium     no     no     -     2026-10-27T15:44:09.315Z  error      29783   29783/1000000  1s    Failed to resolve Pi model "bogus/not-a-model"
dlg_34638672-74b5-41d6-b20a-0443b4eab484  starting  scout  thr_r3v44eurw8  thr_cc44ebsmfi  anthropic/claude-haiku-5-5  medium     no     no     -     2026-10-27T15:44:08.980Z  running    —       —              64s   -
dlg_8173af0d-0535-48a4-9c09-dce08f2fa19a  starting  scout  thr_r3v44eurw8  thr_xh9d9n9jpy  anthropic/claude-haiku-5-5  medium     no     no     -     2026-10-27T15:44:08.634Z  completed  29787   29787/1000000  2s    -


```
