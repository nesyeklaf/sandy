# Upstream

Hard fork, files only (no history). Source: abdoutelb/bb-plugin-files-editor, tag v0.1.6 (10657efcf207).
License: LICENSE kept.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: Adapted to the current SDK: the panel is an `experimental_tab` (availability `action`), opened through `experimental_panel.openTab`. Typecheck and tests pass.
