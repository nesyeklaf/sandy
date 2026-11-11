# Tasks: Space coordination

Each slice ends with: `pnpm exec turbo run typecheck test --filter=sandy-plugin-sandy-sidebar-delegate` (or the package's check script equivalents for lint, format, knip, file sizes, import boundaries), green on Node 26.13.0, plus the slice's own verify command. Report observed, inferred and untested.

## 1. English only
- [x] 1.1 Replace every German UI string, tool description, README and skill text with English (Orchestratoren, Ideen, Lädt…, Als Idee markieren, Keine Idee mehr, and any others found).
- [x] 1.2 Add the English-only guard test. Verify: the test fails on a planted German word, passes on the tree.

## 2. Storage and domain
- [x] 2.1 Migrations for space_orchestrators, space_member_modes, space_ideas, space_idea_links, space_scratchpads; limits as named constants; assert helper.
- [x] 2.2 Domain module: orchestrator assignment, coordination mode, ideas CRUD with links, scratchpad read/write with revision check; cleanup on thread.deleted; membership check against core sectionId. Verify: real-SQLite tests for each rule, limit and conflict.
- [x] 2.3 Migration that drops thread_orchestrators and thread_ideas; orphan listing and adopt. Verify: real-SQLite tests for drop, orphans after Space deletion and adopt.

## 3. Enforcement and agent tools
- [x] 3.1 Message-dispatch hook refusing orchestrator messages to independent or foreign sessions. Verify: tests for owner message, managed, independent, foreign Space, mixed senders.
- [x] 3.2 Agent tools and per-thread tool configuration; new orchestrator and member instructions; remove session_roles and the idea instructions. Verify: tests that a non-orchestrator cannot call management tools and that space_start_session creates a flat member (sectionId set, no parent, no lifecycle owner).
- [x] 3.3 Wake digest with interval, entry cap and per-Space switch. Verify: tests with a fake clock.

## 4. RPC, realtime and CLI
- [x] 4.1 RPC contract and handlers; realtime channel per Space.
- [x] 4.2 `sandy spaces` CLI commands with --json; update docs/cli-guide-and-skill.md surfaces and the plugin skill. Verify: CLI tests for each command and error.

## 5. UI
- [ ] 5.1 Shelves: remove Ideas shelf in Spaces and Flow, keep Orchestrators shelf, rename Ready to Idle.
- [ ] 5.2 Sort-mode picker for Spaces reusing ActiveSortPicker and sortActiveThreads, persisted separately.
- [ ] 5.3 Space side-panel tab: Overview (orchestrators, Managed switch, wake switch), Ideas, Scratchpad with conflict handling; row and Space header menu items. Verify: DOM tests for visibility, Managed switch, idea edit, scratchpad conflict.
- [ ] 5.4 Space delete confirmation says ideas and scratchpad are kept.

## 6. Acceptance
- [ ] 6.1 Full plugin check script and plugin build.
- [ ] 6.2 Browser check of the side-panel tab, shelves and sort picker by the UI verifier at three densities and 390 px width.
- [ ] 6.3 Tiger-style review of the diff (CRITICAL/MAJOR fixed) and an independent review by the other model family.
- [ ] 6.4 `openspec validate space-coordination --strict`.
