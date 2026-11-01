# pi/context

Cache-aware context management for long pi sessions: planned cuts, an anchored summary, pinned user messages, a notebook, search over the unchanged log, and keep-warm pings for sessions that wait on a SANDY workflow. It came from Sandy's `packages/context` with its git history; the Pi Durable engine stayed in Sandy, which keeps its own copy.

The names `sandy-context` (entry kinds, `/sandy-context`, `<agent dir>/sandy-context.json`, the ledger directory) stay, because existing sessions and settings use them.

## The engine

`src/core` implements the engine without reference to a host. What is specific to pi is under *The pi extension*.

### The model view

Without a cut, the model sees the whole history. After a cut, it sees:

```
+--------------------------------------------------+
| cut block (one user message)                     |
|   <sandy-context>                                |
|   intro: history is archived and searchable      |
|   ## Your notebook                               |
|   ## Skills in use    (name, path, #id)          |
|   ## Earlier user messages, verbatim             |
|   ## Summary of older work (through #id)         |
|   ## Files            (modified / read)          |
|   ## Archived without summary  (#a ... #b)       |
|   ## Recent work, tool output archived           |
|   </sandy-context>                               |
+--------------------------------------------------+
| history from the kept entry onward, unchanged    |
|   user / assistant / tool / ...                  |
|   ... grows at the end until the next cut        |
+--------------------------------------------------+
```

The block and the kept history together are the new prefix. Until the next cut, every request extends it at the end only.

### Anatomy of a cut

A cut is planned by `planCut` from the list of visible entries, the latest summary and the notebook:

1. **Kept boundary.** Walk back from the newest entry until about `keepRecentTokens` of history are collected. Never start on a tool result. If the user message that opened the current turn is close (within half of `keepRecentTokens` more), start there. Never keep less than the previous cut kept; a cut must archive something new, otherwise there is no cut.
2. **Masked tier.** Entries just before the kept boundary, back to the end of the summary, are rendered compactly within `maskedTokens`: the agent's reasoning and calls stay, each tool output becomes a reference line such as
   `[#3f2a1c0d9e8b ← read({"path":"report-4.txt"})] 3412 tokens archived: entry 0: subsystem 0 ...`
   This is observation masking: the agent keeps what it did and can fetch any output again by id.
3. **Pinned user messages.** Earlier user messages are carried verbatim (each clipped to 1,500 characters) within `pinnedUserTokens`, newest first; older ones that do not fit are counted and named as searchable. A `/skill:` prompt is pinned as its request with the skill's tag in place of its body, here and in the masked tier.
4. **Summary.** The anchored summary (4.3), if one covers part of the archived history.
5. **Files.** Files modified (`edit`, `write`) and read (`read`) across the whole log, newest first, up to `filesListed` per category. Computed, not summarized.
6. **Gap notice.** If archived entries are covered neither by the summary nor by the masked tier, their id range is named so the agent knows to search.
7. **Notebook.** The agent's notebook, verbatim.
8. **Skills in use.** Skills whose newest load the cut archives, newest first, at most 10, each as name, path and the entry that loaded it, with the instruction to read the file again before continuing work it governs. Computed, not summarized (`core/skills.ts`): a load is a path ending in `/SKILL.md` in any string argument of a tool call other than `edit` and `write`, so a read inside codemode, `fabric_exec` or a shell counts as much as a direct `read`, or pi's `<skill name location>` tag from `/skill:name`. A quoted path may hold spaces. A skill counts once by name; a path with a variable or longer than 512 characters is skipped, never guessed or shortened. The section stays within 600 tokens, which count toward what every cut carries (`carriedTokens`); the scan is linear in the arguments. The block carries no skill text: a reread costs one tool call, a copy would cost its tokens at every cut. Not seen: paths built at run time and skill files under another name.

The cut records the kept entry id, the block text, the masked range, the summary it used, the number of archived entries and the block size.

### The historian and the anchored summary

