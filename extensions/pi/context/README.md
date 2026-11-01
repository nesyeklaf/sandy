# pi/context

Cache-aware context management for long pi sessions: planned cuts, an anchored summary, pinned user messages, a notebook, search over the unchanged log, and one-token keep-warm requests for sessions that wait on a SANDY workflow. It came from Sandy's `packages/context` with its git history; the Pi Durable engine stayed in Sandy, which keeps its own copy.

Everything the engine writes is named `context`: entry kinds under `context.`, the cut tag `<context>`, the `/context` command, `<agent dir>/context.json` and the ledger directory `<agent dir>/context/`. It wrote `sandy-context` before; the old names are only read. Sessions written under them resume through the one record reader (`src/core/records.ts`), and the first start after the update moves the old config file and ledger directory to the new names (*Moving the old host files*).

## The engine

`src/core` implements the engine without reference to a host. What is specific to pi is under *The pi extension*.

### The model view

Without a cut, the model sees the whole history. After a cut, it sees:

```
+--------------------------------------------------+
| cut block (one user message)                     |
|   <context>                                      |
|   intro: history is archived and searchable      |
|   ## Your notebook                               |
|   ## Skills in use    (name, path, #id)          |
|   ## Earlier user messages, verbatim             |
|   ## Summary of older work (through #id)         |
|   ## Files            (modified / read)          |
|   ## Archived without summary  (#a ... #b)       |
|   ## Recent work, tool output archived           |
|   </context>                                     |
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
4. **Summary.** The summary of a compaction this extension did not write, verbatim, because the model sees only the newest compaction; a line marks it stale when entries it summarizes were edited after it. Then the anchored summary (4.3), if one covers part of the archived history. Items whose sources an edit replaced or omitted after they were written are left out (4.3).
5. **Files.** Files modified (`edit`, `write`) and read (`read`) across the whole log, newest first, up to `filesListed` per category. Computed, not summarized.
6. **Gap notice.** If archived entries are covered neither by the summary nor by the masked tier, their id range is named so the agent knows to search. So is a summarized stretch an edit changed, until the historian has summarized it again.
7. **Notebook.** The agent's notebook, verbatim.
8. **Skills in use.** Skills whose newest load the cut archives, newest first, at most 10, each as name, path and the entry that loaded it, with the instruction to read the file again before continuing work it governs. Computed, not summarized (`core/skills.ts`): a load is a path ending in `/SKILL.md` in any string argument of a tool call other than `edit` and `write`, so a read inside codemode, `fabric_exec` or a shell counts as much as a direct `read`, or pi's `<skill name location>` tag from `/skill:name`. A quoted path may hold spaces. A skill counts once by name; a path with a variable or longer than 512 characters is skipped, never guessed or shortened. The section stays within 600 tokens, which count toward what every cut carries (`carriedTokens`); the scan is linear in the arguments. The block carries no skill text: a reread costs one tool call, a copy would cost its tokens at every cut. Not seen: paths built at run time and skill files under another name.

The cut records the kept entry id, the block text, the masked range, the summary it used, the number of archived entries and the block size.

### The historian and the anchored summary

The historian summarizes archived history in the background, one stretch at a time. It only takes history that the next cut will archive: the newest `keepRecentTokens + maskedTokens` stay raw or masked and are summarized later. A stretch starts after the last summarized entry, is at most `chunkMaxTokens` long, never splits a tool call from its results, and is summarized only once the history it covers reaches `chunkMinTokens`. A tool output longer than 2,000 characters is shown as its first 1,400 and last 600 characters around a mark that names the omitted length and the entry id; it counts as covered, and `history_read` opens the rest. The summary records what a call found, and the head and tail say that: in the live comparison with the previous version, whole tool outputs made the historian's input about six times larger for the same stretch. User and assistant text is never clipped: an entry that does not fit is shown in explicit spans ("characters 0-8000 of 20000"), and the summary records it as partly summarized (`partial`) until the next stretch has shown the rest, so a fact in the middle of a long answer reaches the model.

An answer counts as a summary only when it is complete and sourced. It must end on its own (not at the output limit), make no tool call, contain at least one of the sections below, cite only entries it was shown or the existing summary already cites, and every item but the topic must cite at least one (an uncited item could never be taken out when its source is edited). The model adapter hands over how the answer ended and how many tool calls it made, so the check runs on the production path too. Anything else is a failed call, shown in `/context`, and the coverage stays where it was. The summary is stored only if the branch still reads as the stretch did: when another summary was stored meanwhile (compared by a digest of its whole content, not only its coverage), an entry it was made from was edited, or the branch lost the entries, it is dropped and made again from what the branch says now. Entries appended in the meantime do not matter.

A failing summary is not retried forever, because every request is paid. Each model request is an *attempt*, stored in the session before it goes out (custom `context.historian-attempt`: `start` naming the step, `summarize` or `condense`, the model and the route, `primary` or `fallback`; and `end` with `stored`, `rejected`, `failed`, `stale` or `aborted`). The summary, a `fallbackModel`'s try and the condenser are three requests and three attempts. A piece of work gets 3 attempts that do not end in a stored summary. A fallback or the condenser follows its request at once, unless the work is out of attempts: then the fallback is not asked, and a summary over budget is trimmed without the condenser. A new run waits: the second attempt no sooner than 30 seconds after the first failed, the third no sooner than 2 minutes after the second. Then the work pauses: the owner is told once per process (a notification, or stderr without a UI), `/context` shows it, and no request goes out until `/context retry-historian` is run, which stores a retry marker and starts a fresh set of attempts. The count and the wait come from the stored records and a clock, not from timers or memory, so a restart, a reload or a new turn neither resets nor skips them; the wait is checked at the next turn or start. An attempt without an end (the process died, or the session left the branch) counts as paid. A call a shutdown cuts short counts too, but is not delayed. An answer dropped as `stale` was paid for, so it counts. The decision is one pure function, `nextAction` in `src/core/attempts.ts`.

A piece of work is the whole summary it extends (its digest, so a corrected summary is new work), the stale checkpoint it replaces, the entries of the stretch it first read (each id, where its span starts and the digest of the whole entry, so an edit or removal is new work) and the settings that shape a request: the models and routes, `maxOutputTokens`, `chunkMaxTokens`, `summaryTokens` and the prompts. The stretch growing past what it first read is not new work: the start record stores how many spans the key covers, and later runs compare only those.

An attempt record is one request only if nothing sends it again unseen. The historian asks pi-ai for one request on the wire: `transport: "sse"` (Codex otherwise tries a WebSocket first, reconnects and falls back to SSE inside one call) and `maxRetries: 0` (the OpenAI, Anthropic and Google providers retry only when asked). Bedrock is refused as `historian.model` or `historian.fallbackModel`, and a Bedrock session model is not asked for summaries: pi-ai builds its AWS client with the SDK's default of three attempts and offers no option to lower it. A session on a Bedrock model without a `historian.model` has no historian: the owner is told once per session why and what to set (a notification, or stderr without a UI), and `/context` shows `Historian unavailable: …`. A provider an extension registers is trusted to send what it is given once.

Two pi processes on one session file (two terminals resuming one session) share the count. A request goes out only from the process that holds the claim file `<session file>.historian-claim`, created exclusively, which names the holder's pid, host, work and a heartbeat renewed every 15 seconds. Another process sends nothing while the holder lives; it takes the claim over once the holder's process is gone (same host) or its heartbeat is 2 minutes old. A holder checks that it still holds the claim before each request and before it stores the summary. The count reads one ordered stream of receipts, under the claim: every attempt record in the session file, in file order, whichever process or branch wrote it, then this process's records the file does not hold yet, each record id once. pi reads a file once, so a second process's records would otherwise stay unseen, and a process that opened the file early appends its records beside the others' as a sibling branch. Branches share the count because a work key names the work by its whole input: a branch that reads the same stretch with the same summary would send the same paid request; different work has a key of its own. Retry markers and endings apply in stream order, so `/context retry-historian` in any process frees attempts any process made, and work another process already stored a summary for is not asked again. The reader takes only what was appended since its last read while it can prove the file only grew (same device and inode, unchanged bytes before its offset); a file replaced or rewritten is read again from the start. A session that lives only in memory has no claim, and its stream is this process's records.

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

Each stretch becomes one entry under *Chapters*: the historian names the topic, and the extension adds the stretch's entry range (an answer without a topic adds no chapter), so the cut block carries a table of contents of the whole session and every chapter is an anchor for `history_search` and `history_read`.

A summary remembers which entries each item came from, with a hash of how the stretch read: of the entries in it that no edit omits. When `context_edit` replaces or omits an entry of a stretch, the stretch no longer counts as summarized: the items citing any entry of it leave the summary and the cut (a range `#a … #b` covers the entries between, read in branch order, so an omitted entry inside a range counts), and so does anything a condenser merged them into: the condenser's output is used only if it still cites every entry its input cited, with every range read in the history's order. A part of an entry summarized so far (`partial`) is dropped when the entry is edited or omitted. The stretch is recorded as unsummarized (`unsummarized` in the stored summary), and the historian summarizes it again from the branch as it reads now before it moves on, however small it is; that pass adds records but leaves *Current state* and *Open threads* alone. Its hash leaves the omitted entry out, so the stretch then counts as summarized and is not asked for again; a historian that finds the same work again right after storing its summary reports an error instead of asking again. Until then a cut names it under "Archived without summary" as edited after it was summarized. In the archive a replaced entry shows its original and then its effective text after the edit, still marked as historical evidence, and a search finds both. That holds behind a foreign compaction too: the entry's status comes from its latest edit, and its text after the edit from a projection of the branch without its compactions, made only when the entry is rendered.

