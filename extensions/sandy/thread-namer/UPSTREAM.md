# Upstream

Hard fork, files only (no history). Source: suiramdev/bb-plugin-thread-namer, tag v0.1.0 (023d1229db02).
License: MIT, LICENSE kept.

Changes: manifest key `bb` -> `sandy`, SDK `@sandy-sdk/plugin-sdk` from this repo (`file:`), names renamed with scripts/rename-sandy.mjs. No upstream merges.
Open: Adapted to the current SDK: the header button still uses the `experimental_threadHeaderAction` alias, which the host mounts but the SDK no longer types; `legacy-header.ts` declares it. Reasoning levels from the SDK are narrowed to the picker's known set. Typecheck and tests pass.