The historian summarizes archived history in the background, one stretch at a time. It only takes history that the next cut will archive: the newest `keepRecentTokens + maskedTokens` stay raw or masked and are summarized later. A stretch starts after the last summarized entry, is at most `chunkMaxTokens` long, never splits a tool call from its results, and is summarized only once it reaches `chunkMinTokens`.

The historian writes fixed sections as bullet points, each ending with the ids of the entries it came from:

| Section | Merge rule |
|---|---|
| Goal and how it changed | append |
| Current state | replace |
| Chapters | append |
| Decisions | append |
| Facts and findings | append |
| Errors and fixes | append |
| Open threads | replace |

Items merge into the previous summary by rule, never by asking a model to rewrite the whole summary. State sections are replaced by the newest stretch; record sections accumulate, with exact duplicates dropped. The goal accumulates too, so the summary keeps how the goal changed and why. *Open threads* is replaced, and the prompt therefore asks the historian to carry forward every thread from the existing summary that the stretch did not close. It also asks for the purpose of actions and the hypothesis behind experiments, not only what was done.

Each stretch becomes one entry under *Chapters*: the historian names the topic, and the extension adds the stretch's entry range, so the cut block carries a table of contents of the whole session and every chapter is an anchor for `history_search` and `history_read`.

If the summary outgrows `summaryTokens`, its oldest records are condensed rather than dropped. The extension picks the oldest items of the largest record sections, enough to bring the summary down to 60% of its budget, and a second model call rewrites them as fewer bullets that keep their entry ids, with id ranges for longer runs. The condensed items take the place of the originals. This runs in the background together with the historian and changes only the stored summary entry; the model sees the result at the next cut, which rewrites the context block anyway, so condensing adds no cache break. Dropping the oldest items remains the fallback when the condenser fails or does not get the summary under budget. Either way the originals stay in the log.

A test in `core.summary.test.ts` measures retention over 60 historian passes with a 1,200-token budget and a mechanical condenser that keeps only the id range: dropping still accounts for 11 of 60 early rounds, condensing for all 60, with 7 condenser calls. A live run on `gpt-6-luna` with a 700-token summary budget condensed once, kept all ten release codes in the final summary and answered every recall question.

The historian prompt tells the model explicitly that results belong in *Facts and findings* and never in *Current state*. In the first live run the model had put release codes into *Current state*, a replace section, so every run deleted the previous ones.

*Current state* is two bullets, *Done:* and *Next:*. *Next:* names the concrete step the agent starts with after a cut, so a cut at the end of a task (see the cut policy) leaves a session that can carry on without rereading the archived stretch. On one real 41k-token stretch, claude-haiku-4-5 wrote a vague progress line with the old wording and a concrete next step with the new one, in two of two runs.

### The notebook

The notebook is the agent's own working state: goal, constraints, decisions, plan and position in it. The agent replaces it with the `notebook` tool. It is carried verbatim into every cut block and limited to `notebookMaxBytes` (8 KB by default). Unlike the summary, nothing but the agent writes it.

### Search over the unchanged log

The agent gets two tools for history that has left its context:

- `history_search` finds entries by keywords. Search is lexical (BM25). Entry ids in the query resolve directly. Each hit names the user message that opened its turn.
- `history_read` returns one entry in full by id.

The index sees, for every entry, the call a tool result answers (so `report-4` finds the output of `read report-4.txt`), the content, and the calls an assistant made. Compound names such as `report-4.txt` or `gpt-6-luna` stay findable as a whole. The results of `history_search` and `history_read`, and the agent's calls to them, are not indexed, so a search never finds earlier searches.

### Cut policy

