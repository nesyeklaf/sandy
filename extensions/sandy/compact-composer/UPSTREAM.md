# Upstream

Hard fork, files only (no history). Source: owner's own work, local checkout plugins-wt/compact-composer/bb/compact-composer 0.1.4.
License: owner's own.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: typecheck fails against the current SDK (removed slots such as experimental_threadHeaderAction, threadPanelAction); the bundle builds and loads.
