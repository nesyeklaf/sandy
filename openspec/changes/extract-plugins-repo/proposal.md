# Extract the owner's plugins and pi extensions into their own repository

## Why

The owner: "Ich will die Plugins aus dem Sandy Repo entfernen, damit sie getrennt released werden können."

The 19 sandy plugins under `extensions/sandy/` and the 5 pi extensions under `extensions/pi/` live in the sandy repository but outside its pnpm workspace. A plugin change reaches the owner only through sandy's main checkout on the server host, and every unit builds against the SDK in the same tree (`file:../../../packages/plugin-sdk`). Neither a plugin version nor its compatibility with a sandy release is recorded anywhere. Sandy already installs plugins from `git:<url>@<semver-range>` with `--subdirectory` and `--tag-prefix`, checks `engines.sandy` and `engines.sandyPluginSdk`, and reports updates (`sandy plugin outdated|update`). The units use none of this yet.

## What Changes

- A separate plugin repository holds `sandy/<unit>`, `pi/<unit>`, `scripts/` and `packages/skill-dialect`. The repository root takes the place of `extensions/`, so relative paths inside the tree do not change. Recommended: revive `nesyeklaf/plugins`, which needs unarchiving (see design, Decision 1).
- Recommended repository shape: one monorepo of plugins with per-unit release tags (`<unit>-v<semver>`) and one pi release train (`pi-v<semver>`). The alternative, one repository per plugin, is weighed in the design (Decision 2).
- Units stop linking into the sandy tree. Each declares the SDK and `sandy-app` as optional peer ranges, plus the `engines` it already has. CI and local tests install a packed SDK from a pinned sandy release. Once the owner approves publishing `@sandy-sdk/plugin-sdk` to npm, units use registry ranges instead.
- Per-unit semver, a release script, CI per changed unit, and a compatibility record (`compat.json`) of the sandy releases each unit was tested against.
- History is preserved with `git filter-repo` from a fresh sandy clone and grafted onto the old `nesyeklaf/plugins` history.
- A migration that keeps every installed plugin working at every step:
  1. Path sources move to a checkout of the new repository (`sandy plugin install path:` keeps settings).
  2. pi-setup points pi at the same checkout.
  3. Git sources follow only after sandy can switch a source without deleting plugin state.
  4. `extensions/` leaves sandy last.
- Rollback steps for each migration step.

## Capabilities

### New Capabilities
- `plugin-repository`: where the owner's sandy plugins and pi extensions live, how they are versioned, tested against sandy releases, released, installed and updated, and how they are migrated out of the sandy repository without breaking installed plugins.

### Modified Capabilities
None in this change. The final removal step changes sandy files (README, docs, exception lists, perf harness, `sandy.holon`, the holon models and `openspec/specs/holon-*`). That step gets its own change once the owner settles Open Question 3.

## Impact

- This change adds only `openspec/changes/extract-plugins-repo/`. No code moves, no repository is created or changed, and nothing is pushed.
- Later steps touch:
  - the plugin repository;
  - pi-setup (`links.tsv` lines for `permissions`, `autopilots` and `lifecycle`; `settings/base.json` packages `pi/context` and `pi/work`);
  - the owner's installed plugin sources on the server host;
  - finally sandy (removal of `extensions/` and `packages/skill-dialect`).
- Sandy core stays as it is, except for one optional follow-up: a source switch from path to git that keeps plugin state. That follow-up would need CLI, guide and SDK parity per AGENTS.md (Decision 6).

## Non-goals

- Moving the builtin plugins under `plugins/`. They are core: they ship bundled in `sandy-app` through `prepare:bundled`, are registered in `BUILTIN_PLUGINS`/`OFFICIAL_PLUGINS`, are workspace dependencies of `@sandy/bundled-plugins`, and are held to `scripts/forkable-plugins.json`. Nothing found argues for moving them.
- Moving the Plugin SDK, `@sandy/plugin-build`, the plugin registry, the Plugin Guide (`plugins/plugin-api-docs`) or `docs/forkable-plugins.md`.
- Changing `/home/feysen/projects/private/gh/pi-extensions`. It is a separate curated pi package on the `eysenfalk` account (hats, intent-mode, powerline-footer, pinned npm extensions) and only overlaps through npm `pi-fabric`.
- Editing the owner's map in the master repository. It still names the old plugins repo as the home of plugins; the owner updates it.
- Publishing, pushing, unarchiving or creating repositories, and changing installed plugins. Each needs the owner's explicit OK.

## Approval State

The owner decided to write a new spec. Not yet decided:
- whether this change uses standalone OpenSpec without the Holon gate, as `sidebar-spaces` did;
- the repository name and shape;
- npm publishing of the SDK;
- repository visibility.

Until the owner answers, this change is written as standalone OpenSpec. No Holon modeling, export or READY step has been treated as required, and no `.holon` file was touched.