| Moment | Condition | Reason |
|---|---|---|
| Before a new user prompt (interactive) | prompt ≥ soft threshold | `watermark` |
| Between two requests of a run | interactive: prompt ≥ hard threshold; headless, worker or a queued message: prompt ≥ soft threshold | `watermark` |
| Before a new user prompt | prompt ≥ `coldCutMinTokens` and the model changed | `model` |
| Before a new user prompt | prompt ≥ `coldCutMinTokens` and the cache is older than its lifetime | `cold` |
| Next request of a run, or next prompt | another extension reported a finished task on `sandy-context.cut-request`, and prompt ≥ `taskCutMinTokens` | `task` |
| Host compaction (pi only) | pi's threshold, overflow or `/compact` | pi's reason, or `manual` |

There are two thresholds (`cutThresholds` in `core/policy.ts`). The soft one is the watermark: the smallest of `watermarkTokens`, `hardCapTokens` and the model window minus 32,768. The hard one is the soft one plus `deferMarginTokens`, capped at the same window and ceiling. In an interactive session the routine cut waits for the next user prompt: the run's knowledge is already condensed in the answer, the turn stays whole, the notebook is current, and the cut often meets a cache that went cold during the user's pause anyway. Mid-run the hard threshold is only an emergency brake for one long run. A headless run, a worker or a run with queued messages has no user prompt to wait for, so it cuts at the soft threshold between requests as before. Keep-warm pings stop once the prompt reached the soft threshold, because the next prompt cuts anyway. The margin of 30k is an estimate, not a measured optimum; the ledger records where each cut happened (`position`) so it can be tuned.

A cut that would not bring the prompt below its threshold is refused (`cutAccepted`), because it would be followed by another at the next chance. This happens when the watermark is too low for what a cut carries, or on a small model window. Once the prompt has reached the hard threshold, a cut is made anyway when it frees at least a quarter of the prompt (`HARD_CUT_MIN_SHARE`): refusing it would let the prompt grow until pi compacts near the model window, at over 900k tokens on a 1M window. A cut right after such a cut archives too little to qualify, so these cuts do not follow each other either. The projection (`projectedTokens`) scales the estimated change by the measured ratio of prompt to estimate; on 54 cuts of October 2026 it missed the next prompt by -0.2k on average (RMS 16k). A refused cut writes a `cut-refused` ledger line with the projected size; a planned cut whose next prompt is still at or above the watermark is reported too. Each kind is shown once per session (a notification, or stderr without a UI), and the latest one in `/sandy-context`.

The minimum for cold and model cuts avoids cutting small prompts that would barely shrink. A task cut breaks a warm cache, so its minimum sits closer to the watermark, where a cut comes soon anyway; it moves that cut to the boundary between two tasks. A reported task is used by the next cut chance, whether it cuts or not, so a request never fires in the middle of a later task. Any extension can report one with `pi.events.emit("sandy-context.cut-request", {})`. The request is also written to the log as `sandy-context.task-done`, so a process started for the next prompt still honours it; SANDY starts pi for every message. Cache lifetime is measured from the end of the last response, which slightly overestimates warmth; the error goes toward skipping a free cut, never toward an extra break.

### Configuration

The extension reads these settings from its config file (see *Configuration* below).

| Setting | Default | Meaning |
|---|---:|---|
| `watermarkTokens` | 120,000 | Soft threshold: cut at the next prompt (or between requests when headless) once the prompt reaches this size |
| `deferMarginTokens` | 30,000 | How far an interactive run may grow past the soft threshold before it cuts mid-run |
| `hardCapTokens` | 200,000 | Ceiling whatever the model window allows |
| `keepRecentTokens` | 16,000 | Recent history kept verbatim after a cut |
| `maskedTokens` | 6,000 | Budget for the masked tier |
| `pinnedUserTokens` | 4,000 | Budget for earlier user messages |
| `summaryTokens` | 8,000 | Budget for the anchored summary |
| `filesListed` | 25 | Files listed per category |
| `coldCutMinTokens` | 60,000 | Minimum prompt for cold and model cuts |
| `taskCutMinTokens` | 80,000 | Minimum prompt for a cut after a finished task |
| `notebookMaxBytes` | 8,192 | Notebook size limit |
| `fallbackCacheTtlSeconds` | 300 | Cache lifetime when the model declares none |
| `cacheTtlSeconds` | `openai-codex` never expires, `anthropic` 300/3600 (short/long) | Measured cache lifetimes per `provider/model` or `provider`; merged per key |
| `historian.enabled` | true | Run the background historian |
| `historian.model` | current model | `provider/model` for summaries (pi only) |
| `historian.fallbackModel` | none | `provider/model` asked when the first model fails, for example a session model that cannot turn thinking off and spends `maxOutputTokens` on it (pi only) |
| `historian.chunkMinTokens` | 12,000 | Minimum stretch to summarize |
| `historian.chunkMaxTokens` | 40,000 | Maximum stretch per call |
| `historian.maxOutputTokens` | 4,096 | Output limit of a summary call |
| `historian.startTokens` | 60,000 | The historian runs only once the prompt reaches this size, so short sessions pay nothing for it |

