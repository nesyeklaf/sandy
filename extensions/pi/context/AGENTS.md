# pi/context

Cache-aware context management for long pi sessions. Each file's header says how it works; the design and its
measurements are in `README.md`. The Pi Durable engine stayed in Sandy (`packages/context/src/durable`).

- `src/core/`: pure functions of the log (`LogEntry[]`) and the config. No I/O and no pi import, so the model view can
  always be rebuilt from the log. `policy.ts` when to cut, `cut.ts` what a cut carries (`CutFold` reads the log newest
  first in pages; `planCut` feeds it a whole log), `historian.ts` and `summary.ts` the anchored summary, `attempts.ts` the historian's attempt records and retry rule, `search.ts` and
  `tools.ts` the BM25 search and the three agent tools' texts, bounds and logic, `ledger.ts` and `continuity.ts` the
  request ledger, `skills.ts` the skills a cut names for rereading, `duplicates.ts` which fresh read results repeat an earlier one and which notes our own turn-end cut gives their text back (one per text), `kept-cap.ts` the kept-history cap (what it removes, the shadow report) and `kept-cap-probe.ts` the gate for its mode "on" (frozen thresholds, probe record check), `cap-record.ts` its record, `kinds.ts` the entry kinds the engine writes (all under `KIND_PREFIX`), `records.ts` the one reader of
  stored records under the current and the pre-rename `sandy-context` names, `messages.ts` pi-ai messages as log entries.
- `src/tools/schemas.ts`: the TypeBox schemas of the three tools, built from the core's texts and bounds.
- `src/historian/`: the background historian both adapters run, without a host import (`Historian`, `HistorianBranch`).
- `src/pi/`: the adapter to pi (`index.ts` is the entry pi loads). It reads the log, calls the core and stores the result.
  `historian.ts` sends the historian's model requests: as a fork of the main model's captured request with its answer and tool results, or isolated.
  `captures.ts` holds the captured main requests (`CapturePool`) the fork and the keep-warm ping both read again: each capture keeps the headers its request left with, which both replay (`replayOptions`), and one cache clock (`touchedAt`, advanced by `touch` on every read of the prefix), and the pool admits one refresh at a time (`admit`, consumed by the ping and the fork; pi's warmer, which cannot be held back, is only marked with `refresh`): a ping waits for its next tick while another request reads the prefix, a fork waits for it (`settled`, bounded by each mark's lease, `REFRESH_LEASE_MS` for the ping and pi's warmer, and by the historian's abort) and plans again against the clock it left, so the fork, our ping and pi's warmer never read one idle window at once.
  Reuse a capture (fork, keep-warm ping) only after `captures.unchanged(capture)`: a later `before_provider_request` handler that changed pi's payload in place makes it stale. A handler that returns a replacement stays invisible; the fork's cache-read check after sending turns the fork off for the session.
  `migrate.ts` moves the pre-rename config file and ledger directory once at load, never replacing a file: a config
  conflict stops the load, a ledger directory conflict only warns and the engine goes on in the new one.

Rules:

- The kept-history cap stays in `shadow` unless a passing probe record for the frozen suite and the session's model exists (read again at every cut that would use the cap); no path (overflow included) goes around that gate. The suite's later reads are synthetic: say so wherever its numbers are shown. Tests and fixtures of the suite never change after the freeze.
- A cut is a planned cache break. A change that adds an unplanned one is a bug the ledger must show.
- The core never assumes a host's entry ID format; the caller names a cut's reason and may choose where the kept history
  starts.
- Archive work is bounded by characters, not entries: `openArchive` (`archive.ts`) renders an entry lazily (`renderChunks`), never whole.
  A read pulls one page (at an offset it still walks the pieces up to it); a search tokenizes chunks of an entry in two passes (equal to `SearchIndex` for single-chunk entries),
  stops at `scanChars` or `SEARCH_SCAN_LIMIT` entries and checks its signal per chunk. The cursor names the branch's last item, the place to resume and a `Mark` (a piece of the rendering, `serialize.ts`)
  to render from, so a continuation does not replay the prefix: appends keep it valid, a changed branch rejects it. A mark has a frame per level of JSON, so the cursor is bounded by its length (`MAX_CURSOR_CHARS`), not by depth. An object wider than `WIDE_KEYS` has its key list taken once and kept in `serialize.ts` (`keysOf`); pages do not list it again, but the first one does, and a mutated object would keep its old list. Compaction summaries are documents like entries. A `#<id>` in the query is read directly, whatever its age. An entry a foreign compaction hides takes its edit status from its latest edit; its text after the edit is projected only when the entry is rendered.
- Stored records are decoded only in `records.ts`; writers use the current names from `kinds.ts`, never the old ones.
- What the engine reads from a log it validates there, whoever wrote it. `records.ts` skips a malformed record; the tape's
  `StateFold` (`pi/session.ts`) then skips a notebook over the active `notebookMaxBytes`, a summary over the active
  `summaryTokens` budget, and a summary naming an entry that does not stand on the branch before it (`offBranchAnchor`
  in `summary.ts`: coverage, projection mark, partial entry, superseded checkpoint, every stretch in order). The earlier
  valid one stays. Every `SessionTape` takes the active limits (`StoredLimits`), so cuts and the historian decide alike.