A stale foreign checkpoint (an edit touched what another compaction summarized) is carried with a "Stale:" note. When no other compacting extension is present, the historian also summarizes the sources of that checkpoint that no stretch of our summary covers, even when our summary had already moved past them, and the next cut of ours replaces the checkpoint with that summary once every one of its sources (behind every older compaction too, not only the latest) is inside a stretch whose hash still matches. The sources are read only when something asks for them, and once per branch revision, not again for each appended entry; they are not read for a checkpoint our summary does not name in `supersedes`. With a competing extension present the checkpoint is never replaced, only warned about, and a cut does not read its sources.

If the summary outgrows `summaryTokens`, its oldest records are condensed rather than dropped. The extension picks the oldest items of the largest record sections, enough to bring the summary down to 60% of its budget, and a second model call rewrites them as fewer bullets that keep their entry ids, with id ranges for longer runs. The condensed items take the place of the originals. This runs in the background together with the historian and changes only the stored summary entry; the model sees the result at the next cut, which rewrites the context block anyway, so condensing adds no cache break. Dropping the oldest items remains the fallback when the condenser fails or does not get the summary under budget. Either way the originals stay in the log.

A test in `core.summary.test.ts` measures retention over 60 historian passes with a 1,200-token budget and a mechanical condenser that keeps only the id range: dropping still accounts for 11 of 60 early rounds, condensing for all 60, with 7 condenser calls. A live run on `gpt-6-luna` with a 700-token summary budget condensed once, kept all ten release codes in the final summary and answered every recall question.

The historian prompt tells the model explicitly that results belong in *Facts and findings* and never in *Current state*. In the first live run the model had put release codes into *Current state*, a replace section, so every run deleted the previous ones.

*Current state* is two bullets, *Done:* and *Next:*. *Next:* names the concrete step the agent starts with after a cut, so a cut at the end of a task (see the cut policy) leaves a session that can carry on without rereading the archived stretch. On one real 41k-token stretch, claude-haiku-4-5 wrote a vague progress line with the old wording and a concrete next step with the new one, in two of two runs.

### The notebook

The notebook is the agent's own working state: goal, constraints, decisions, plan and position in it. The agent replaces it with the `notebook` tool. It is carried verbatim into every cut block and limited to `notebookMaxBytes` (8 KB by default). Unlike the summary, nothing but the agent writes it.

### Search over the unchanged log

The agent gets two tools for history that has left its context:

- `history_search` finds entries by keywords. Search is lexical (BM25). Entry ids in the query resolve directly. Each hit names the user message that opened its turn.
- `history_read` returns an entry, or the summary of a cut, by id, in pages of any length.

Search and read cover the whole text of every entry and every compaction summary, however long: an entry is cut into chunks of 4,000 characters that are tokenized one at a time, and a read pulls one page of the entry's rendering without building the rest. A search page is bounded by characters of work (4,000,000), not only by entries (2,000), and ends with an opaque cursor for the older text. The cursor names the last item of the branch the search began on: entries appended since do not invalidate it and the page says how many are new, a branch that no longer holds that item does. It also names a piece of the entry's rendering near the place to resume, so a continuation costs what the first page costs and does not render the text before it again; an abort is noticed between pieces, and an object's values are looked at one at a time. The key list of a very wide object is taken once, by the first page that reaches it, and kept for the later ones. A read continues by offset and still walks the pieces up to it. Every answer says its text is historical evidence, not a current instruction; entries an edit replaced or omitted say so, and a replaced one also shows its effective text after the edit. Only text is archived: an image reads as `[image]`.

The index sees, for every entry, the call a tool result answers (so `report-4` finds the output of `read report-4.txt`), the content, and the calls an assistant made, with their whole arguments. Compound names such as `report-4.txt` or `gpt-6-luna` stay findable as a whole. The results of `history_search` and `history_read`, and the agent's calls to them, are not indexed, so a search never finds earlier searches.

### Cut policy