The token budgets are in the provider's tokens, the unit of the watermark and of the prompt size pi reports. The cut measures text in estimated tokens (four characters each) and converts each budget by dividing it by 1.6 (`PROVIDER_TOKENS_PER_ESTIMATE`, fitted on Opus sessions, where code, JSON and German text count 1.3 to 1.8 provider tokens per estimated one). A model with a leaner tokenizer keeps somewhat less than its budget.

Validation rejects settings that cannot work. In particular, `keepRecent + masked + pinnedUser + summary` plus the skills section's 600 tokens and the notebook (`notebookMaxBytes / 4`), both scaled by 1.6, must stay below the watermark, otherwise every cut would be followed immediately by another. The system prompt and tools come on top: about 48k tokens in a SANDY pi session with its many tools (fitted on 86 cuts of October 2026). This floor decides most of what a cut leaves: the prompt after a cut was about 48k plus 1.3 times the estimated tokens the cut kept and carried, 86k in the median with the old budgets (25k, 12k, 6k and 8k estimated tokens, a 16 KB notebook).

Why 120,000 and not 200,000: a cut costs one uncached prompt of roughly the carried size; every turn before it reads the whole prompt from cache. Under assumed workloads (40k tokens carried after a cut, 3k new tokens per turn) the cost-optimal watermark comes out around 95k to 117k depending on the cache read price. That is a calculation under assumptions, not a measurement. 200k is treated as a hard ceiling, not a target.

### Design rationale

The design followed a literature and data review recorded in Sandy's `docs/notebook.md`. In short:

