# Upstream

Hard fork, files only (no history). Source: nesyeklaf/bb-plugin-value, HEAD e04c6b37e72d.
License: owner's own.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
The Segmented component of @danielbachhuber/bb-plugin-component-library 1.4.0 is vendored in components/segmented.tsx (the package imports the pre-fork SDK).
Open: typecheck fails against the current SDK (removed slots such as experimental_threadHeaderAction, threadPanelAction); the bundle builds and loads.
