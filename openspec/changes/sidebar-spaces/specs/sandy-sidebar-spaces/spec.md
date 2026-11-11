# Space-organized Delegate sidebar

## ADDED Requirements

### Requirement: Native Space identity
The sidebar SHALL present Sandy thread sections as Spaces, preserve their existing ids and thread sectionId assignments, and leave Sandy projects and projectId unchanged.

#### Scenario: Cross-repository Space
- **GIVEN** a section contains two root sessions from different projects
- **WHEN** Spaces is opened
- **THEN** one Space contains both sessions and both projectId values are unchanged
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#native-section-identity

### Requirement: Create named and empty Spaces
The sidebar SHALL create a Space through the existing threadSections API without requiring a session and display the returned empty section.

#### Scenario: Create without a session
- **GIVEN** no session is selected
- **WHEN** the user creates a Space with a nonblank name
- **THEN** the returned section appears with total zero and an empty state
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#create-empty-space

#### Scenario: Creation failure
- **GIVEN** the server rejects a blank or duplicate section name
- **WHEN** Space creation is submitted
- **THEN** the validation error is shown and no phantom Space is retained
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#create-failure

### Requirement: Assign session trees without moving repositories
The sidebar SHALL assign each root session to at most one Space through threads.update, offer an unassigned destination, and display descendants under their root's effective Space without rewriting their stored project ids.

#### Scenario: Move between Spaces
- **GIVEN** a root with hidden workers belongs to Space A
- **WHEN** the user moves it to Space B
- **THEN** the tree appears only in B, its repository is unchanged, and every affected header updates
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#move-root-tree

#### Scenario: Missing ancestor
- **GIVEN** a nonhidden session's parent is absent from the current eligible root set
- **WHEN** the list is built
- **THEN** the existing orphan visibility rule keeps it reachable once; hidden workers never become standalone roots
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#orphan-visibility

### Requirement: One scrollable Space list
The sidebar SHALL render all named Spaces and a final unassigned bucket in one scroll container, retain empty named Spaces, and allow multiple Spaces to remain expanded independently.

#### Scenario: Independent expansion
- **GIVEN** three Spaces are listed
- **WHEN** the first and second are expanded and the first is collapsed
- **THEN** the second remains expanded and all three headers remain in the same scroll container
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#independent-collapse

#### Scenario: No session disclosure while collapsed
- **GIVEN** a Space contains sessions with titles, previews and child rows
- **WHEN** the Space is collapsed
- **THEN** its header remains visible and no session row or session-specific preview is rendered below it
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#closed-disclosure

### Requirement: Stable Space placement
The sidebar SHALL preserve server section creation order with the unassigned bucket last, and SHALL NOT reorder Spaces or reset expansion when session activity, status, PR state or counts change.

#### Scenario: Realtime status update
- **GIVEN** the second Space is expanded
- **WHEN** a session in the last Space starts working and then asks for input
- **THEN** header counts update while Space order, expansion and unrelated scroll position remain stable
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#stable-realtime-update

### Requirement: Unique representative totals
The sidebar SHALL count each eligible representative root once in its Space total and roll up unarchived descendant attention, failure and work to that root without adding worker rows to the total.

#### Scenario: Two asking descendants
- **GIVEN** one root has two hidden descendants asking for input
- **WHEN** Space totals and needs-you counts are calculated
- **THEN** the total increases by one and the needs-you count increases by one
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#descendant-rollup

#### Scenario: Cycles and archived descendants
- **GIVEN** a tree includes a cycle and an archived asking descendant
- **WHEN** aggregates are computed
- **THEN** traversal terminates, each representative is counted once, and the archived descendant adds no attention
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#safe-rollup

### Requirement: Overlapping header signals
The sidebar SHALL expose needs-you, failed, working-tree, open-PR and dormant counts as counts of representative sessions; these signal counts may overlap and SHALL NOT be summed into the total.

#### Scenario: Working and open PR
- **GIVEN** one root is working and has an open PR
- **WHEN** its Space header is rendered
- **THEN** total is one, working is one, and open-PR is one
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#overlapping-counts

#### Scenario: Two sessions sharing an environment
- **GIVEN** two representative sessions share an environment with one open PR
- **WHEN** the PR count is computed
- **THEN** the PR count is two sessions, not one PR, with neither session counted twice
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#pr-session-count

### Requirement: One automatic shelf per session
The Spaces view SHALL render each representative exactly once in automatic status shelves, with active precedence needs-you, failed, working, open-PR, merged, orchestrator, idea, dormant, ready; pinning SHALL remain a marker rather than a duplicate shelf row.

#### Scenario: Attention beats PR
- **GIVEN** a pinned root asks for input and has an open PR
- **WHEN** its Space is expanded
- **THEN** the root appears once under Needs you, retains pin and PR markers, and contributes to both applicable header signals
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#primary-shelf

