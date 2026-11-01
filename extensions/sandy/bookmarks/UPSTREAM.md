# Upstream

Hard fork, files only (no history). Source: rebryk/bb-plugins, subdirectory bookmarks, tag bookmarks/v0.1.1 (baae20ce5e0f).
License: none in the upstream repo; ask the author before redistributing.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: Adapted to the current SDK: the panel is an `experimental_tab` (availability `action`), opened through `experimental_panel.openTab`. The header button still uses the `experimental_threadHeaderAction` alias, which the host mounts but the SDK no longer types; `legacy-header.ts` declares it. Typecheck and tests pass.
