# Design

## Context and accepted reference

Approved interactive prototype: [approved-prototype.html](handoff/approved-prototype.html).

The source checkout inspected for this draft is `/home/feysen/projects/private/gh/sandy` at `40b0835fb6c9deed0f8a11f9a51a9cd68a33cca7`. Its working tree was clean. Installed Delegate source is `extensions/sandy/sandy-sidebar-delegate`.

This is a standalone OpenSpec change; the root AGENTS.md exempts `sidebar-spaces` from Holon modeling and READY checks.

## Competing designs

### A. Reuse native thread sections as Spaces — selected

Read `PluginSidebarThreadsState.sections`, call `sdk.threadSections`, and assign roots with `sdk.threads.update({ threadId, sectionId })`. Existing ids, CLI, SDK, realtime updates and unassignment on deletion remain authoritative. No second membership store or section migration.

### B. Plugin-owned Spaces and membership database — rejected

A new database would allow private ordering and future many-to-many membership but would duplicate section state, require new APIs, migrate existing memberships and make other clients disagree. None of those capabilities is required by the approved design.

## Boundaries and ownership

Core owns section ids, names, CRUD, section creation order and thread `sectionId`. Sandy projects remain repository/workspace objects. UI vocabulary says Space, Move to Space and No Space; API names remain `threadSections` and `sectionId`.

The plugin owns the read model, status counts, presentation-only dormancy, signal filters and density preferences. Use a pure shared `spaces-model.ts` module without browser, React or Node imports, consumed by UI and the read-only RPC. Add small UI and hook modules rather than growing existing files beyond their budgets.

Root trees inherit the representative root's effective Space. Do not rewrite descendants or project ids to implement presentation inheritance. Preserve the existing orphan visibility rules and cycle guards. Hidden delegate/workflow children remain accessible through their representative.

## Read-model shape

A Space view contains native `id` or null for the unassigned bucket, name, unique representative total, needs-you/failed/working/open-PR/dormant counts, ready count, distinct repository count and representative roots with their primary shelf. PR state carries loading/known/unavailable information; unknown is not false.

Header counters are independent predicates. A needs-you root with an open PR contributes to both counts but only once to total. Two roots sharing an environment each count as one PR-bearing session, not as a single PR object.

Apply current global scope/search/label filters before computing both counts and rows. Retain every named header, including empty results; label filtered counts. Local signal filters select rows only and do not alter aggregate headers.

## Status rules

Reuse existing interaction, failure, working-tree, lifecycle and PR signal helpers, not icon guesses. Unarchived descendants contribute attention, failure, live work and latest activity to their representative. No polling pass may mutate lifecycle state merely to render a Space.

Explicit snoozed/parked and settled/archived state keeps its existing eligibility and lifecycle shelves. Existing activity handlers still own wakes and resume behavior. For other roots, primary precedence is needs-you, failed, working, open-PR, merged, orchestrator, idea, dormant, ready. Pin is a retained row marker and ordering preference, not a second copy or a replacement for the root's status shelf. Flow retains its existing classifier and pin shelf.

Dormant is a ready root with last tree activity at least 604800000 ms ago. Latest activity is the maximum existing session activity timestamp over the root and its eligible unarchived descendants, not PR polling or header rendering. Unknown PR state excludes dormancy. Ageing updates use the existing clock; no independent timer per row or Space.

## Header modes and rows

Minimal: one-line name and total, plus nonzero needs-you and failure counters. Those urgent hints cannot be suppressed.

Compact, the new header default: name/total and fixed icon-count slots for needs-you, working, open-PR and dormant; add failure when nonzero. Zeroes keep the standard positions stable.

Detailed: the same counts with labels, plus ready total and distinct repository count. Closed headers never include session titles, previews, branches or individual PR numbers.

Keep the established session density values. Prototype Minimal maps to Dense; Compact to Compact; Detailed to Comfortable. Retain Auto and existing per-shelf overrides. A dedicated header-density setting uses minimal/compact/detailed and cannot write `threadDensity`. Register validated persisted values through the existing settings and preference infrastructure.

## Interaction and persistence

All Space headers live in one list scroll container. No single-Space selector, independent nested scroll area or automatic Space reordering. Native section creation order is stable; unassigned is last. Empty named Spaces remain visible.

Toggling a header changes only that Space. Header counts remain visible when open. Activating a nonzero counter opens the Space and applies an explicit local signal filter; roots retain their primary shelves. A Clear/All action restores all rows. Zero counters have no action. These filters are transient.

Persist expansion per device with the existing registered keys, codecs and quota recovery. Fresh Spaces start closed. Map a saved Tree preference to Spaces and known section collapse choices to Space choices; preserve explicit Flow, row fields, Auto and shelf density overrides. With no saved layout, use Spaces. Invalid new values fall back independently, without resetting valid unrelated preferences.

Use existing rows and actions, tokens, icons, drawer primitives and reduced-motion behavior. Keep named confirmation for section deletion; deletion only unassigns sessions.

## SDK and CLI

Section management uses `sandy thread section list|create|rename|delete` and `sdk.threadSections`. Root assignment uses the established threads API/CLI update path.

Register discoverable read-only `getSpaceOverview` in the plugin RPC contract. Input has an optional project-id scope, default all projects; output carries Space ids/names, representative ids/primary shelves and the same aggregate fields as the model. PR availability is explicit. The server and UI normalize their existing inputs into the same pure model; they do not implement two classifiers.

`sandy plugin rpc call sandy-sidebar-delegate getSpaceOverview --input-file <json>` is the CLI read entry point. Existing getSidebarSettings/updateSidebarSettings paths expose the new header density; expansion and transient filters stay device-local. Document these boundaries in the plugin README and an owning plugin skill, not by adding aliases to core API.

## Dormancy

The owner confirmed seven complete inactive days as the default. Each requirement carries an automated TEST target; targets are implementation targets until they have run.

## Risks and checks

Counter overlap can look like broken arithmetic: label totals as sessions and explain signal overlap; test the same root as needs-you/working plus open PR.

The current Tree code drops empty sections and nests repositories: the replacement must remove both assumptions without breaking assignment or orphan navigation.

Lifecycle safety matters more than a screenshot match: cover snooze, park, pin, ideas, orchestrators, merged and archived visibility, plus rename locks and child interactions.

PR failures must never become no-PR and trigger dormancy or cleanup. Test unavailable/loading/unknown states.

Performance risk is repeated subtree traversal and fetching PR state once per Space. Normalize/index once per snapshot, reuse existing PR subscriptions, and avoid per-Space fetch loops or timers. Evidence is call-count/behavior assertions and a seeded browser journey, not an invented latency number.

## Rollout and rollback

No plugin relocation, dependency changes, publishing, live installation or deployment in this change. Build and browser verification use the package's scratch server only. Code rollback restores the old layout; core section ids, names and memberships remain usable because this design does not migrate them.

## Verification boundary

OpenSpec strict validation, the package tests and the scratch-server browser journeys are run by the runner; none counts as evidence until it has run.