#### Scenario: Lifecycle safety
- **GIVEN** a root is snoozed, parked, settled or archived
- **WHEN** Spaces is rendered with the existing archived visibility preference
- **THEN** existing lifecycle eligibility is preserved, with snoozed and archived entries in their existing lifecycle shelves and no lifecycle mutation caused by rendering
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#lifecycle-safety

### Requirement: Dormancy is a presentation state
The sidebar SHALL classify a ready root as dormant after seven complete days without activity in its eligible unarchived tree; questions, failures, live work, open or unknown PR status, merged state, ideas, orchestrators and explicit lifecycle shelves SHALL exclude dormancy.

#### Scenario: Exact boundary
- **GIVEN** two eligible ready trees last changed 604799999 and 604800000 milliseconds ago
- **WHEN** a fixed clock evaluates dormancy
- **THEN** only the second is dormant and no stored lifecycle or cleanup field changes
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#dormancy-boundary

#### Scenario: Recent descendant work
- **GIVEN** a root was last active ten days ago and an unarchived child was active yesterday
- **WHEN** dormancy is evaluated
- **THEN** the root is not dormant
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#tree-last-activity

### Requirement: Minimal Space headers
Minimal Space headers SHALL show the Space name, representative total and nonzero needs-you and failed counts; they SHALL omit work, PR and dormant counters and all session-specific content.

#### Scenario: Minimal urgent floor
- **GIVEN** a closed Space has needs-you, failed, working and open-PR sessions
- **WHEN** Minimal Space headers is selected
- **THEN** name, total, needs-you and failed remain visible; working, PR, dormant and session previews are absent
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#minimal-header

### Requirement: Compact Space headers
Compact Space headers SHALL show name and total followed by fixed icon-and-count positions for needs-you, working, open-PR and dormant; they SHALL additionally show a nonzero failed count and provide accessible status names.

#### Scenario: Compact zeroes
- **GIVEN** a closed Space has zero needs-you, one working and two dormant roots
- **WHEN** Compact Space headers is selected
- **THEN** the four standard positions remain visible, including zeroes, with named status controls
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#compact-header

### Requirement: Detailed Space headers
Detailed Space headers SHALL label the same counters in words and add the ready-session count and distinct repository count for the current scope, without disclosing session titles, previews, branches or individual PR numbers.

#### Scenario: Aggregate detail only
- **GIVEN** a closed Space contains sessions from two repositories
- **WHEN** Detailed Space headers is selected
- **THEN** labelled counters, ready total and repository count appear without any session-specific data
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#detailed-header

### Requirement: Independent density preferences
The sidebar SHALL provide a separate persisted Space-header density with Minimal, Compact and Detailed modes and Compact as default; existing session density, row fields and shelf overrides SHALL remain independent.

#### Scenario: All density combinations
- **GIVEN** an expanded Space contains five representative sessions
- **WHEN** each of the three header modes is combined with Dense, Compact and Comfortable session rows
- **THEN** all nine combinations retain five unique rows and changing session density does not change the header mode or header geometry
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#density-matrix

#### Scenario: Existing row settings
- **GIVEN** Auto session density and a shelf density override are saved
- **WHEN** the user switches Space-header density
- **THEN** Auto, the override, row fields and expansion stay unchanged
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-preferences.test.ts#independent-settings

### Requirement: Counter navigation finds overlapping signals
A nonzero header counter SHALL expand its Space and apply a visible Space-local signal filter; matching roots SHALL retain their primary shelf and the user SHALL be able to clear the filter without affecting other Spaces.

#### Scenario: PR signal with no PR-primary shelf
- **GIVEN** two roots both have open PRs but one asks for input and one is working
- **WHEN** the open-PR counter is activated
- **THEN** both roots are shown once under their primary shelves and a visible PR filter can be cleared to restore every root
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#overlapping-counter-navigation

#### Scenario: Zero and transient filters
- **GIVEN** a header counter is zero or a local signal filter is active
- **WHEN** the user activates the zero control or reloads the sidebar
- **THEN** zero has no navigation effect and reload starts without the transient signal filter
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#zero-and-transient-filter

### Requirement: Persistence and existing layout migration
The sidebar SHALL persist Space expansion per device through the established preference codecs, map a saved Tree layout to Spaces, retain an explicit Flow choice, and default new users to Spaces with all Spaces collapsed.

#### Scenario: Reload after migration
- **GIVEN** a device has saved Tree mode and collapsed section ids
- **WHEN** the updated sidebar loads and reloads
- **THEN** Spaces replaces Tree, known section collapse choices survive and no section membership is rewritten
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-preferences.test.ts#tree-migration

#### Scenario: Fresh and invalid preferences
- **GIVEN** a device has no preferences or invalid new Space preferences
- **WHEN** the sidebar loads
- **THEN** Spaces uses Compact headers, all Spaces start collapsed, and invalid density values fall back without losing valid session settings
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-preferences.test.ts#safe-defaults

#### Scenario: Explicit Flow remains available
- **GIVEN** Flow was explicitly selected
- **WHEN** the plugin updates and the user later switches to Spaces
- **THEN** Flow remains the saved initial view and Spaces remains selectable without a single-Space selector
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-preferences.test.ts#flow-preserved

