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
Evidence is in `handoff/verification/` (handoff-summary.json, source-before.sha256, source-list-before.txt); hashes are relative to `extensions/sandy/sandy-sidebar-delegate`.
- Passed on the final frozen source (Node 26.13.0): full unit run 1470/1470 tests in 180 files, exit 0 (includes the R2 working-parity file); plugin build exit 0.
- NOT rerun after the final fix: tsc --noEmit, changed-file lint, file sizes, import boundaries, `openspec validate sidebar-spaces --strict`, source snapshot after the run. The last tsc run predates the final fix.
- Baseline failures that also fail at HEAD: README RPC table format check; biome.json schema warning (CLI 2.6.4 vs 2.5.15); `ThreadInbox.route-switch.test.tsx` import-boundaries (inline import() types).
- Not done: real browser and visual verification of the Spaces UI (desktop and mobile); not installed into a running Sandy; hidden-subagent attention check in Space rows.
- Read-only review notes, NOT reproduced and NOT fix requests: a hidden-worker case that may count as working where native is idle; a runtime status DTO gap; offset pagination duplicates and a 5000 cap with no flag. Check them before relying on those paths.

## First safe next action
In the package dir run, via Turbo on Node 26.13.0: typecheck, lint, then the focused tests above, then the full test and build. Fix only failures. Then do the browser/visual pass in an isolated dev app (verify-sandy skill). Do not merge or install before that.

## Not included
`.holons/changes/sidebar-spaces.json` is an untouched untracked proposal and is deliberately not committed.
