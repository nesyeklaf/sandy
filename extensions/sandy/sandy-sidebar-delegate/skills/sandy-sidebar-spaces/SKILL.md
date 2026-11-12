---

name: sandy-sidebar-spaces
description: Read the sidebar's Spaces (named cross-repo effort groups) from the sandy CLI, or explain the Spaces layout, header densities and dormancy. Use for "which Spaces need me", Space counts, or sidebar Space settings.
---

# Sidebar Spaces

A Space is one of sandy's thread sections. Its roots are grouped by status shelves; the repository (sandy project) is metadata on each row, not a level. Root sessions without a section sit in "No Space", shown last and only when non-empty.

## Read the overview

```sh
echo '{}' > /tmp/spaces.json
sandy plugin rpc call sandy-sidebar-delegate getSpaceOverview --input-file /tmp/spaces.json
```

Optional `{"projectId":"..."}` scopes to one repository. Per Space: `total`, `counts` (needs, failed, working, openPr, dormant), `idle`, `repositories` and `roots` with each root's primary `shelf`. `pullRequests` is `"available"` when sandy--github-pr-status answered for every environment and `"unavailable"` when the plugin is disabled, offline or returned unknown rows; unknown PR state keeps a root out of dormant.

## Rules

- Primary shelf precedence: needs you, failed, working, open PR, merged, orchestrator, dormant, idle.
- Dormant: an idle root whose tree had no activity for seven complete days and whose PR is known absent. Unknown PR is not absence.
- Header density (Settings → Sidebar layout → Space headers): minimal, compact (default), detailed. It does not change session row density.
- A saved Tree layout opens as Spaces; Flow remains selectable.

## Boundary

The Space protection is cooperative: it binds agents using the Space tools and the normal sandy CLI, including sessions an orchestrator started. Restricted are orchestrators, sessions started with space_start_session and their descendants; switching a started session to independent does not lift its own sender restriction. Clearing SANDY_THREAD_ID, spoofing a sender, running sandy thread stop or archive, creating a parentless session with sandy thread spawn, or moving itself out and back with sandy thread update --section or --clear-section is not prevented; a hard boundary would need an authenticated per-session identity and a stop/archive hook in the core. Do not rely on it against an agent that tries to get around it.

## Coordinate a Space

`sandy spaces` takes a Space id or its exact name; every command accepts `--json`.

```sh
sandy spaces show Alpha --json
sandy spaces orchestrator add <thread>          # one or more per Space
sandy spaces orchestrator remove <thread>
sandy spaces member mode <thread> managed       # independent (default) or managed; owner only
sandy spaces settings Alpha                     # self-reports, check-in minutes, failure fallback
sandy spaces settings Alpha --check-in-minutes 0 --failure-fallback off   # owner only
sandy spaces report done --summary "Fixed the queue"   # managed member to its orchestrators
sandy spaces ideas list Alpha
sandy spaces ideas add Alpha --title "Cache" --body "Problem and done criteria" --thread <thread>
sandy spaces ideas update <idea> --status in-progress
sandy spaces ideas remove <idea>
sandy spaces scratchpad show Alpha
sandy spaces scratchpad write Alpha --body-stdin --base-revision 4 < plan.md
sandy spaces orphans
sandy spaces adopt <deleted-space-id> Alpha
```

- An orchestrator's message to an independent member, or to a session outside its Space, is refused before it reaches the session. Only the owner switches a member to managed; messages without a sender are never refused.
- A scratchpad write succeeds only when `--base-revision` equals the current revision; otherwise the command exits 1 and prints the current revision and text.
- Limits: 500 ideas per Space, title 200 characters, body 16384 bytes, scratchpad 65536 bytes, 50 linked sessions per idea.
- Orchestrator sessions get the tools space_start_session, space_message_session, space_stop_session, space_archive_session and space_idea_delete; every member gets space_context, space_ideas_list, space_idea_create, space_idea_update, space_scratchpad_read and space_scratchpad_write.
- A managed member reports to the orchestrators of its Space with space_report or `sandy spaces report <done|blocked|question|progress> --summary <text>` (at most 2000 characters) when it finishes, is blocked, needs a decision, or has an interim result. Only managed members may report, and only while self-reports are on.
- Every check-in interval (default 10 minutes, 0 is off) an orchestrator gets one check-in listing the managed members that changed since the last one or look stuck: working without activity for one interval, or idle with no report since their last turn. A check-in where nothing changed is not sent, and none follows while the previous one is still queued.
- With the failure fallback on, an orchestrator gets at most one message per minute (one line per member, newest 50 plus an omitted count) when a managed member fails or waits on a question and has not reported. Each entry is checked again before sending. A turn that only ended is never reported.
- Reports, check-ins and fallback messages start with `[Space <name>]` and come from the plugin, not from the owner.
- Deleting a Space keeps its ideas and scratchpad; `orphans` lists them and `adopt` moves them.
