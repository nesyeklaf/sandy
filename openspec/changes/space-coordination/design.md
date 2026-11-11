# Design: Space coordination

## Grammar

| Noun | Kind | Purpose | Relations |
|---|---|---|---|
| Space | Workspace (core thread section) | Bundles one undertaking across repositories | has 0..n orchestrators, n members, n ideas, 1 scratchpad |
| Member session | Session in the Space | Does the work | belongs to one Space; has a coordination mode; runs in one environment |
| Orchestrator | Role of one member, scoped to its Space | Turns ideas into work and follows it | manages managed members only |
| Coordination mode | Attribute of a member | independent (default) or managed | set by the owner |
| Idea | Entry in a Space | A proposal that may become work | links to 0..n member sessions |
| Scratchpad | One document per Space | Shared notes for owner, orchestrator, members | revisioned |
| Environment | Existing core object | Repository, host, path, worktree, branch | read, never owned by the Space |
| State | Derived from session facts | needs you, failed, working, in review, merged, idle, dormant | one primary shelf per root |
| Filing | Lifecycle | snoozed, parked, archived, settled | outranks state |

Operational principle: a session dropped into a Space is visible to its orchestrators but independent; any message from an orchestrator is refused before it reaches the session until the owner switches it to managed.

## Verbs

| | Owner | Orchestrator | Member session |
|---|---|---|---|
| Space context (members, environments, PRs, ideas, scratchpad revision) | read (panel, CLI) | read (tool) | read (tool) |
| Assign / clear orchestrator | yes | no | no |
| Set coordination mode | yes | no | no |
| Start member session | yes (core) | yes (tool) | no |
| Message member | yes | managed only | no new tool; core paths unchanged |
| Stop turn, archive member | yes | managed only | no |
| Create / edit idea | yes | yes | yes |
| Delete idea | yes | yes | no |
| Read / write scratchpad | yes | yes | yes |

## Decisions (confirmed by the owner, 2026-11-11)

1. Several orchestrators per Space. Each must be a member of that Space; moving it out or deleting it clears its role. Unassigned sessions cannot be orchestrators. Orchestrators of one Space coordinate through the scratchpad and ideas; the plugin does not split members between them.
2. The coordination mode defaults to independent for every member, including existing sessions. The owner switches a session to managed. Sessions an orchestrator starts are created managed. A managed member may be managed by any orchestrator of its Space.
3. Wake digest: when a managed member's turn ends failed, with a pending question, or finished, the plugin queues a digest to every orchestrator of the Space. At most one digest per orchestrator per 60 s, at most 50 entries, oldest dropped and counted. The owner can turn wake-ups off per Space.
4. Start fresh: the old global orchestrator and idea marks are discarded. A migration drops the thread_orchestrators and thread_ideas tables; no Space gets an orchestrator or ideas from them.
5. Shelves: Needs you, Failed, Working, In review, Merged, Orchestrators, Idle, Dormant, Snoozed, Archived. The Orchestrators shelf stays, with today's priority (after Needs you, Failed and Working). The Ideas shelf is removed because ideas are entries. "Ready" is renamed "Idle": nothing else matched, it is not "done". Flow keeps its Orchestrators shelf and drops its Ideas shelf.
6. Deleting a Space keeps its ideas and scratchpad, keyed by the deleted Space id. They are readable through RPC and `sandy spaces orphans`, and `sandy spaces adopt <old-space-id> <space>` moves them into a live Space (scratchpads are appended under a heading, ideas keep their links). The Space panel shows only live Spaces.
7. Sort modes are one persisted Spaces preference (default: recent activity), separate from Flow's, applied inside every shelf of every Space.

## Data

Plugin SQLite tables (migrations, real SQLite in tests):

- `space_orchestrators(thread_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, assigned_at INTEGER NOT NULL)` with index on space_id
- `space_settings(space_id TEXT PRIMARY KEY, wake_enabled INTEGER NOT NULL)`
- `space_member_modes(thread_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('managed')), set_at INTEGER NOT NULL)` — absence means independent, so a moved or new session is independent without a write.
- `space_ideas(id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, author_kind TEXT NOT NULL, author_thread_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` with index on space_id.
- `space_idea_links(idea_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (idea_id, thread_id))`
- `space_scratchpads(space_id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_by_kind TEXT NOT NULL, updated_by_thread_id TEXT, updated_at INTEGER NOT NULL)`

Idea status: open, planned, in-progress, done, dropped.

Limits, named with units last: `IDEA_TITLE_CHARS_MAX = 200`, `IDEA_BODY_BYTES_MAX = 16384`, `IDEAS_PER_SPACE_MAX = 500`, `IDEA_LINKS_MAX = 50`, `SCRATCHPAD_BYTES_MAX = 65536`, `SPACE_MEMBERS_LISTED_MAX = 500`, `WAKE_DIGEST_ENTRIES_MAX = 50`, `WAKE_DIGEST_INTERVAL_MS = 60000`. Reads page core lists in batches of at most 200 ids.

Membership is not stored by the plugin: a member is any live thread whose core `sectionId` is the Space id. Deleted threads are removed from orchestrator, mode and link tables on `thread.deleted`. Section moves are observed on thread update events and on every read: an orchestrator row whose thread is no longer in that Space is cleared on read.

## Enforcement