| Moment | Condition | Reason |
|---|---|---|
| Before a new user prompt (interactive) | prompt ≥ soft threshold | `watermark` |
| Between two requests of a run | interactive: prompt ≥ hard threshold; headless, worker or a queued message: prompt ≥ soft threshold | `watermark` |
| Before a new user prompt | prompt ≥ `coldCutMinTokens` and the model changed | `model` |
| Before a new user prompt | prompt ≥ `coldCutMinTokens` and the cache is older than its lifetime | `cold` |
| Next request of a run, or next prompt | another extension reported a finished task on `context.cut-request`, and prompt ≥ `taskCutMinTokens` | `task` |
| Host compaction (pi only) | pi's threshold, overflow or `/compact` | pi's reason, or `manual` |

There are two thresholds (`cutThresholds` in `core/policy.ts`). The soft one is the watermark: the smallest of `watermarkTokens`, `hardCapTokens` and the model window minus twice the reserve pi resolves for the model (32,768 with pi's default). The hard one is the soft one plus `deferMarginTokens`, capped at the same window and ceiling. In an interactive session the routine cut waits for the next user prompt: the run's knowledge is already condensed in the answer, the turn stays whole, the notebook is current, and the cut often meets a cache that went cold during the user's pause anyway. Mid-run the hard threshold is only an emergency brake for one long run. A headless run, a worker or a run with queued messages has no user prompt to wait for, so it cuts at the soft threshold between requests as before. Keep-warm pings stop once the prompt reached the soft threshold, because the next prompt cuts anyway. The margin of 30k is an estimate, not a measured optimum; the ledger records where each cut happened (`position`) so it can be tuned.

A cut that would not bring the prompt below its threshold is refused (`cutAccepted`), because it would be followed by another at the next chance. This happens when the watermark is too low for what a cut carries, or on a small model window. Once the prompt has reached the hard threshold, a cut is made anyway when it frees at least a quarter of the prompt (`HARD_CUT_MIN_SHARE`): refusing it would let the prompt grow until pi compacts near the model window, at over 900k tokens on a 1M window. A cut right after such a cut archives too little to qualify, so these cuts do not follow each other either. The projection (`projectedTokens`) scales the estimated change by the measured ratio of prompt to estimate; on 54 cuts of October 2026 it missed the next prompt by -0.2k on average (RMS 16k). Every cut is judged in its envelope (`CutEnvelope`, `planCut`): the system prompt and the active tools' declarations, estimated from their text, plus what the cut carries and keeps, and the reserve pi resolves for the model (`compaction.reserveTokens` and its model override). The expected prompt (`expectedTokens`) never falls below system prompt, tools, block and kept history, because a large system prompt inflates the projection's ratio. A cut that would not leave the prompt below pi's own compaction (window minus reserve) is disabled: our `session_before_compact` handler returns nothing, never an empty result, so pi's native compaction or another extension's result runs. All of it is an estimate, not a provider count: the first request after a cut reconciles it (`cut-reconciled` with `estimated`, `prompt` and `miss`), and when that request would not have accepted the cut, the identical cut (same first kept entry and block size) is not made again until more history can be archived. A refused cut writes a `cut-refused` ledger line (`why`: `short` or `repeat`) with the projected size, a disabled one `cut-disabled` (`why`: `no-room`); a planned cut whose next prompt is still at or above the watermark is reported too. Each kind is shown once per session (a notification, or stderr without a UI), and the latest one in `/context`.

The minimum for cold and model cuts avoids cutting small prompts that would barely shrink. A task cut breaks a warm cache, so its minimum sits closer to the watermark, where a cut comes soon anyway; it moves that cut to the boundary between two tasks. A reported task is used by the next cut chance, whether it cuts or not, so a request never fires in the middle of a later task. Any extension can report one with `pi.events.emit("context.cut-request", {})`. The request is also written to the log as `context.task-done`, so the next prompt still honours it when the pi process was reloaded or restarted in between; SANDY keeps a pi process loaded for hours, but a reload or restart starts a fresh one. Cache lifetime is measured from the end of the last response, which slightly overestimates warmth; the error goes toward skipping a free cut, never toward an extra break.

### Configuration

The extension reads these settings from its config file (see *Configuration* below).

| Setting | Default | Meaning |
|---|---:|---|
| `watermarkTokens` | 120,000 | Soft threshold: cut at the next prompt (or between requests when headless) once the prompt reaches this size |
| `deferMarginTokens` | 30,000 | How far an interactive run may grow past the soft threshold before it cuts mid-run |
| `hardCapTokens` | 200,000 | Ceiling whatever the model window allows |
| `keepRecentTokens` | 16,000 | Recent history kept verbatim after a cut |
| `keptCap.mode` | `shadow` | `off`, `shadow` or `on`; see *The kept-history cap*. `on` needs a passing probe record |
| `keptCap.tokens` | 24,000 | Most history a cut keeps once the cap is on; at least `keepRecentTokens` |
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
| `historian.model` | unset: the session's current model | `provider/model` for summaries (pi only). When set, it must exist in pi; otherwise startup fails, and the session model never stands in for it |
| `historian.fallbackModel` | none | `provider/model` asked when the first model fails, for example a session model that cannot turn thinking off and spends `maxOutputTokens` on it (pi only). Must exist in pi when set. Its request is an attempt of its own |
| `historian.fork` | false | Ask a summary as a fork of the main model's last finished exchange, read from its warm cache, when that is predicted to cost less than the historian model. It works on every provider API whose pi-ai client sends through the fetch it is handed (Anthropic Messages, OpenAI Responses and Codex, Azure Responses, Chat Completions, Mistral, pi-messages); Google's and Bedrock's clients send through their SDKs, so their summaries stay isolated. No format is known by name: the fork reads the payload's message list (`messages` or `input`) and output limit field (`max_tokens`, `max_output_tokens`, `max_completion_tokens`, or none for Codex). The fork is the captured main request byte for byte, then the main model's own answer to it, that answer's tool results and one user turn that frames the summary as a separate task, all three as pi-ai serializes them for the main model (signed thinking, encrypted reasoning and tool IDs included; the system or developer and effort items pi-ai puts between messages are left out). It keeps the main request's thinking settings and sets only its output limit, in the field the capture uses: the summary's plus any fixed thinking budget, twice the summary's for an OpenAI-style reasoning request, none for a format without a limit field. It is priced at that limit and at the catalogue's tier for its whole prompt, the carried answer and tool results as fresh input. It is not forked while the answer is missing, cut off or waiting for tool results; when the capture, the exchange, the task and the output limit pass the main model's context window or that limit passes its output limit; or when the request carries a tool the provider runs (web search, code execution, MCP servers), in the tool list or declared inline in a message. A fork that does not keep the cached prefix and the exchange is refused before it is sent and the summary goes to the historian model. The capture is the payload this extension's `before_provider_request` handler saw; pi has no hook for the payload as it finally leaves. A handler that runs later and changes that same object in place is caught before any fork is sent: the capture no longer matches the object pi sent, so it is not forked (`changed`). A later handler that returns a replacement payload stays invisible until the fork reads less from the cache than predicted: that one fork is paid as a miss, and the cache-read check after sending switches the fork off for the session, as a tool call in the answer does. A fork is an attempt of its own, stored before it is sent; one that fails after sending is never resent. Each request sent is a `historian-route` line in the ledger |
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

The extension brings the engine into ordinary pi sessions (pi 1.3.0 or later). It is built on pi's own primitives: **a cut is one native pi `compaction` entry**, built without a model call, and pi's own projection of the session file yields the model view. The extension never rewrites requests. The session file stays the only source of truth and only ever grows.

The module map (what each file under `src/core/`, `src/historian/` and `src/pi/` owns) is in `AGENTS.md` in the repository (not part of the installed package); each file's header says how it works.

### Installation

The package declares itself as a pi package (`"pi": { "extensions": ["./index.ts"] }`), is `private` (it is not published to npm) and ships as a tarball: `npm pack` in `pi/context` makes `pi-context-<version>.tgz` with the sources, `examples/`, `tools/measure.ts` and this README, and nothing of the tests, fixtures or lockfile (`files` in `package.json`).

```sh
npm pack                                  # in pi/context
mkdir ~/pi-plugins/context && cd ~/pi-plugins/context
npm install --legacy-peer-deps /path/to/pi-context-0.1.0.tgz
```

Then name the installed directory, `~/pi-plugins/context/node_modules/pi-context`, in `packages` of `<agent dir>/settings.json` (`~/.pi/agent/settings.json` by default). A checkout works the same way after `npm ci`: list the unit's directory. The plugin carries no pi packages of its own: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `typebox` are peer dependencies that pi's extension loader supplies to every extension, which is why the install above leaves them out. It needs no BB environment and no other file of the repository.

`npm run smoke` checks exactly this on a disposable machine state: it packs the unit, installs a pi host (`-- --pi <version>`, default the version in `devDependencies`) and the tarball into separate empty directories, lists the plugin in a throwaway agent directory's `settings.json` and loads it through pi's real loader in a child process with no SANDY or BB variables. There it resumes a session written under the old names (an old notebook and a compaction summary written by another extension), moves an old `sandy-context.json`, runs `history_search`, `history_read`, `notebook` and `/context`, checks that no `sandy` tool or command exists, and checks that a `context.json` with an unknown field stops the load. It exits 0 only if all of that holds, and it imports nothing from `src/`.

Requirements: pi 1.3.0 or later, checked by capability when the extension loads (a pi without a needed API stops the load with a message naming it), on a runtime that runs TypeScript directly (Node with type stripping, or Bun).

> **Do not run it together with Magic Context.** Both take over context management; running both would make each other's changes look like unplanned breaks. Disable one before enabling the other.

### How it hooks into pi

| pi event | What the extension does |
|---|---|
| `session_start` | Resets per-session state (ledger, index, request tracker) and schedules the historian |
| `agent_start` | Starts the per-run counters of the signals |
| `tool_result` | Counts tool output tokens, delegations through sandy, and after a cut the history calls and re-reads of archived files |
| `turn_end` | Publishes the signals on `context.signals` and schedules the historian. If the prompt reached the hard threshold (or the soft one when no user prompt follows), appends a `compaction` boundary entry with the cut (`watermark`). Before that it appends a `context_edit` for each fresh top-level `read` result that repeats an earlier one (*Identical reads kept once*) |
| `input` | Before a new prompt, when idle: if the prompt reached the soft threshold, or the cache is cold or the model changed and the prompt is large enough, awaits `ctx.compact()`, which pi routes through `session_before_compact` |
| `session_before_compact` | Replaces pi's compaction (threshold, overflow, manual, or the extension's own cold/model request) with the planned cut, returned instantly |
| `session_compact_failed` | Clears the pending cut reason |
| `session_tree` | Marks the next request as a planned `branch` break |
| `before_provider_request` | Records the shape of the request body for the continuity check |
| `message_end` | Judges the request once the provider answered, updates the ledger, adds usage |
| `session_shutdown` | Aborts a running historian call |

