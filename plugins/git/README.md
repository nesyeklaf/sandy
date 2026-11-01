# Git

Owns git status, changed files, diffs and the Diff tab for sandy environments. Bundled and enabled by default.

- `host.ts` runs git in the environment's workspace on its machine: status, diff, changed files, patches and branch options. Reads share one cache per workspace path.
- `server.ts` resolves environments, fills in the merge base the thread uses, serves the keyed `status` and `patches` reads, `files`, `diff`, `fileSide`, `branches` and the Viewed and merge-base mutations, and registers `sandy git`. `server/invalidation.ts` turns the daemon's file and ref change events into one coalesced refresh per environment.
- `app.tsx` registers the Diff tab (`experimental_tab`, with a file or commit target and the `toggle-diff` command), the Info rows and sections, and the changed-files segment of the composer's thread context row. Their components live in `ui/`.
- `contract.ts` is the public contract. Core reads it with `pluginId: "sandy--git"` for the Commit dialog, the composer branch chip and `sandy thread show`, the way any other plugin would.

Viewed marks stay in core's `diff_viewed_files` table; the plugin reads and writes them through the SDK.
