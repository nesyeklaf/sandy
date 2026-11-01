# Upstream

Hard fork, files only (no history). Source: suiramdev/bb-plugin-thread-namer, tag v0.1.0 (023d1229db02).
License: MIT, LICENSE kept.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: typecheck fails against the current SDK (removed slots such as experimental_threadHeaderAction, threadPanelAction); the bundle builds and loads.
