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
- Last full package run before the final fixes: 1457/1457 tests, build and spec OK, on Node 26.13.0.
- After that: R1 migration, R2 working parity, R3 PR key cap, inline delete were changed. Their new tests (working-parity, pr-lookup, migration, space-preferences, ThreadSpacesView, header) were written but the final full run and build were PENDING when this was committed. The parent/runner result is not recorded here.
- Baseline failures that also fail at HEAD: README RPC table format check; biome.json schema version warning (CLI 2.6.4 vs 2.5.15); `ThreadInbox.route-switch.test.tsx` import-boundaries (inline import() types).
- Pending, not done: real browser and visual verification of the Spaces UI (desktop and mobile), installation into a running Sandy, hidden-subagent attention check in Space rows.

## First safe next action
In the package dir run, via Turbo on Node 26.13.0: typecheck, lint, then the focused tests above, then the full test and build. Fix only failures. Then do the browser/visual pass in an isolated dev app (verify-sandy skill). Do not merge or install before that.

## Not included
`.holons/changes/sidebar-spaces.json` is an untouched untracked proposal and is deliberately not committed.
