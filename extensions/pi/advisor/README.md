# pi-advisor

Per-session advisor for pi. A second model (default `openai/gpt-6-sol`) reads what the session did and does three jobs:

1. **Gate (bullshit detector).** Before the final answer is stored and shown, cheap rules look for claims the tool calls of the same turn do not back ("tests green", "file changed", "pushed/installed/merged", "verified"). Only on a hit the advisor judges each claim as `belegt`, `unbelegt` or `widerlegt`. The answer is **never rewritten and never answered twice**: the original text stays byte for byte, doubtful passages get a `⚠n` mark and a short footer.
2. **Review.** Every N tool turns the advisor reads the new delta and may steer the agent with one short note (`immuneTurns`, `maxNotesPerRun` limit it). A note that arrives after the run ended is dropped, never queued.
3. **Recording (the floating hand of the ideas plugin).** Nobody approves; the plugin files what the advisor records. Per update the code appends the block "Ideas-Stand dieser Session" (`sandy ideas thread $SANDY_THREAD_ID`: intent, idea, outcome, open tasks) at the end, only when it changed, so the cached prefix stays stable. Kinds: `idea` and `intent` (`propose-idea|propose-intent`; no second intent when the session has one), `task` (`task-add --intent`, needs the session's intent), `fulfil` (`sandy ideas fulfil`, only with evidence). Off outside SANDY (no `SANDY_THREAD_ID`).

## Agent mode (default)

The advisor is not a bare model call but its own in-memory pi agent session (`src/pi/agentAsker.ts`) with:

- read-only tools `read`, `grep`, `find`, `ls` on the project (`agent.tools`), to settle a doubt instead of guessing;
- `session_search` / `session_read` over the **full log of the advised session** (reusing the `pi/context` plugin's search and read; `agent.recallPrimary`);
- the `pi/context` extension inside the advisor itself (cache-aware cuts, notebook; `agent.contextPlugin`), loaded at runtime from the sibling unit `pi/context` (override: `ADVISOR_CONTEXT_DIR`). Missing unit: the advisor runs without these two features;
- the project's context files (`AGENTS.md`, `CLAUDE.md`) in its prompt (`agent.contextFiles`);
- a loop guard: at `agent.maxToolCalls` per update it is told to answer, at twice that the call is aborted;
- model promotion: set `agent.promote` to a bigger model, used once the context passes `atTokens`;
- counters per advisor (calls, failures, resets, tool calls, tokens, cache hit rate) in `/advisor stats`; `ADVISOR_STATS_FILE=<path>` appends the final counters as one JSON line at session end.

`agent.enabled=false` falls back to the bare model call. The session is built at start in the background, so the first gate does not pay for it.

## Why only one final answer

pi calls `message_end` before a message is persisted and lets an extension return a replacement. The gate runs there, so no second turn is needed. Fail-open: after `gate.timeoutMs` or on any error the original answer is released unchanged.

## Cache safety

- System prompt is a constant. History is append-only: one user message per delta, headed `### Session update`, the reply stored as received.
- Stable `sessionId` (`advisor:<session>`), one model for the life of the context, `cacheRetention: long`.
- All advisor calls run on one queue (no interleaving). A failed call removes its message again and the same delta is resent; the cursor only advances on success.
- Rendering is deterministic (no timestamps), tool results are clipped in the middle, secrets are redacted.
- The only cut is a planned reset at `cache.budgetTokens`. `/advisor stats` shows hit rate, resets, failures.

## Configure

`~/.pi/agent/advisor.json`, then `<project>/.pi/advisor.json` on top. Unknown keys and wrong types are reported and ignored. Defaults: `src/core/config.ts`.

```json
{ "model": {"provider":"openai","id":"gpt-6-sol","reasoning":"medium"},
  "agent": {"enabled":true,"tools":["read","grep","find","ls"],"maxToolCalls":6,"contextFiles":true,"contextPlugin":true,"recallPrimary":true,"promote":{"provider":"","id":"","atTokens":200000}},
  "gate": {"timeoutMs":12000,"minChars":200,"onTimeout":"release","rules":{"verified":false}},
  "review": {"everyTurns":4,"immuneTurns":3,"maxNotesPerRun":4,"steer":true},
  "proposals": {"maxPerSession":5, "taskProject":"IDEA"} }
```

Commands: `/advisor status|on|off|reset|stats`.

## Checked / not checked

- Checked: 53 unit tests (rules, ledger, annotate keeps text, parser, delta, append-only context, failure rollback, gate fail-open, serialisation, config incl. agent block, injected Asker, context kit loading); `tsc` clean.
- Checked live: `pi -p --no-session -e ./index.ts` with a made-up claim: the gate called gpt-6-sol, the final answer carried `⚠1`, `⚠2` and the footer. Agent mode: the advisor used `read` and `session_search` (2 tool calls), cache hit 94% on the second call, 7 s first / 2.5 s second call. In a real run the cache read was 4096 tokens of 4.7k.
- **Not checked:** real cache hit rate (read it from `/advisor stats`), how SANDY renders the replaced message, whether a steer note changes the agent's next step, model promotion, recording against a live ideas plugin (CLI `thread`/`fulfil` only tested with a fake exec and the core module), behaviour with several sessions at once.

## Install (not done)

Add this directory to `packages` in `~/.pi/agent/settings.json` or run it per session with `pi -e pi/advisor/index.ts`.
