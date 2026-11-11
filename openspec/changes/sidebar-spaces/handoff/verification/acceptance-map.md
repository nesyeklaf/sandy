# sidebar-spaces acceptance map

Checked scenario by scenario against `specs/sandy-sidebar-spaces/spec.md` and the cited test bodies. Counts and run facts live only in [resume-summary.json](resume-summary.json). Test files are under `extensions/sandy/sandy-sidebar-delegate/src/` unless noted.

Result words: Pass = the cited check asserts the scenario's THEN at the stated level; Partial = a part of the THEN is not asserted. Open PR, needs and dormant states come from fixtures and RPC/unit tests, never from a real provider.

| # | Requirement | Scenario | Check | Level and limits | Result |
|---|---|---|---|---|---|
| 1 | Native Space identity | Cross-repository Space | spaces-model.test.ts#native-section-identity | Unit. Native browser CRUD/assign runs used real sections. | Pass |
| 2 | Create named and empty Spaces | Create without a session | ThreadSpacesView.test.tsx#create-empty-space | Unit (SDK mocked); native browser CRUD created a real section. | Pass |
| 3 | Create named and empty Spaces | Creation failure | ThreadSpacesView.test.tsx#create-failure; native CRUD run | Unit shows the server error text and keeps the Space count (mock failure, separate from the native run). The native CRUD run exercised blank and duplicate names against the real SDK. | Pass |
| 4 | Assign session trees | Move between Spaces | ThreadSpacesView.test.tsx#move-root-tree | Unit asserts the threads.update call; native browser assignment run on a real server. | Pass |
| 5 | Assign session trees | Missing ancestor | spaces-model.test.ts#orphan-visibility | Unit. | Pass |
| 6 | One scrollable Space list | Independent expansion | ThreadSpacesView.test.tsx#independent-collapse | Unit with Launch, Plan and No Space. Not asserted: that all Spaces share one scroll container. | Partial |
| 7 | One scrollable Space list | No session disclosure while collapsed | ThreadSpacesView.test.tsx#closed-disclosure | Unit asserts no row title while collapsed; previews not asserted separately. | Pass |
| 8 | Stable Space placement | Realtime status update | ThreadSpacesView.test.tsx#stable-realtime-update | Unit with a lifecycle realtime event: counts, order and expansion stay. Scroll position and working-then-asking sequence not asserted. | Partial |
| 9 | Unique representative totals | Two asking descendants | spaces-model.test.ts#descendant-rollup | Unit. | Pass |
| 10 | Unique representative totals | Cycles and archived descendants | spaces-model.test.ts#safe-rollup | Unit. | Pass |
| 11 | Overlapping header signals | Working and open PR | spaces-model.test.ts#overlapping-counts | Unit; open PR comes from fixtures, not a real provider. | Pass (synthetic PR) |
| 12 | Overlapping header signals | Two sessions sharing an environment | spaces-model.test.ts#pr-session-count | Unit; synthetic PR. | Pass (synthetic PR) |
| 13 | One automatic shelf per session | Attention beats PR | spaces-model.test.ts#primary-shelf; space-overview.policy-parity.test.ts; space-overview.working-parity.test.ts | Unit plus UI-vs-RPC parity and an independent runner probe. Pin marker row: ThreadSpacesView.header.test.tsx; native pin at rest at 3 row densities. | Pass |
| 14 | One automatic shelf per session | Lifecycle safety | spaces-model.test.ts#lifecycle-safety; space-overview.policy-parity.test.ts | Unit parity against native lifecycle policy; not a live provider. | Pass |
| 15 | Dormancy is a presentation state | Exact boundary | spaces-model.test.ts#dormancy-boundary | Unit with fixed clock. | Pass |
| 16 | Dormancy is a presentation state | Recent descendant work | spaces-model.test.ts#tree-last-activity | Unit. | Pass |
| 17 | Minimal Space headers | Minimal urgent floor | ThreadSpacesView.test.tsx#minimal-header; report-synthetic.md; native failed-turn test | Unit asserts work and PR counters absent. Fresh synthetic critique observed Minimal shows urgent needs and failure only. The native failed-turn test asserts the failed badge at all three densities including Minimal. No new test added. | Pass |
| 18 | Compact Space headers | Compact zeroes | ThreadSpacesView.test.tsx#compact-header | Unit: four named slots incl. disabled zero working. | Pass |
| 19 | Detailed Space headers | Aggregate detail only | ThreadSpacesView.test.tsx#detailed-header | Unit asserts "2 repositories · 1 ready" and no session title. | Pass |
| 20 | Independent density preferences | All density combinations | ThreadSpacesView.test.tsx#density-matrix | Unit: 3x3 with five unique rows; header geometry unchanged by row density is not measured in jsdom. Native 27-state matrix passed on the earlier build. | Pass (geometry from native run) |
| 21 | Independent density preferences | Existing row settings | space-preferences.test.ts#independent-settings | Unit. | Pass |
| 22 | Counter navigation finds overlapping signals | PR signal with no PR-primary shelf | ThreadSpacesView.test.tsx#overlapping-counter-navigation | Unit: shelves needs/working kept, filter cleared by second click. | Pass |
| 23 | Counter navigation finds overlapping signals | Zero and transient filters | ThreadSpacesView.test.tsx#zero-and-transient-filter | Unit; reload simulated by remounting. | Pass |
| 24 | Persistence and existing layout migration | Reload after migration | space-preferences.test.ts#tree-migration; ThreadSpacesView.migration.test.tsx; Codex probe R1 | Unit mount-and-reload. Native current-build preferences run passed. Caveat: migration reads Spaces at first ThreadSpacesView mount. | Pass |
| 25 | Persistence and existing layout migration | Fresh and invalid preferences | space-preferences.test.ts#safe-defaults | Unit. | Pass |
| 26 | Persistence and existing layout migration | Explicit Flow remains available | space-preferences.test.ts#flow-preserved; e2e/spaces.spec.mjs Flow test | Unit plus browser. | Pass |
| 27 | Filters and counts use one eligible set | Filtered empty Space | ThreadSpacesView.test.tsx#global-filter-counts | Unit with project scope: Plan (0) stays, "filtered" shown. | Pass |
| 28 | Unknown PR state is not absence | Provider unavailable | spaces-model.test.ts#unknown-pr; ThreadSpacesView.pr-lookup.test.tsx | Unit; no real provider outage was run. | Pass (synthetic) |
| 29 | Existing session actions remain usable | Real session and worker actions | ThreadInbox.spaces.test.tsx#real-session-actions | Unit: worker tree expand and answering a question from a Space row. Pin/snooze/archive/rename/split are existing card paths, not re-proven. Hidden-subagent attention in rows not browser-verified. | Partial |
| 30 | Space management uses core contracts | Delete only a Space | ThreadSpacesView.test.tsx#delete-space-only; ThreadSpacesView.header.test.tsx confirm placement | Unit asserts the section delete call and the inline named confirm; the unit test covers that roots move to No Space. Native inline delete at 390 and 360 passed. The native CRUD run deleted an empty Space created in the UI, so it does not prove root preservation. | Pass |
| 31 | Space management uses core contracts | Concurrent section removal | ThreadSpacesView.test.tsx#mutation-reconciliation | Unit: failed delete shows the error and keeps the Space. Live concurrent removal not run. | Partial |
| 32 | CLI and SDK parity | Core mutation paths | space-overview.test.ts#core-mutation-parity | Unit; no live CLI run. | Pass (unit) |
| 33 | CLI and SDK parity | Read-model parity | space-overview.test.ts#rpc-ui-parity; working-parity; policy-parity | Unit parity plus runner RPC-vs-UI probe (4/4) and Codex probes at fdccde2c. | Pass |
| 34 | Responsive and keyboard access | Keyboard focus | ThreadSpacesView.test.tsx#keyboard-focus | Native focus run (earlier spaces-verify spec, lines 169-190) presses Enter on the toggle and asserts focus and aria-expanded. Keyboard clearing of a filter chip is unproven: the chip is only enabled with a non-zero count and that seed has none. Unit uses click events. | Partial |
| 35 | Responsive and keyboard access | Narrow layout | e2e/spaces.spec.mjs#responsive-density-matrix; header test touch-size classes | Browser: no horizontal overflow at 272/320/390 for 3 header densities (earlier build); unit asserts mobile min-size classes. Native 390/360 inline delete passed on current build. | Pass (touch size by class, not measured) |
| 36 | Documentation and release boundary | Local package verification | e2e/spaces.spec.mjs#scratch-entry-point; resume-summary.json | Scratch browser suites ran through the UI harness, not the exact npm commands. npm run check is not green (baseline failures); nothing installed, published or relocated. | Partial |

Totals: 30 pass, 6 partial, of 36. A row with a stated unverified constraint counts as Partial.

## Native evidence (screenshots)
- Pin at rest, three row densities: [dense](native-ui/pin-row-dense-rest.png), [compact](native-ui/pin-row-compact-rest.png), [comfortable](native-ui/pin-row-comfortable-rest.png).
- Inline delete below the complete header: [390](native-ui/delete-inline-390.png), [390 Space crop](native-ui/delete-inline-390-space.png), [360](native-ui/delete-inline-360.png).
- Independent image-only critique of those pictures: [report-native.md](reviews/report-native.md), [findings-native.json](reviews/findings-native.json). Synthetic target comparison (24 states, no blockers): [report-synthetic.md](reviews/report-synthetic.md), [findings-synthetic.json](reviews/findings-synthetic.json). Reviewer findings JSON files list the original machine paths: copied pictures are rewritten relative to `reviews/`; the others are labelled NOT COPIED and cannot be resolved here.
