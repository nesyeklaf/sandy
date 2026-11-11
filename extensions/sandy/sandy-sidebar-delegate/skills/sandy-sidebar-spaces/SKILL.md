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

Optional `{"projectId":"..."}` scopes to one repository. Per Space: `total`, `counts` (needs, failed, working, openPr, dormant), `ready`, `repositories` and `roots` with each root's primary `shelf`. `pullRequests` is `"available"` when sandy--github-pr-status answered for every environment and `"unavailable"` when the plugin is disabled, offline or returned unknown rows; unknown PR state keeps a root out of dormant.

## Rules

- Primary shelf precedence: needs you, failed, working, open PR, merged, orchestrator, idea, dormant, ready.
- Dormant: a ready root whose tree had no activity for seven complete days and whose PR is known absent. Unknown PR is not absence.
- Header density (Settings → Sidebar layout → Space headers): minimal, compact (default), detailed. It does not change session row density.
- A saved Tree layout opens as Spaces; Flow remains selectable.