- Agent tools check the caller: `space_*` management tools run only for orchestrators of that Space; member tools run for any member of the Space. A tool call from elsewhere returns an error naming the reason.
- A `message.dispatch` hook refuses a dispatch to thread T when `senderThreadId` is an orchestrator, or a session an orchestrator started with `space_start_session` and that is still in that Space, and T is independent or not in that orchestrator's Space. This also covers `sandy thread tell` and core send paths that carry a sender. A message without a sender (the owner typing) is never refused. Mixed senders are refused if any sender would be refused.
- Orchestrator instructions replace the old standing request: work only through Space members, start sessions with `space_start_session` (never as children), never message independent sessions, read the Space context before acting.

## Agent tools

Orchestrator: `space_context`, `space_start_session({ projectId, environment, title, prompt, ideaId? })`, `space_message_session({ threadId, text })`, `space_stop_session({ threadId })`, `space_archive_session({ threadId })`, plus all member tools.
Member (any session in a Space): `space_context`, `space_ideas_list`, `space_idea_create`, `space_idea_update`, `space_scratchpad_read`, `space_scratchpad_write({ body, baseRevision })`. Orchestrator alone: `space_idea_delete`.

`space_context` returns per member: id, title, status, activity facts used by shelves, project id and name, environment host, path, isWorktree, branchName, PR state, coordination mode, whether it is an orchestrator; plus ideas (id, title, status, links) and the scratchpad revision.

`space_start_session` calls `threads.create` with `sectionId` = Space id, no `parentThreadId`, no `lifecycleOwnerThreadId`, `senderThreadId` = orchestrator. With `ideaId` it links the new session to the idea and sets the idea to in-progress.

## Surfaces

- Thread side panel: fixed tab "Space" (`app.slots.experimental_tab`, context thread, availability fixed, `useVisible` true only when the thread's section is a Space). Sections: Overview (orchestrators with add/remove, members with a "Managed" switch, wake-up switch), Ideas (list, create, edit, status, links, delete), Scratchpad (Markdown editor; save sends baseRevision; a conflict shows the current text and keeps the draft).
- Space header menu: "Add orchestrator…".
- Row menu: "Orchestrator of this Space" toggle and "Managed" toggle; the old idea and global orchestrator menu items are removed.
- RPC: `getSpaceCoordination`, `setOrchestrator`, `setMemberMode`, `setSpaceWake`, `listIdeas`/`createIdea`/`updateIdea`/`deleteIdea`, `getScratchpad`/`writeScratchpad`. Realtime channel per Space id.
- CLI: `sandy spaces show <space>`, `sandy spaces orchestrator add|remove <thread>`, `sandy spaces orphans`, `sandy spaces adopt <old-space-id> <space>`, `sandy spaces member mode <thread> managed|independent`, `sandy spaces ideas list|add|update|remove`, `sandy spaces scratchpad show|write [--base-revision N] [--file -]`. JSON output with `--json`. The CLI guide and the plugin skill document them.

## Code style: tiger-style, adapted

Project rules win where they conflict (camelCase names, Biome formatting, no code comments, Turbo, real SQLite). From tiger-style, implementations SHALL:

- Assert preconditions and postconditions at every boundary and in every non-trivial function with a small `assert(condition, message)` helper that throws; assert the same invariant from two paths where it matters (for example scratchpad revision on write and on read).
- Bound every loop and batch with a named limit; no recursion.
- Handle every branch explicitly: exhaustive `switch` with a `never` check, an `else` for every `if` that decides behavior.
- Handle every error: no empty `catch`, no `.catch(() => undefined)`; log with context or return a typed error.
- Keep functions at most 70 lines; split compound conditions into named booleans.
- Name without abbreviations; units and qualifiers last (`digestIntervalMs`, `bytesMax`).
- Parse at the boundary with zod, then pass typed values.

Reviewers flag violations as CRITICAL (missing assertion at a boundary, unbounded loop, ignored error), MAJOR (function over 70 lines, missing else, non-exhaustive switch) or MINOR (naming, units).

## English only

All user-visible and agent-visible text in the plugin is English. A unit test scans `src/`, `app.tsx`, `README.md` and `skills/` (tests and fixtures excluded) for German umlauts, ß and a list of known German words (for example "Orchestratoren", "Ideen", "Lädt", "Idee") and fails with the file and line.

## Risks

- **Cooperative boundary.** The protection binds agents that use the Space tools and the normal `sandy` CLI. A session that clears `SANDY_THREAD_ID`, spoofs a sender, runs `sandy thread stop` or `sandy thread archive`, creates a session without a parent through `sandy thread spawn`, or moves itself out of its Space and back through `sandy thread update --section` or `--clear-section` is not prevented, because the core takes caller identity from the client. A hard boundary would need an authenticated per-session identity for the CLI and HTTP paths plus a stop/archive hook; both are core changes outside this plugin.
- Proxy path: a session started with `space_start_session` is recorded with its starter and Space (`space_started_sessions`); on `thread.created` a child of a restricted session or of an orchestrator is recorded too, so descendants are restricted transitively (a descendant outside any Space stays restricted). The dispatch hook treats them like an orchestrator while they stay in that Space, except that any restricted sender may message an orchestrator of its own Space. Switching a started session to independent does not lift its own sender restriction. The record survives the starter being archived or losing its role, is cleared on `thread.deleted` and when a read observes the session in another Space.
- Stale tools: after a move the plugin has not observed, an orchestrator's tool list can stay stale for one turn; tool execution still checks the role and Space, so the tools refuse.
- Race window: a dispatch is checked once. A role or mode change that lands while one dispatch is in flight can let that one dispatch through.
- Hook coverage: a dispatch without a sender cannot be attributed. Mitigation: `space_message_session` always sets the sender; the risk is accepted for other unattributed paths.
- Section changes outside the plugin: handled by checking membership on every read and dispatch, not by cached state alone.
- Wake-up noise: bounded digest and per-Space switch.