- **Observation masking** replaced old tool output with references and matched LLM summarization at about half the cost (The Complexity Trap, arXiv 2508.21433).
- **Anchored, itemized summaries** avoid the detail loss of repeated whole-summary rewrites (ACE, arXiv 2510.04618; Factory's evaluation of structured summaries).
- **Pinned user messages and notes**: constraints that pass through a summarizer decay over compactions (Governance Decay, arXiv 2606.22528).
- **Lexical search over the raw log**: an agent searching its own raw history with keyword queries beat graph and embedding memories (ReFind, arXiv 2608.12888).

These studies cover different settings. None tests this exact combination, which is why the engine measures itself (see *The request ledger*).

Compared with Magic Context, which rewrites outgoing messages on every request and keeps age-tiered compartments, this engine changes the view only at cuts and keeps one summary with deterministic merging. Compared with pi's native compaction, it never makes a synchronous model call and leaves the full history searchable.

## The pi extension

### Overview

The extension brings the engine into ordinary pi sessions (pi 1.1.0 or later). It is built on pi's own primitives: **a cut is one native pi `compaction` entry**, built without a model call, and pi's own projection of the session file yields the model view. The extension never rewrites requests. The session file stays the only source of truth and only ever grows.

```
pi/context/
  index.ts                  entry point pi loads
  src/core/                 host-independent engine
    config.ts  cut.ts  historian.ts  summary.ts  search.ts
    serialize.ts  policy.ts  continuity.ts  ledger.ts  tokens.ts  types.ts
  src/pi/
    branch.ts               reads the active pi branch into engine state
    extension.ts            hooks, tools, command
  test/                     unit tests, pi runtime integration tests, live runner
```

### Installation

The package declares itself as a pi package (`"pi": { "extensions": ["./index.ts"] }`). Install it from a local path:

Install its dependencies with `scripts/build.sh pi/context`, then add the unit's directory to `packages` in `~/.pi/agent/settings.json` (and to `subagents.defaultExtensions` as `pi/context/index.ts`, so subagents load it too).

Requirements: pi 1.1.0 or later on a runtime that runs TypeScript directly (Node with type stripping, or Bun).

> **Do not run it together with Magic Context.** Both take over context management; running both would make each other's changes look like unplanned breaks. Disable one before enabling the other.

### How it hooks into pi

| pi event | What the extension does |
|---|---|
| `session_start` | Resets per-session state (ledger, index, request tracker) and schedules the historian |
| `agent_start` | Starts the per-run counters of the signals |
| `tool_result` | Counts tool output tokens, delegations through sandy, and after a cut the history calls and re-reads of archived files |
| `turn_end` | Publishes the signals on `sandy-context.signals` and schedules the historian. If the prompt reached the hard threshold (or the soft one when no user prompt follows), appends a `compaction` boundary entry with the cut (`watermark`) |
| `input` | Before a new prompt, when idle: if the prompt reached the soft threshold, or the cache is cold or the model changed and the prompt is large enough, awaits `ctx.compact()`, which pi routes through `session_before_compact` |
| `session_before_compact` | Replaces pi's compaction (threshold, overflow, manual, or the extension's own cold/model request) with the planned cut, returned instantly |
| `session_compact_failed` | Clears the pending cut reason |
| `session_tree` | Marks the next request as a planned `branch` break |
| `before_provider_request` | Records the shape of the request body for the continuity check |
| `message_end` | Judges the request once the provider answered, updates the ledger, adds usage |
| `session_shutdown` | Aborts a running historian call |

The watermark the extension uses is the smallest of `watermarkTokens`, `hardCapTokens` and the model's context window minus 32,768 tokens (twice pi's 16,384 reserve), so pi's own threshold compaction never fires first.

The cache lifetime for the tier (short, or long when `PI_CACHE_RETENTION=long`) comes from the first source that names it: `cacheTtlSeconds` for `provider/model`, then for `provider`, then the model's declared `promptCache`, falling back to `fallbackCacheTtlSeconds` (or one hour for the long tier). The table holds measurements, because a provider's real lifetime can differ from its catalogue: on 2026-10-20 a Codex (`gpt-6-astra`) cache still hit after a 20-minute pause without the long tier and was cold after 40; a Claude Haiku cache hit after 20 minutes with `PI_CACHE_RETENTION=long` and was cold without it. The ChatGPT subscription backend now keeps a Codex cache without expiry, so `openai-codex` has an infinite lifetime in both tiers (`Number.POSITIVE_INFINITY` in code; a JSON config that wants expiry back sets a number of seconds): a Codex session is never pinged and never cut for a cold cache, only at the watermark and on a model change. The API (`openai`) is not affected and still takes the model's declared lifetime.

`keepWarmDue` (`core/policy.ts`) decides whether a waiting session gets a ping that refreshes its cache. It pings only when the session's next prompt is expected after the cache expires, the cache is still warm, and it expires within `KEEP_WARM_LEAD_MS` (one minute): a Claude session on the long tier waiting for a reviewer is pinged after 59 minutes, a Codex session never. Then it compares cost: every ping until that prompt plus the prompt itself reads the whole context from the cache, while going cold writes the context again, or only the carried tokens when the prompt is above `coldCutMinTokens` and gets cut first. With prices of read 0.1 and write 1.25 times the input price and an 80k prompt that leaves 26k carried, two pings pay off and twelve do not.

