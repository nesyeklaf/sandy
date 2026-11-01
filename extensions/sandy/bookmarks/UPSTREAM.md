# Upstream

Hard fork, files only (no history). Source: rebryk/bb-plugins, subdirectory bookmarks, tag bookmarks/v0.1.1 (baae20ce5e0f).
License: none in the upstream repo; ask the author before redistributing.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: typecheck fails against the current SDK (removed slots such as experimental_threadHeaderAction, threadPanelAction); the bundle builds and loads.
