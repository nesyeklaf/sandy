# pi/context

Cache-aware context management for long pi sessions. Each file's header says how it works; the design and its
measurements are in `README.md`. The Pi Durable engine stayed in Sandy (`packages/context/src/durable`).

- `src/core/`: pure functions of the log (`LogEntry[]`) and the config. No I/O and no pi import, so the model view can
  always be rebuilt from the log. `policy.ts` when to cut, `cut.ts` what a cut carries (`CutFold` reads the log newest
  first in pages; `planCut` feeds it a whole log), `historian.ts` and `summary.ts` the anchored summary, `search.ts` and
  `tools.ts` the BM25 search and the three agent tools' texts, bounds and logic, `ledger.ts` and `continuity.ts` the
  request ledger, `skills.ts` the skills a cut names for rereading, `kinds.ts` the entry kinds the engine writes (all under `KIND_PREFIX`), `messages.ts` pi-ai messages
  as log entries.
- `src/tools/schemas.ts`: the TypeBox schemas of the three tools, built from the core's texts and bounds.
- `src/historian/`: the background historian both adapters run, without a host import (`Historian`, `HistorianBranch`).
- `src/pi/`: the adapter to pi (`index.ts` is the entry pi loads). It reads the log, calls the core and stores the result.

Rules:

- A cut is a planned cache break. A change that adds an unplanned one is a bug the ledger must show.
- The core never assumes a host's entry ID format; the caller names a cut's reason and may choose where the kept history
  starts.
- Scans are bounded: a scan holds one page (`SCAN_PAGE`), stops when its context is cancelled. `searchHistory` ranks in two passes, equal to `SearchIndex` over the same entries,
  and one search scans `SEARCH_SCAN_LIMIT` entries before it returns a cursor. A `#<id>` in the query is read directly,
  whatever its age.
- What the engine reads from a log it validates there, whoever wrote it: a malformed, oversized or foreign-anchored
  notebook or summary entry is skipped.
- The request ledger hashes the payload the provider received (`requestShape`) and keeps no content. At most `LEDGER_CONVERSATIONS` ledgers stay in memory.
- The historian never holds up a cut or a run. Every summary it writes fits `summaryTokens`, or the reader would skip it
  and the same stretch would be summarized again.
- New behavior goes into `src/core/` with a test in `test/core*.test.ts` (`test/continuity.test.ts` for the ledger)
  first; the adapters only wire it.

Tests run only on the AI host (`ssh AI`): copy the unit to a temp directory there, `npm install`, `npm run typecheck`,
`npm test`. `test/pi-integration*.test.ts` and `test/branch.test.ts` run the pi adapter against pi 1.3.0 with a throwaway
config directory. `npm run test:live` runs one real session on the model `MODEL` in `test/live/run.ts` and needs
`OPENAI_API_KEY`.

Examples run without a model: `node --experimental-strip-types examples/plan-cut.ts` plans a cut from a synthetic log.

The keep-warm signal file `pi-keep-warm.json` in the SANDY thread's storage is shared with `sandy/work/workflows`
(`src/keep-warm.ts`, `KEEP_WARM_FILE`): rename both or neither.