- The request ledger hashes the payload the provider received (`requestShape`) and keeps no content. At most `LEDGER_CONVERSATIONS` ledgers stay in memory.
- A historian answer is a summary only after `validateCompletion` and `commitSummary` (`core/historian.ts`): complete, sourced, and the branch unchanged where it read. `selectEvidence` accepts only an `EffectiveHistory` from the tape, so edits and checkpoints are always applied. Never clip an entry before the historian; show spans.
- Every summary item but the topic cites its entries, and `SessionTape` judges them by branch position: an edit or omission inside a summarized stretch drops every item citing any entry of it (ranges included) and records the stretch in `unsummarized`, which `selectEvidence` works off before the forward coverage. A digest covers the entries of its stretch that no edit omits, so a stretch summarized again settles. Never keep an item whose stretch no longer matches its digest. A range is read in the history's order (`order`, required by `applyCondensed`); `idsBetween` slices an index built once per order, so judging a summary costs the branch once, not once per stretch.
- Every historian model request (summary, fallback, condenser) is an attempt stored in the session before it is sent (`core/attempts.ts`); `nextAction` is the only place that decides start, wait or pause (3 attempts, 30 s then 2 min, then `/context retry-historian`). No other count, timer or ledger line may stand in for it, and the clock is injected. Requests go out only through `#ask` in `historian/run.ts`, on a transport that does not resend (`summarizeWith`: SSE, `maxRetries: 0`; Bedrock refused), and only while the process holds the session's claim file (`pi/claim.ts`). The count reads one ordered stream of the session's receipts (`pi/session-attempts.ts`: the file's records in order, then this process's, each id once, all branches); never infer a charge from which entry ids a SessionManager loaded.
- The historian never holds up a cut or a run. Every summary it writes fits `summaryTokens`, or the reader would skip it
  and the same stretch would be summarized again.
- Cost and retrieval numbers come from one place: `reduceAccounting`/`reduceRetrieval` (`core/accounting.ts`, `core/retrieval.ts`) over the session log, for `/context` and `npm run measure` alike. A request that left without recorded usage is *unknown*, never zero, and a report with an unknown has no total; prices are the catalogue's, not the bill. Record an attempt before sending it; a new paid request gets an event kind in `accountingEvents`. Records hold ids, counts and usage, never content.
- New behavior goes into `src/core/` with a test in `test/core*.test.ts` (`test/continuity.test.ts` for the ledger)
  first; the adapters only wire it.

Tests run only on the AI host (`ssh AI`): copy the unit to a temp directory there, `npm ci`, `npm run typecheck`, `npm test`.
They run on pi 1.3.0 (the pinned minimum, the lockfile) and on pi 1.4.0: in a second temp copy run
`npm install --no-save @earendil-works/pi-coding-agent@1.4.0 @earendil-works/pi-ai@1.4.0` after `npm ci`, so the lockfile stays on 1.3.0.
`test/pi-integration*.test.ts`, `test/pi-host.test.ts` and `test/pi-session.test.ts` run the pi adapter against the pi installed in `node_modules`
with a throwaway config directory; test names carry its version. `npm run test:live` runs one real session on the model
`MODEL` in `test/live/run.ts` and needs `OPENAI_API_KEY`.

The packed plugin is checked apart from the tests: `npm run smoke` (and `npm run smoke -- --pi 1.4.0`) packs the unit, installs pi and the tarball into empty directories and loads it through pi's loader with no BB environment (see `tools/smoke-install.ts`). Run it before changing `files` in `package.json`, the entry point or anything the extension reads at load. It imports nothing from `src/`, so it never passes because of the dev checkout. The pack holds the sources, `examples/`, `tools/measure.ts` and the README; add a file to `files` only if the installed plugin reads it.

Examples run without a model: `node --experimental-strip-types examples/plan-cut.ts` plans a cut from a synthetic log.

Keep-warm lives in `src/pi/keep-warm.ts`: the `KeepWarm` controller owns the timer, the decision and pi's warmer, and extension.ts only wires its hooks. The signal file is `<SANDY_THREAD_STORAGE>/pi-keep-warm.json` (`KEEP_WARM_FILE`, `signalFile`; `BB_THREAD_STORAGE` from before the rename) under Sandy, where `bb/work/workflows` writes it (`src/keep-warm.ts`, its own `KEEP_WARM_FILE`; `test/shared-names.test.ts` pins the two), and `<agent dir>/context/keep-warm/<session id>.json` without BB; the `keepWarm.file` option overrides both. The keep-warm request is a side request (`warmOnce`), never an agent turn: it adds no session message, and its usage lives in its own `context.keep-warm` records. Whether a ping will run for a window is one question (`KeepWarm`'s plan) asked by the timer and by the `cache_warming_decision` handler (`KeepWarm.decide`); pi's warmer is stopped only while it is yes. The window counts from the capture's cache clock, which the fork's and pi's warmer's reads advance too, and no ping starts while one of them reads the prefix. A ping goes out under the `keep-warm` claim on the session file (`new SessionClaim("keep-warm").claimFor(file)`) and after reading the session file's records (`customRecords(file, KEEP_WARM_KIND, readWarmRecord)`), so two processes pay for one window. Old ping turns in a session stay out of the model view (`withoutPings`).
