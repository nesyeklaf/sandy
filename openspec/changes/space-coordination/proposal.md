# Space coordination

## Why

Spaces group sessions across repositories, but they only display status. Coordination happens elsewhere: an orchestrator is a globally marked session that spawns child sessions under itself, idea sessions are a second session role, and the session_roles tool knows no Space. The status shelves also mix three different things — what a session is doing, what role it plays, and how it was filed — so "Orchestrators" and "Ready" sit beside "Working" as if they were states.

The owner wants a Space to be a coordination workspace: one orchestrator that knows every member session and its real repository, branch and worktree; ideas as their own entries; a shared scratchpad; and a per-session choice whether the orchestrator may manage it.

## What Changes

- A Space can have several orchestrator sessions. The orchestrator role is scoped to that Space; the global orchestrator mark goes away.
- Each member session has a coordination mode: independent (default) or managed. Orchestrators may message, stop and archive only managed members. A message-dispatch hook refuses any message an orchestrator sends to an independent session, whatever path it uses.
- The orchestrator starts new sessions as flat Space members: section set to the Space, no parent thread, no lifecycle owner.
- Ideas become entries that belong to a Space: title, body, status and linked sessions. The idea session role and the Ideas shelf are retired; old orchestrator and idea marks are discarded. Deleting a Space keeps its ideas and scratchpad as orphans that can be adopted by another Space.
- Each Space has one shared Markdown scratchpad that the owner, the orchestrator and member sessions can read and write, with revision checks.
- A fixed "Space" tab in the thread side panel (right) shows the Space's orchestrators, members with their coordination mode, ideas and scratchpad.
- The Ideas shelf goes away; the Orchestrators shelf stays; "Ready" becomes "Idle". The same applies in Flow.
- Sessions inside each shelf follow a sort mode the owner picks, reusing the Flow modes: manual, recent activity, date created, repository.
- The whole plugin is English: UI strings, tool descriptions, instructions, CLI output, README and skills. A test guards it.
- Every new capability is reachable through plugin RPC, agent tools and `sandy spaces` CLI commands.

## Capabilities

### New Capabilities
- `sandy-space-coordination`: orchestrators per Space, coordination modes, flat member sessions, idea entries, scratchpad, the Space side-panel tab, state-only shelves with sort modes, and English-only plugin text.

### Modified Capabilities
None formally: `sandy-sidebar-spaces` is still an unarchived change. Where this change differs from it (Ideas and Ready shelves), this change wins and the sidebar-spaces requirements are superseded on archive.

## Impact

Limited to `extensions/sandy/sandy-sidebar-delegate/` and this standalone OpenSpec change. No core, SDK or daemon change: the plugin uses existing section ids, `threads.create` with `sectionId`, the thread side-panel tab slot, agent tools, the message-dispatch hook, plugin storage and plugin CLI. New plugin tables need migrations; the old orchestrator and idea mark tables are dropped.

## Non-goals

Core-level Space objects, automatic orchestrator creation, an issue tracker (assignees, priorities, due dates), real-time collaborative editing of the scratchpad, publishing, installation, deployment or plugin extraction.

## Approval State

Owner direction (2026-11-11): ideas are their own entries; a Space has a scratchpad readable and writable by orchestrator, sessions and owner, shown as its own menu on the right side; a toggle decides whether a session may be orchestrated or stays independent; the orchestrator starts and manages sessions in the Space and manages owner-created sessions not marked independent; the plugin must be English; development follows OpenSpec and tiger-style; Sonnet subagents implement once the spec exists. The owner confirmed the decisions in design.md on 2026-11-11, including the AGENTS.md exception for this change. Publishing, installation and deployment need separate approval.