### Requirement: Filters and counts use one eligible set
The sidebar SHALL derive totals, signal counts and rendered rows from the same existing scope, search and label-filter results, while retaining every named Space header and showing that counts are filtered when a global filter is active.

#### Scenario: Filtered empty Space
- **GIVEN** two Spaces each have roots but the existing repo filter matches roots only in one
- **WHEN** Spaces is rendered
- **THEN** the unmatched Space remains visible with zero filtered total and neither header counts roots excluded by the filter
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#global-filter-counts

### Requirement: Unknown PR state is not absence
The sidebar SHALL reuse the existing GitHub PR Status integration and treat loading, unavailable, failed and unknown PR lookups as unknown rather than as a confirmed absence of an open PR.

#### Scenario: Provider unavailable
- **GIVEN** a ready root's PR lookup fails
- **WHEN** Space signals and dormancy are evaluated
- **THEN** no open-PR count is invented, unavailable state is exposed, and the root is not classified dormant or settled as a side effect
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/spaces-model.test.ts#unknown-pr

### Requirement: Existing session actions remain usable
The Spaces view SHALL reuse the existing session rows and action contracts for navigation, child expansion, pending interactions, pin, snooze, archive, rename and split rather than replacing them with prototype-only controls.

#### Scenario: Real session and worker actions
- **GIVEN** an expanded Space has a root with hidden workers and a pending interaction
- **WHEN** the user expands the worker tree, opens a worker and answers the interaction
- **THEN** existing navigation and interaction paths execute and the Space needs-you count updates once
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadInbox.spaces.test.tsx#real-session-actions

### Requirement: Space management uses core contracts
The sidebar SHALL expose Space rename and named delete confirmation through the existing section APIs, and deletion SHALL remove the section assignment without deleting, archiving or moving the repositories of its sessions.

#### Scenario: Delete only a Space
- **GIVEN** a named Space contains a root tree
- **WHEN** the user confirms deletion of that named Space
- **THEN** the core section deletion runs, roots appear in the unassigned bucket, and the sessions, worker tree and project ids are preserved
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#delete-space-only

#### Scenario: Concurrent section removal
- **GIVEN** a section is deleted or assignment fails while the sidebar is open
- **WHEN** a live update or mutation result arrives
- **THEN** the list reconciles server state, reports failure and does not retain phantom memberships
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#mutation-reconciliation

### Requirement: CLI and SDK parity
Space creation, rename, deletion and assignment SHALL use existing core CLI and SDK paths; the plugin SHALL expose a discoverable read-only getSpaceOverview RPC that uses the same Space aggregation rules as the UI.

#### Scenario: Core mutation paths
- **GIVEN** a Space is created with sandy thread section and a root is assigned with the existing threads API
- **WHEN** the sidebar receives the normal live updates
- **THEN** the same Space id and root membership appear without a second plugin-owned Space database
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-overview.test.ts#core-mutation-parity

#### Scenario: Read-model parity
- **GIVEN** the UI and RPC receive the same eligible roots, lifecycle and PR snapshot
- **WHEN** getSpaceOverview is called through plugin RPC discovery and invocation
- **THEN** Space ids, totals, status counts and representative primary shelves match the UI model
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/space-overview.test.ts#rpc-ui-parity

### Requirement: Responsive and keyboard access
The sidebar SHALL support Space toggles, density controls, signal filters and management with keyboard and touch, retain focus after rerenders, and avoid horizontal overflow at sidebar widths of 272, 320 and 390 pixels.

#### Scenario: Keyboard focus
- **GIVEN** a Space toggle has keyboard focus
- **WHEN** Enter opens it and a counter filter is then activated
- **THEN** aria-expanded tracks state, focus remains on the toggle or the revealed result, and the filter can be cleared with the keyboard
- **TEST** extensions/sandy/sandy-sidebar-delegate/src/ThreadSpacesView.test.tsx#keyboard-focus

#### Scenario: Narrow layout
- **GIVEN** representative long names and nonzero counters are loaded
- **WHEN** all density combinations are rendered at 272, 320 and 390 pixels
- **THEN** headers and rows fit without horizontal scrolling, names remain accessible and controls retain touch targets
- **TEST** extensions/sandy/sandy-sidebar-delegate/e2e/spaces.spec.mjs#responsive-density-matrix

### Requirement: Documentation and release boundary
The change SHALL document Spaces, the separate density settings, overlapping session counters and CLI/RPC entry points in the owning plugin documentation and skill, and SHALL NOT extract, publish, install or deploy plugins.

#### Scenario: Local package verification
- **GIVEN** Spaces is implemented in the existing Delegate plugin package
- **WHEN** the package check and scratch-server Spaces browser suite run
- **THEN** they pass with no dependency-manager switch, live-host mutation or plugin relocation
- **TEST** extensions/sandy/sandy-sidebar-delegate/e2e/spaces.spec.mjs#scratch-entry-point
