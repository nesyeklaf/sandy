# Delegate sidebar Spaces

## Why

The owner works on multiple named ideas across repositories. The current Tree view nests section, repository and session, while Flow groups status globally. Neither provides a scrollable overview of all named work areas with actionable status counts before opening them.

The owner approved the interactive Space prototype and requested implementation plus an OpenSpec specification. This proposal specifies that design; it does not authorize publishing or deployment.

## What Changes

- Present core thread sections as Spaces. A Space can contain sessions from several Sandy projects without changing their repositories.
- Replace Tree with Space -> automatic status shelves -> existing session rows; keep Flow available.
- Keep all named Space headers in one scrollable list and allow independent expansion.
- Add three Space-header densities independent of the established session row density.
- Aggregate unique representative sessions, including descendant attention; count PR-bearing sessions rather than PR objects.
- Let a status counter reveal matching sessions without duplicating roots that have several signals.
- Reuse native section CRUD and thread assignment, persistent preference helpers, existing lifecycle and PR integrations.
- Expose the shared read model through a discoverable plugin RPC and document core CLI/SDK parity.

## Capabilities

### New Capabilities
- `sandy-sidebar-spaces`: named cross-repository work areas with aggregate headers, independent density and automatic session status shelves.

### Modified Capabilities
None. This change adds a plugin capability; it does not redefine Sandy projects or core section APIs.

## Impact

Implementation is limited to `extensions/sandy/sandy-sidebar-delegate/`, plus this standalone OpenSpec change. Core API and SDK changes are not required. Existing section ids, memberships and repositories remain intact. The saved Tree layout migrates to Spaces; explicit Flow and session-density choices survive.

## Non-goals

Plugin extraction, independent release packaging, npm/pnpm conversion, releases, plugin installation/reload, deployment, custom manual shelves inside Spaces, multi-Space membership, drag-to-reorder Spaces and changes to fleet or other projects.

## Approval State

Design approved and local implementation authorized by the owner ("Go ahead with the plan"). This standalone OpenSpec is the planning source; Holon modeling, approval, export and READY checks are not prerequisites for this change. Publishing, installation and deployment still need separate approval.

The owner confirmed seven complete inactive days as the dormancy default.