The pi extension asks it every 30 seconds while the session is idle, and only when a signal file exists with `{ "until": <epoch ms> }`: `pi-keep-warm.json` in the SANDY thread's storage (`SANDY_THREAD_STORAGE`), else `<agent dir>/sandy-context/keep-warm/<session id>.json`. The thread storage lives on the machine that runs the worker, and a SANDY plugin reaches it from the server through the host-routed file API, so the workflow needs no access to the worker's agent directory. A workflow that parks a session for later writes the file and deletes it when it continues. A due ping is a hidden custom message (`sandy-context.keep-warm`) that starts a turn asking for the reply `ok`, and it gets a `keep-warm` record in the ledger. A missed ping is not retried; the next tick decides again. Once the next prompt arrives, the ping and its answer leave the model's context (`withoutPings` in `pi/keep-warm.ts`, on pi's `context` event) and stay in the session file: the ping read the prompt before it, so that prefix is what the cache holds, and a parked session's context does not grow by one exchange per ping. Prices come from the model's catalogue entry, with Anthropic's long tier writing at twice the input price; without prices the ratio 0.1 to 1.25 applies. The timer does not keep a finished process alive, and it stops when its session is gone. The pi scenario test parks the session 30 seconds before its cache expires with a signal half a lifetime past expiry and sees exactly one ping that continues the cached prompt, a next prompt that continues the prompt the ping read without the ping, and no ping without a signal. What it does not show yet: whether SANDY keeps an idle worker's pi process alive, and the cache hit of a real ping.

### Tools and command

**`history_search`**

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | required | Keywords |
| `limit` | integer | 8 (max 30) | Maximum results |
| `includeVisible` | boolean | false | Also search history still in context. By default, once anything is archived, only archived history is searched |

Results list `#id · kind · time`, a snippet and the opening user message of the hit's turn. 8-hex pi entry ids in the query resolve directly. The extension's own search and read results are not indexed, so a search never finds earlier searches.

**`history_read`**

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | Entry id, with or without `#`; a unique prefix of 4 or more characters works |
| `around` | integer 0 to 10 | 0 | Also list this many neighbors before and after, masked |
| `offset` | integer | 0 | Character offset into a long entry |
| `maxChars` | integer 500 to 60,000 | 12,000 | Characters to return |

**`notebook`**: called without `text`, returns the notebook; with `text`, replaces it; an empty string clears it. Texts above `notebookMaxBytes` are rejected with an error that tells the agent to shorten it.

**`/sandy-context`** shows the status: prompt size and watermark, cuts on the branch, summary coverage, notebook size, historian runs and failures, archived entries and the request classes of this process.

### What the extension stores

Everything lives in the pi session file, appended through pi's own APIs:

| Entry | Contents |
|---|---|
| `compaction` | `summary` = the cut block, `firstKeptEntryId`, `details.sandyContext` = cut details plus `reason` |
| custom `sandy-context.summary` | The anchored summary state (`version`, `coveredThroughId`, `sections`), the historian's usage and model |
| custom `sandy-context.notebook` | The notebook text (`text`), written by the notebook tool however it was called; sessions from before this entry kept it in the notebook tool result details, which are still read |

The search index lives in memory and is rebuilt from the branch as needed. History archived before the extension's first summary on a branch stays searchable but is not summarized.

### The request ledger

Each request is judged once the provider has answered, against the last request the provider **accepted**. A request the provider refused (error or abort with no prompt tokens) is classed `rejected`; it leaves no cache behind, so it is not used as the comparison base, and a planned cut stays pending until a request carrying it is accepted. This rule came from a live test in which Anthropic refused every request: before the fix, each refusal counted as an unplanned break.

One JSON line per request is appended to `<agent dir>/sandy-context/ledger.jsonl`:

```json
{"t":"2026-10-10T16:09:30.265Z","session":"01a1...","class":"planned","reason":"watermark","at":0,"items":14,"model":"openai-codex/gpt-6-luna"}
```

