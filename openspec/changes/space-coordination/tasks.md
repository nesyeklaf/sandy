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
- [x] 3.4 Sessions started by an orchestrator are recorded (space_started_sessions, appended migration) and restricted by the dispatch hook like the orchestrator. Verify: tests for independent target, managed target, mixed queue, role loss, deletion cleanup, move.
- [x] 3.6 Restrict descendants of restricted sessions on thread.created; allow reports to an orchestrator of the same Space; stop a spawned session when the started record cannot be written. Verify: tests for child, grandchild, orchestrator child, report to orchestrator, both write failures, archived starter.
- [x] 3.5 Document the cooperative boundary in design risks, README and the Spaces skill.
- [x] 3.3 Wake digest with interval, entry cap and per-Space switch. Verify: tests with a fake clock.

## 4. RPC, realtime and CLI
- [x] 4.1 RPC contract and handlers; realtime channel per Space.
- [x] 4.2 `sandy spaces` CLI commands with --json; update docs/cli-guide-and-skill.md surfaces and the plugin skill. Verify: CLI tests for each command and error.

## 5. UI
- [x] 5.1 Shelves: remove Ideas shelf in Spaces and Flow, keep Orchestrators shelf, rename Ready to Idle.
- [x] 5.2 Sort-mode picker for Spaces reusing ActiveSortPicker and sortActiveThreads, persisted separately.
- [x] 5.3 Space side-panel tab: Overview (orchestrators, Managed switch, wake switch), Ideas, Scratchpad with conflict handling; row and Space header menu items. Verify: DOM tests for visibility, Managed switch, idea edit, scratchpad conflict.
- [x] 5.4 Space delete confirmation says ideas and scratchpad are kept.

## 6. Acceptance
- [ ] 6.1 Full plugin check script and plugin build.
- [ ] 6.2 Browser check of the side-panel tab, shelves and sort picker by the UI verifier at three densities and 390 px width.
- [ ] 6.3 Tiger-style review of the diff (CRITICAL/MAJOR fixed) and an independent review by the other model family.
- [ ] 6.4 `openspec validate space-coordination --strict`.

## 7. Waking orchestrators (owner revision 2026-11-12)
- [x] 7.1 Storage: appended migrations for the three space_settings columns (old wake off maps to check-ins 0 and fallback off, then wake_enabled is dropped) and space_member_reports; settings read/write with range checks; report cleanup on thread.deleted and move. Verify: real-SQLite tests for defaults, the wake-off migration from the shipped migration list, range refusal, cleanup.
- [x] 7.2 space_report tool and `sandy spaces report`: managed members only, self-reports on only, summary limit, delivered to every orchestrator with the member as sender, latest report stored; member instructions and orchestrator instructions updated. Verify: tests for done report, independent refused, self-reports off (no tool, no instructions, CLI refused), long summary refused, dispatch hook lets it through.
- [x] 7.3 Failure fallback replacing the wake digest: failed and question only, merged per member, recheck before sending, dropped after a later report, 60 s and 50-entry bounds, originPluginId set. Verify: fake-clock tests for idle-then-active (nothing sent), two outcomes one entry, answered question dropped, 70 failures, fallback off.
- [x] 7.4 Periodic check-in: one tick timer, per-Space interval, stuck and changed rules, nothing sent when nothing qualifies, no stacking while a check-in is untaken. Verify: fake-clock tests for each scenario in the spec.
- [x] 7.5 RPC `setSpaceCoordinationSettings` and CLI `sandy spaces settings` replacing setSpaceWake and `sandy spaces wake`; `sandy spaces show` and space_context show settings and latest reports; Space tab Overview controls; README, skill and docs/cli-guide-and-skill.md surfaces. Verify: CLI and DOM tests; English-only test.
- [x] 7.6 Plugin checks serial (VITEST_MAX_WORKERS=1), build, `openspec validate space-coordination --strict`; a review by the other model family and a browser check of the Overview controls only once the orchestrator grants a slot.