The watermark the extension uses is the smallest of `watermarkTokens`, `hardCapTokens` and the model's context window minus 32,768 tokens (twice pi's 16,384 reserve), so pi's own threshold compaction never fires first.

The cache lifetime for the tier (short, or long when `PI_CACHE_RETENTION=long`) comes from the first source that names it: `cacheTtlSeconds` for `provider/model`, then for `provider`, then the model's declared `promptCache`, falling back to `fallbackCacheTtlSeconds` (or one hour for the long tier). The table holds measurements, because a provider's real lifetime can differ from its catalogue: on 2026-10-20 a Codex (`gpt-6-astra`) cache still hit after a 20-minute pause without the long tier and was cold after 40; a Claude Haiku cache hit after 20 minutes with `PI_CACHE_RETENTION=long` and was cold without it. The ChatGPT subscription backend now keeps a Codex cache without expiry, so `openai-codex` has an infinite lifetime in both tiers (`Number.POSITIVE_INFINITY` in code; a JSON config that wants expiry back sets a number of seconds): a Codex session is never pinged and never cut for a cold cache, only at the watermark and on a model change. The API (`openai`) is not affected and still takes the model's declared lifetime.

`keepWarmDue` (`core/policy.ts`) decides whether a waiting session gets a keep-warm request. It asks only when the session's next prompt is expected after the cache expires, the cache is still warm, it expires within `KEEP_WARM_LEAD_MS` (one minute) and the next prompt would not be cut anyway (at the watermark a warm cache would be thrown away): a Claude session on the long tier waiting for a reviewer is warmed after 59 minutes, a Codex session never. The cache is counted from the **start** of the request that wrote or last read it, which is where the provider starts its lifetime, not from the end of the answer: with a 90 second answer on a 5 minute cache, 4:05 after the answer is already 5:35 after the start, and nothing is sent. Then it compares cost: every request until that prompt plus the prompt itself reads the whole context from the cache, while going cold writes the context again, or only the carried tokens when the prompt is above `coldCutMinTokens` and gets cut first. With prices of read 0.1 and write 1.25 times the input price and an 80k prompt that leaves 26k carried, two requests pay off and twelve do not.