`at` is the first differing message index (or `head` when instructions, tools or settings changed). Each line also carries what the request cost and what led to it:

| Field | Meaning |
|---|---|
| `prompt`, `usage` | Prompt tokens and the answer's `input`, `output`, `cacheRead`, `cacheWrite` and `cost` |
| `position` | For a planned cut: `run` (between two requests), `prompt` (before a user prompt) or `pi` (pi's own compaction) |
| `signals.toolTokens`, `signals.runToolTokens` | Tool output that entered the prompt since the previous request and since the run started; calls made inside another tool count 0, their result never reaches the prompt |
| `signals.delegations` | Agents started through sandy in this run: a sandy workflow tool, or `sandy workflows run` / `sandy thread new` in a shell |
| `signals.requestsSinceCut`, `signals.historyCallsSinceCut`, `signals.rereadsSinceCut` | After the latest cut: requests, `history_search`/`history_read` calls, and `read`s of files the cut archived. Many of them mean the cut took away what the agent still needed |

A refused cut writes `{"class":"cut-refused","reason":…,"tokens":…,"limit":…,"projected":…,"hard":…}`. The same signals, with the prompt size and both thresholds, are published after every turn on the event bus channel `sandy-context.signals` and shown by `/sandy-context`. The engine acts on none of them: deciding when to delegate belongs to another extension.

The ledger says whether the cache held; what the tokens cost comes from the session logs. `npm run measure -- [days] [dir]` reads the pi session logs changed in the last days (default 7, `~/.sandy/pi-bridge-sessions`) and prints prompt tokens, cache hit rate, cost, cuts by reason and, once task cuts happen, the median prompt tokens per finished task. Run it before and after a policy change over the same span.

### Configuration

Settings from the table under *Configuration* in *The engine* are read from `<agent dir>/sandy-context.json` if it exists (camelCase keys, partial objects allowed):

```json
{
  "watermarkTokens": 100000,
  "historian": { "model": "openai-codex/gpt-6-luna" }
}
```

Embedders can call `createContextExtension(options)` instead of using the default export, with `config`, `configFile` (path or `false`), `ledgerFile` (path or `false`), a `now` clock and a custom `summarize` function.

**Caveat.** For a cold or model cut, pi's `ctx.compact()` first runs pi's own preparation, which refuses unless there is history older than pi's `compaction.keepRecentTokens` (20,000 by default). With the default `coldCutMinTokens` of 60,000 this never matters. Configurations that set `coldCutMinTokens` below about 20,000 also need pi's `compaction.keepRecentTokens` lowered.

### Tests and the live runner

Run them on the AI host (`ssh AI`), never on the laptop:

```sh
npm install                  # pi 1.3.0, its types and Vitest
npm run typecheck            # tsc --noEmit
npm test                     # unit tests and pi runtime integration tests (Vitest, on Node)
npm run test:live            # live run against the fixed model, needs OPENAI_API_KEY
```

The integration tests run the extension inside the real pi runtime with pi's faux provider: watermark cuts, cold and model cuts, background summaries carried into a cut, search and read, append-only session file and zero unplanned breaks. The faux provider sends no real request payloads, so the ledger is exercised live only.

The live runner (`test/live/run.ts`) creates a workspace of ten report files, each hiding a release code in about 260 lines of filler, and asks the agent to read them one by one with a low watermark, then to recall codes, a rule and a detail from memory:

```sh
node --experimental-strip-types test/live/run.ts --fast --thinking=low --watermark=20000 \
  [--no-historian] [--idle=330] [--cold-min=8000]
```

`--fast` sets `service_tier: "priority"` on every request through `before_provider_request`. The model is fixed: `MODEL` in `test/live/run.ts`. The only credential is `OPENAI_API_KEY` from the environment; pi runs with a throwaway config directory, so no stored login, extension or setting of the user is read. Without the key, and always in CI, the runner is skipped; a provider error such as a rejected key stops it. It writes `report.json` plus the session file to a temporary directory.
