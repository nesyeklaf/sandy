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

The Space protection is cooperative: it binds agents using the Space tools and the normal sandy CLI, including sessions an orchestrator started. Clearing SANDY_THREAD_ID, spoofing a sender, or running sandy thread stop or archive is not prevented; a hard boundary would need an authenticated per-session identity and a stop/archive hook in the core. Do not rely on it against an agent that tries to get around it.

## Coordinate a Space

`sandy spaces` takes a Space id or its exact name; every command accepts `--json`.

```sh
sandy spaces show Alpha --json
sandy spaces orchestrator add <thread>          # one or more per Space
sandy spaces orchestrator remove <thread>
sandy spaces member mode <thread> managed       # independent (default) or managed; owner only
sandy spaces wake Alpha off                     # wake digest per Space
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
- With wake-ups on, an orchestrator receives at most one digest per minute (newest 50 entries plus an omitted count) when a managed member fails, asks or finishes.
- Deleting a Space keeps its ideas and scratchpad; `orphans` lists them and `adopt` moves them.