The request itself (`warmOnce` in `src/pi/keep-warm.ts`) is a side request, not an agent turn: it replays the captured last main request of the session with one output token through pi's model registry, the way the historian's fork is sent, so it adds no message to the session, runs no tool and cannot start work. A guard on the outgoing body checks the captured head and every captured message unchanged and the one-token limit; nothing leaves otherwise, and the capture must still equal the payload pi handed our `before_provider_request` handler (`captures.unchanged`). Only requests the module can replay exactly are sent: the Anthropic Messages API (`PING_APIS`; OpenAI's Responses API refuses an output limit under 16 tokens and Codex has none, so a ping there would buy an answer), no fixed thinking budget (a budget derives from the output limit, so one token would change the request; adaptive thinking is fine), no provider-side tools, the model of the capture. For any other session pi's own cache warmer stays in charge. One question, the `KeepWarm` controller's plan (`src/pi/keep-warm.ts`), says whether a ping of ours will run for the window: the session is idle, the signal is valid and not expired, the last main request is replayable and unchanged on this route, this window has not been tried, and `keepWarmPlanned` holds (the `keepWarmDue` rules without the one-minute lead). Our timer asks it, and so does the `cache_warming_decision` handler (`KeepWarm.decide`): only while the answer is yes does the handler answer `stop`, so the window is paid once; in every other case (a changed capture, an expired signal, a failed or refused ping, a streaming agent) pi's decision stands. The stop is stored as `context.warming` with pi's own proposal. A refresh of pi's warmer already out (seen as a one-token request at `before_provider_request`, until `after_provider_response`) holds our timer back, and counts as the warm of the window when it succeeds; so does a historian fork reading the prefix. The other way round, a fork waits for a ping or a warm of pi's already reading the prefix, at most 120 seconds after that request started or until the historian's run ends, then plans again against what it left: forked from the renewed cache, or isolated when the prefix expired meanwhile. The ping carries the headers the main request left with, after every `before_provider_headers` handler ran, except the credential, which is pi's current one. Across pi processes on one session file a claim file `<session file>.keep-warm-claim` serializes the send, and a process that finds another's `start` or `end` record in the file for the window does not send again: a request without an end counts as tried. A record `context.keep-warm` is stored before the request leaves (`start`) and its usage after (`end`); it counts as a `keep-warm` charge of the engine, and never as an unplanned cache break, since it does not pass the payload hook the ledger judges. When the provider reads less than `FORK_HIT_SHARE` (95%) of the prompt, the cache had expired: that request rewrote it, and the engine sends no more for the session and hands the window back to pi's warmer. A request that failed or was refused is not retried for the same cache.

The pi extension asks every 30 seconds while the session is idle, and only when a signal file exists with `{ "until": <epoch ms> }`: `pi-keep-warm.json` in the Sandy thread's storage (`SANDY_THREAD_STORAGE`, or `BB_THREAD_STORAGE` from before the rename), else `<agent dir>/context/keep-warm/<session id>.json`. The thread storage lives on the machine that runs the worker, and a SANDY plugin reaches it from the server through the host-routed file API, so the workflow needs no access to the worker's agent directory. A workflow that parks a session for later writes the file and deletes it when it continues. Prices come from the model's catalogue entry, with Anthropic's long tier writing at twice the input price; without prices the ratio 0.1 to 1.25 applies. The timer does not keep a finished process alive, and it stops, and cancels a request in flight, when its session is gone. `test/pi-keep-warm.test.ts` runs a real pi session against a stand-in Anthropic server that models the prompt cache and shows the request's bytes, usage record, clock and stop rules. What it does not show yet: whether SANDY keeps an idle worker's pi process alive, and the cache hit of a real request. Sessions written before this version hold the old ping as a message and its answer; the model view leaves each such turn out whole, a tool call it ran and its result included, so a resumed session shows the model what the old version showed (`withoutPings`, also in a `context` hook, so the request never carries them), and their cost is still counted as keep-warm.

### Tools and command

**`history_search`**

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | required | Keywords |
| `limit` | integer | 8 (max 30) | Maximum results |
| `includeVisible` | boolean | false | Also search history still in context. By default, once anything is archived, only archived history is searched |
| `cursor` | string | none | Opaque cursor from an answer to the same query: continue with the older text |

Results list `#id · kind · time`, a snippet, the offset to read a match deep inside a long entry at, and the opening user message of the hit's turn. 8-hex pi entry ids and compaction ids in the query resolve directly. The extension's own search and read results are not indexed, so a search never finds earlier searches.

**`history_read`**

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | Entry id, with or without `#`; a unique prefix of 4 or more characters works |
| `around` | integer 0 to 10 | 0 | Also list this many neighbors before and after, masked |
| `offset` | integer | 0 | Offset in UTF-16 code units into the rendering; one in the middle of a surrogate pair moves back to the pair |
| `maxChars` | integer 500 to 60,000 | 12,000 | Characters to return; a page that does not reach the end names the offset of the next |

**`notebook`**: called without `text`, returns the notebook; with `text`, replaces it; an empty string clears it. Texts above `notebookMaxBytes` are rejected with an error that tells the agent to shorten it.

**`/context`** shows the status: prompt size and watermark, cuts on the branch, summary coverage, notebook size, historian runs and failures (and whether it is paused or unavailable), archived entries, the request classes of this process, and the cost and retrieval report (*The cost and retrieval report*). **`/context retry-historian`** frees a paused or waiting summary and starts it at once.

### What the extension stores

The engine's state lives in the pi session file, appended through pi's own APIs, plus a few files beside it (below):

| Entry | Contents |
|---|---|
| `compaction` | `summary` = the cut block, `firstKeptEntryId`, `details.context` = cut details plus `reason` |
| custom `context.summary` | The anchored summary state (`version`, `coveredThroughId`, `sections`, and `sources`, `partial`, `unsummarized`, `supersedes` when the historian made it), the historian's usage and model |
| custom `context.historian-attempt` | One record per step of a historian request (`start`, `end`) or the owner's `retry` marker; see *The historian and the anchored summary* |
| custom `context.notebook` | The notebook text (`text`), written by the notebook tool however it was called; sessions from before this entry kept it in the notebook tool result details, which are still read |
| custom `context.cap-shadow` | What the kept-history cap would remove at one cut (`mode`, `applied`, `cap`, `cutKeptId`, `cappedFromId`, counts, at most 500 ids and 50 paths, `deferral`, `promotions`: notes the capped cut gives back beyond the baseline's, 0 at pi's compaction, which promotes none); no content |
| custom `context.keep-warm` | A keep-warm side request: a `start` record before it leaves and an `end` record (`outcome`, usage). Sessions from before this record hold the old ping as a custom message of the same kind, which the model view leaves out |
| custom `context.warming` | One cache-warming decision of pi (`piAction`) and the action this engine returned (`action`), with `veto`, `requestsSeen` and `sent`, stored before a warm can leave |
| custom `context.retrieval` | A search, entry read or file read made inside another tool (codemode): the call id, tool, ids or path and whether it failed; no content |
| custom `context.notebook-reminder` | The reminder to update the notebook before a cut |
| custom `context.task-done` | A cut request from the `context.cut-request` channel, kept until the next cut chance so a restart still honours it |
| custom `context.duplicate` | Ownership of one repeated-read note (`alias`, `of`, `tokens`, `digest` of the note's text), written with its `context_edit`; no file content |

Files beside the session file:

| File | Contents |
|---|---|
| `<session file>.historian-claim` | The claim of the process that sends the session's historian requests (pid, host, heartbeat); a stale heartbeat frees it |
| `<session file>.keep-warm-claim` | The same for keep-warm pings, so a ping never waits for the historian |
| `<agent dir>/context.json` | The configuration (`configFile`) |
| `<agent dir>/context/ledger.jsonl` | The request ledger, one line per request, no content (`ledgerFile`) |
| `pi-keep-warm.json` in `SANDY_THREAD_STORAGE` (or `BB_THREAD_STORAGE`), else `<agent dir>/context/keep-warm/<session id>.json` | The keep-warm signal file, `{ "until": <epoch ms> }`, written by whoever parks the session (`keepWarm.file`) |
| `<agent dir>/context-kept-cap-probe.json` | The kept-cap probe record that lets `keptCap.mode` "on" start (`keptCapProbeFile`) |

The search index lives in memory and is rebuilt from the branch as needed. History archived before the extension's first summary on a branch stays searchable but is not summarized.

### The kept-history cap

A cut keeps about `keepRecentTokens` of recent history verbatim, but it starts at a user message, so a long turn can make the kept range far larger. The cap (`cappedPlan` in `core/cut.ts`, `capRemoval` in `core/kept-cap.ts`) moves the start of the kept range forward to the oldest user message from which the history still fits `keptCap.tokens` (provider tokens, default 24,000, never below `keepRecentTokens`). Rounds are never cut in the middle: a kept range that already fits is left alone (`within-cap`), and a newest round larger than the cap defers (`atomic-tail`, the baseline cut stands, there is no overflow exception). The cap is only planned for a cut the baseline makes; it never turns a refused or disabled cut into a made one.

| `keptCap.mode` | Effect |
|---|---|
| `off` | Nothing is planned. |
| `shadow` (default) | Every cut also plans the cap and appends a `context.cap-shadow` record. The cut, and so every request, is the baseline's, byte for byte. `/context` reports the cuts planned, the entries and estimated tokens the cap would have removed, how many deferrals, and how often the agent opened a removed entry (`history_read`) or read a removed file again afterwards, on the branch that holds the record and with a shortened id resolved as the retrieval report resolves it; a read that failed is counted apart. `npm run measure` prints the same cap lines over the sessions it reads. A shadow cut plans the cap from the entries the baseline keeps alone and plans no cut from the capped start. The count is a lower bound and is not a quality verdict: that the agent did not ask says little about whether it needed the history. |
| `on` | The cut keeps from the capped start. The extension **refuses to start** (invalid configuration) unless `context-kept-cap-probe.json` in the agent directory (option `keptCapProbeFile`) is a probe record for this cap that passes. The same gate applies to every path, overflow included. The record also names the model it was made for (`model`, `provider/id`), because whether the cap keeps answers right is a fact about one model. The startup check sees no model and only needs the record to name one; every cut that would use the cap reads the record again and checks it against the session's model. A record that was overwritten, failed or made for another model, or a model that was switched, does not stop the session: that cut keeps the baseline start, plans the cap in shadow and `/context` says "Kept cap evidence: none for this session's model" with the reason. |

The probe record (`core/kept-cap-probe.ts`) names the model, the cap (`tokens`, `keepRecentTokens`), the digest of the frozen 24-snapshot suite (`test/fixtures/kept-cap/`), the digest of the thresholds and the design (24 snapshots x 3 continuations x 3 repeats x 2 arms), and per snapshot how many of 9 runs answered right and how many history reads they made, with and without the cap. It is checked in this order: missing, malformed (including a verdict its numbers contradict), mismatch (another model, cap, suite, thresholds or design), failed. Thresholds, frozen before any run: the mean success with the cap may fall at most 3 points below the baseline's; at most 0.25 extra history reads per run; no snapshot where the baseline answered at least 6 of 9 may drop to 0; the cap must save at least 3% of the kept tokens over the suite. Changing a threshold changes the digest and invalidates every record. The paid run that writes a record (about $50 to $150) is backlog #16 and needs its own go; until then the cap is unproven and stays in shadow.

`node --experimental-strip-types tools/probe-kept-cap.ts --offline test/fixtures/kept-cap` is the free replay of the suite: per snapshot what the cap would remove and what the later work asked for, with no model and no network. The snapshots and their later reads are synthetic: the generator assigns the reads from a seeded shape rule, they are not observed session retrieval (that is what `npm run measure` counts on real sessions). The replay shows how much range the cap touches, not whether answers stay right or how often real work reads a removed entry; keep that qualifier with any aggregate copied from it. `tools/make-kept-cap-fixtures.ts` regenerated the suite deterministically; the committed files do not change after the freeze.

### Identical reads kept once

When a fresh top-level `read` result repeats an earlier successful one (same arguments, byte-identical text), the `turn_end` boundary replaces the **newer** result with a short note that names the path and the entry id of the earlier read (`history_read #id` opens it). The note says only that the read returned the same text, not that the file is unchanged (a truncated read shows part of it), and it stays true once the earlier read has left the context. The earlier read is never touched, so the cached prefix of the next request stays byte for byte the same; only the new tail is smaller. The log keeps the raw result, and a `context.duplicate` record marks the edit as the engine's own (no content in it). A third copy points to the first, never to the second, and a note is not made for results of other tools, errors, images, other ranges or arguments, changed content, results another extension edited, or reads inside codemode (a later slice). A saving under 150 tokens is not worth a note. Only the engine's own cut at a `turn_end` gives a note its full text back, in the same boundary and ahead of the cut, since that cut breaks the cached prefix anyway: one note per text whose every whole copy the cut archives. The cut, and the capped cut beside it, is planned on the history as it is after its promotions (the promoted text lands in the kept range the cap bounds), and left a note when the cut would miss its limit or the cap with the text. After any other cut (the engine's before a prompt or of pi's own compaction, or another extension's) the note stays as it is: editing it at a later boundary would break the prefix the request after the cut cached, and the note still names the entry `history_read` opens. A turn that read nothing and makes no cut does not project the branch for this. An edit another extension made to the result is never undone: the note is dropped from the engine's books instead; one made to the read call only leaves the note ours. `/context` reports the tokens collapsed as `dedupCollapsedTokens`.

### The cost and retrieval report

One report, from the session log alone, shared by `/context` and `npm run measure` (`src/core/accounting.ts`, `src/core/retrieval.ts`; both are pure reducers over session entries).

**Cost.** Every model request that left is one event: main, historian (primary, fallback, fork), condenser, failed and stale attempts, native cache warms, keep-warm requests, compaction and branch summaries, and usage a tool result carries. A request with usage is *known*; one that left without usage on record is *unknown*, and unknown is not zero: while one exists the report says `incomplete`, shows the known subtotal and the count of unknown requests, and prints no total. Prices are the catalogue's (tokens times the model's price list), not what a provider billed. Sources: assistant messages, `usage` entries, compaction and branch-summary usage and tool-result usage are what pi's `getSessionStats()` sums (`piCounted`; a test checks the two agree on a session file on disk); the historian's and condenser's requests are in none of them, so each attempt's `end` record carries its usage (`engineCounted`). A summary stored by a historian from before attempt receipts carries the usage of its requests itself (`usage`, and `condenseUsage` for the condenser); the report counts it unless a stored receipt of the same step and figures stands for it, so a current summary is not charged twice, and a summary with no readable usage is unknown. An attempt without an end, or an end without usage (the error named none, or it was cancelled), is unknown. A keep-warm request (`context.keep-warm`, start and end records) carries its usage in the end record, like an attempt (`engineCounted`); one without an end, or an end without usage, is unknown. An old ping turn in a session written before this version still owns the assistant messages up to the next user message (`piCounted`). pi's warming handlers share one event, so the engine stores each decision (`context.warming`: `piAction`, `action`) before a warm can leave. A decided `stop` is a known skip (cost zero, not a request) only when this process saw requests pass `before_provider_request` (`requestsSeen`), so it would have seen a warm leave; a warm that leaves after a stop was sent by a later handler's override, and the engine records it (`sent`): it counts as a request, unknown unless a `cache_warm` usage entry follows. A `warm` with no `cache_warm` usage entry after it is an unknown request, and so is a stop record without `requestsSeen`. An assistant message that ended in `error` or `aborted` with no usage (all zero) is unknown, not free; a success that cost nothing stays known. `/context` reads the session file on disk merged with what this process holds, each entry once by id, so a request another pi process wrote to the same file counts too. `npm run measure` reads a session and its forks (a fork's header names the session it came from; when that file is not in the set, the session holding the first entry the fork copied) as one family, because a fork copies its ancestors under the same ids: each request counts once. Retrieval is reduced per label context of a family: a fork of a labelled session that has no label of its own is a `proxy` session, and siblings with different labels are read apart.

**Repeated reads.** `dedupCollapsedTokens` sums the notes still in force (*Identical reads kept once*); it is a count of tokens kept out of later requests, not a request, and is not in the cost.

**Retrieval.** Three measures, kept apart. *Re-reads after a cut*: file reads of a path whose earlier read the cut archived, that is read before the entry the cut kept from; a read the cut kept is no re-read. Nested reads are included (the compat series of the older 206 of 3,470 count). *Archive searches*: how many returned anything, and how many returned the entry that was needed; existence and relevance are separate numbers. *Tokens until the first relevant read*: fresh tokens (input, cache writes, output) from a cut to the first read of a needed entry, one episode per cut. A fixture says what was needed in a hidden sidecar `<session>.labels.json` (`{"needed": ["entry id", …]}`), and the report is then `labelled`. A live session has no label, so a hit counts only when the same entry is read within the next two turns, and the report is a `proxy`. Ten hits nobody reads are not recovered context. Searches and reads made inside another tool (codemode) are only partly in the transcript, so the extension stores them as `context.retrieval` records (ids and paths, no content) and the report counts each call once by its id. A read counts for the entry the archive resolved, which its result names, not for the prefix the model typed; a read that failed is counted apart (`failed reads not counted`), never as a read, a re-read or recovery. A session is a tree: a search, read or cut counts only for the entries after it on its own branch, so a search on one branch never credits a read on its sibling. Labelled and proxy sessions are reported apart, never mixed, and a label counts only in the session that has it.

```
$ npm run measure -- 30 <fixture dir>
Cost incomplete, catalogue prices (not billed cash): $6.00 known so far over 8 requests, plus 1 requests that left with no usage on record (unknown, not zero); 1 cache warms skipped
By source: main $2.00 (6), historian $3.00 (2, 1 unknown), keep-warm $1.00 (1)
Re-reads after a cut (compat series): 1 of 2 file reads (0 inside other tools)
Archive searches (labelled: …): 1 searches, 1 found something, 1 found the entry that mattered; 2 entry reads (1 inside other tools)
Recovery after a cut: 1 of 1 cuts ended in a relevant read; tokens until the first one: median 70 fresh tokens
```

### The request ledger

Each request is judged once the provider has answered, against the last request the provider **accepted**. A request the provider refused (error or abort with no prompt tokens) is classed `rejected`; it leaves no cache behind, so it is not used as the comparison base, and a planned cut stays pending until a request carrying it is accepted. This rule came from a live test in which Anthropic refused every request: before the fix, each refusal counted as an unplanned break.

One JSON line per request is appended to `<agent dir>/context/ledger.jsonl`:

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

A refused cut writes `{"class":"cut-refused","why":…,"reason":…,"tokens":…,"limit":…,"projected":…,"hard":…,"fixed":…,"reserve":…}`; `cut-disabled` has the same fields, `cut-reconciled` has `reason`, `estimated`, `prompt`, `miss` and `failed` when the cut is not repeated. The same signals, with the prompt size and both thresholds, are published after every turn on the event bus channel `context.signals` and shown by `/context`. The engine acts on none of them: deciding when to delegate belongs to another extension.

The ledger says whether the cache held; what the tokens cost comes from the session logs. `npm run measure -- [days] [dir]` reads the pi session logs changed in the last days (default 7, `~/.sandy/pi-bridge-sessions`) and prints JSON: `cost` from the cost report (total, known subtotal, complete, requests, unknown), `main` for the main model's answers only (requests, prompt tokens, cache hit, no cost), cuts by reason and, once task cuts happen, the median prompt tokens per finished task. It then prints the cost and retrieval report above, labelled for sessions that have a `<session>.labels.json` beside them. Run it before and after a policy change over the same span.

### Configuration

Settings from the table under *Configuration* in *The engine* are read from `<agent dir>/context.json` if it exists (camelCase keys, partial objects allowed). The file is read strictly: an unknown field, a value of the wrong type, a malformed `provider/model` reference or settings that contradict each other stop the load with a message that lists every problem. A `historian.model` or `historian.fallbackModel` that pi does not know stops startup when the session starts:

```json
{
  "watermarkTokens": 100000,
  "historian": { "model": "openai-codex/gpt-6-luna" }
}
```

Embedders can call `createContextExtension(options)` instead of using the default export, with `config`, `configFile` (path or `false`), `ledgerFile` (path or `false`), a `now` clock and a custom `summarize` function.

**Caveat.** For a cold or model cut, pi's `ctx.compact()` first runs pi's own preparation, which refuses unless there is history older than pi's `compaction.keepRecentTokens` (20,000 by default). With the default `coldCutMinTokens` of 60,000 this never matters. Configurations that set `coldCutMinTokens` below about 20,000 also need pi's `compaction.keepRecentTokens` lowered.

### Moving the old host files

Before the rename the engine kept its settings in `<agent dir>/sandy-context.json` and its ledger and keep-warm signals in `<agent dir>/sandy-context/`. When the extension loads, before it reads the config, `migrateHostFiles` (`src/pi/migrate.ts`) moves each to its new name, `context.json` and `context/`, without ever replacing what is there: the file by a link to the new name and then an unlink of the old one, the directory by one rename. The first session start tells the user what moved (a notification, or stderr without a UI). It looks at the new name before the old one: a start that sees both names on one file has found a parallel start between its link and its unlink and goes on, one that sees two different files has found a real conflict, and a start that loses the race finds the new name and goes on.

Both config files present stops the load with a message that names both paths, and so does an old config file that cannot be read or is not JSON; nothing moves then, so neither file is lost. So does an old config that a process loaded before the update saved again between the link and the unlink: the start keeps it and does not unlink it. Both ledger directories present only warns at the first session start: the directory holds the ledger and keep-warm signals, no settings, so the engine leaves both as they are and goes on in `context/`. Both names appear when a pi process loaded before the update writes the old names again: reload every loaded pi process on the host with `bb pi-lifecycle reload`, then merge or remove the old copy by hand. That reload is what keeps old writers out; the check before the unlink and the unlink are two steps, and a save in the instant between them is still lost. Session logs need no move: the old entry kinds, the `details.sandyContext` marker and the `<sandy-context>` cut tag are read by `src/core/records.ts`.

### Measured results

Every number below carries its kind. **Measured** was read from a run or a log with the command named; **inferred** was worked out from measured parts; **not measured** says what is missing. The plan's figure of about 44% saved today and about 16% more from the levers came from a replay and was never measured on a live session, so it is not repeated here.

**Cost and retrieval report on recorded sessions** (measured, no model call, `npm run measure -- 30` on 2026-10-31). It read 501 session logs of the last 30 days in `~/.bb/pi-bridge-sessions` (481 sessions). They were written by the bridge before this extension was installed, so the 533 cuts in them (504 at the watermark, 28 cold, 1 manual) are the old mechanism's, not this extension's.

| | Before slice 10 (the `main` series) | After slice 10 (the cost report) |
|---|---|---|
| Counted | the main model's answers: 20,412 requests, cache hit 94.4%, 93,133 prompt tokens per request; no cost | 20,437 requests from every source, each once |
| Cost | none | $1,125.29 known (catalogue prices, not billed cash); 161 requests left no usage and are reported as unknown, never as zero |
| Sources | main only | main $1,124.72, native warm-up $0.4544 (23), tool $0.1083 (2) |

The difference is visibility, not savings: the report adds $0.57 of charges and the 161 unknown requests that the old series did not show. Two retrieval figures from the same run are proxies, not proof: 1 of 533 cuts ended in a relevant read (median 61,619 fresh tokens before it) and 2 archive searches were counted, 1 of which found the entry that mattered. The logs are local to the machine that ran the command and are not in the repository, so these figures are not reproducible from a checkout; the reducers behind them are tested on fixtures (`test/core.accounting.test.ts`, `test/core.retrieval.test.ts`, `test/core.measure.test.ts`).

**Fork against isolated summary** (measured, one paid run on 2026-10-31, `tools/probe-historian-fork.ts --send`, main `anthropic/claude-sonnet-5-5`, 39,789 prompt tokens). The fork cost $0.0314 and wrote a 1,600-character summary (53,193 tokens read from cache). The isolated request to the historian model `anthropic/claude-fable-5` cost $0.1891 and wrote 4,527 characters. This is one run on two different models, so it shows what each route costs, not how much the fork saves; both answers passed `validateCompletion`. The fork stays off unless configured.

**Kept-history cap in shadow** (measured, offline replay of the 24 frozen synthetic snapshots, `node --experimental-strip-types tools/probe-kept-cap.ts --offline test/fixtures/kept-cap`, cap 15,000 estimated tokens). 12 snapshots would lose range, 8 are within the cap and 4 are deferred as an atomic tail. The 12 would drop 6,400 to 10,980 tokens each (for example s09: 21,520 to 12,495 kept). Of the 56 entries the cap would remove, 6 were asked for later after masking. The snapshots are synthetic, so the share of tokens removed does not carry over to real sessions (inferred: the 7% estimate in the plan is not confirmed by this). Whether answers stay right with the cap on is **not measured**: that needs the paid quality probe (backlog #16), and the cap stays off until a passing probe record exists.

**Not measured:** a comparison of the cost of the same work with and without the extension, and the cache-hit change from planned cuts, on a live session. A saving figure needs both.

### Tests and the live runner

How to run the unit tests, the integration tests on pi 1.3.0 and 1.4.0 and the smoke check is in `AGENTS.md` in the repository (not part of the installed package). The two runs that need credentials or send paid requests:

```sh
npm run test:live            # live run against the fixed model, needs OPENAI_API_KEY
node --experimental-strip-types tools/probe-historian-fork.ts [--send]   # fork vs isolated summary on real models
```

The fork probe sends one main request, then the same summary as a fork of it and to the historian model, and prints each one's cache reads, usage and cost, whether `chooseRoute` predicted the cheaper route and whether each answer passes `validateCompletion`. It uses pi's stored credentials (`--main`, `--historian` as `provider/model`) and is a dry run without `--send`. Each request goes with provider retries off and an explicit output limit (`--first-output` for the main request), and is priced before it leaves at its worst case: the payload as built, at the dearer of input and cache-write rates with a margin on the token estimate, plus its whole output limit; one that would take the run past $1.50 is not sent. On 2026-10-31 with Sonnet as main and Fable as historian model, the fork read the whole 47k prefix from cache at its lowered output limit and cost $0.024 against $0.216 isolated, as predicted, but Sonnet answered the probe's last user turn ("Reply with OK.") instead of writing the summary. The fork has since carried the main model's own answer and framed the summary as a separate task: in a second run that day (same models, 53k prefix, 7k of evidence) the fork read 53,193 cached tokens, as predicted, and wrote a valid summary for $0.031 (predicted $0.060 at its 4,000-token limit) against $0.189 isolated (predicted $0.272); its summary was shorter (1,600 against 4,527 characters) and kept every fact line. One run on synthetic evidence is not enough to turn it on, so the fork stays off by default.

The integration tests run the extension inside the real pi runtime with pi's faux provider: watermark cuts, cold and model cuts, background summaries carried into a cut, search and read, append-only session file and zero unplanned breaks. The faux provider sends no real request payloads, so the ledger is exercised live only.

The live runner (`test/live/run.ts`) creates a workspace of ten report files, each hiding a release code in about 260 lines of filler, and asks the agent to read them one by one with a low watermark, then to recall codes, a rule and a detail from memory:

```sh
node --experimental-strip-types test/live/run.ts --fast --thinking=low --watermark=20000 \
  [--no-historian] [--idle=330] [--cold-min=8000]
```

`--fast` sets `service_tier: "priority"` on every request through `before_provider_request`. The model is fixed: `MODEL` in `test/live/run.ts`. The only credential is `OPENAI_API_KEY` from the environment; pi runs with a throwaway config directory, so no stored login, extension or setting of the user is read. Without the key, and always in CI, the runner is skipped; a provider error such as a rejected key stops it. It writes `report.json` plus the session file to a temporary directory.
