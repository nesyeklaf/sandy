# Handoff: sidebar-spaces

Status: WIP, not merged, not installed. Branch: spaces-vorgeschlagenen-holon-openspec-change-anl-thr_6ybf7w4zf8 (base 845f502).

## Intent
Named cross-repo effort groups ("Spaces") in the sidebar delegate extension (`extensions/sandy/sandy-sidebar-delegate`): a collapsed, actionable overview with intent/status shelves; repositories are metadata on rows, not a second tree. Spec: `proposal.md`, `design.md`, `tasks.md`, `specs/` in this directory (22 requirements, 36 scenarios). No Holon workflow is used.

## Decisions
- Spaces replace the old Tree layout (ThreadTreeView/tree-layout removed); Flow layout is unchanged. Legacy tree-collapse key migrates to the Spaces expansion state on first mount (`treeMigratingExpansionCodec`); No Space key is "none" in both.
- Server RPC `getSpaceOverview` and the browser share one pure model (`spaces-model.ts`). Shelf policy reuses the native lifecycle (`resolveShelf`, `threadSignals`); no second policy.
- Working-count policy is one pure helper at top level (`src/working-fact.ts`): own question, unread error or failed queue stop a thread counting as working; read error plus background work still counts. Node modules must not import `lib/**`.
- PR state comes only from the native RPC (`sandy--github-pr-status` `pullRequests`); UI passes all keys, native owner batches by 200.
- Space delete is an inline confirmation (role=group "Delete Space {name}"), no overlay, because the root AGENTS rule restricts only overlays and this adds no dependency.
- Space header uses neutral muted zero counts; approved question/clock/PR icons and urgent backplates only on new Space headers/shelves. Existing native card status vocabulary untouched.
- AGENTS.md carries the exception for this extension; `biome.json` TSX import lists are synced with new files.

## Checks
Authoritative counts and limits: [handoff/verification/resume-summary.json](handoff/verification/resume-summary.json). Scenario-by-scenario map: [handoff/verification/acceptance-map.md](handoff/verification/acceptance-map.md). `handoff/verification/handoff-summary.json` and `source-before.sha256` are an older run kept for history.
- Unit: a full run passed before the last 3-file delta, and a focused 5-file run passed after it. Typecheck, plugin build and changed-file lint passed after the delta.
- Native browser on a scratch server (UI harness) and independent image critiques have passed; the summary says what each covered.
- Baseline failures also present at HEAD: import-boundaries (route-switch test), ThreadCard file size, README table format, biome schema warning.
- Not proven: real PR provider states, `npm run check` green, the exact `npm run e2e` and `e2e:smoke` commands, `openspec validate --all --strict`, installation. Unreproduced review notes are listed in the summary.

## First safe next action
In the package dir, via Turbo on Node 26.13.0, rerun typecheck, lint, the full test and the build on the committed source. Then run `npm run e2e -- --grep Spaces` and `npm run e2e:smoke` in an isolated dev app (verify-sandy skill) and tick tasks.md 6 and 7 only when they pass. Do not merge or install before that.

## Not included
`.holons/changes/sidebar-spaces.json` is an untouched untracked proposal and is deliberately not committed.
