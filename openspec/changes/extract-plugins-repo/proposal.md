# Extract the owner's plugins and pi extensions into their own repository

## Why

The owner: "Ich will die Plugins aus dem Sandy Repo entfernen, damit sie getrennt released werden können."

The 19 sandy plugins under `extensions/sandy/` and the 5 pi extensions under `extensions/pi/` live in the sandy repository but outside its pnpm workspace. Each is an npm project with its own `package-lock.json`. A plugin change reaches the owner only through sandy's main checkout on the server host, and every unit builds against the SDK in the same tree (`file:../../../packages/plugin-sdk`). Neither a plugin version nor its compatibility with a sandy release is recorded anywhere.

Sandy already installs plugins from `git:<url>@<semver-range>` with `--subdirectory` and `--tag-prefix`, checks `engines.sandy` and `engines.sandyPluginSdk`, and reports updates. The units use none of this yet. One piece is missing: an installed plugin cannot move from a path source to a git source without `sandy plugin remove`, and `remove` deletes its settings, secrets and schedules.

## What Changes

- A new private repository, proposed as `<org>/sandy-plugins` (checkout `~/projects/private/gh/sandy-plugins`), holds `sandy/<unit>`, `pi/<unit>`, `scripts/` and `packages/skill-dialect`. The repository root takes the place of `extensions/`, so relative paths inside the tree do not change. The archived `nesyeklaf/plugins` stays untouched.
- Shape: one monorepo of plugins with per-unit release tags (`<unit>-v<semver>`) and one pi release train (`pi-v<semver>`). The alternative, one repository per plugin, is weighed in design.md (Decision 2).
- All units use pnpm: one pnpm workspace at the repository root, one `pnpm-lock.yaml`, no `package-lock.json`.
- Units stop linking into the sandy tree.
  - The Plugin SDK is renamed from `@sandy-sdk/plugin-sdk` to `@<org>/plugin-sdk` in sandy and in every unit. Installed plugins built against the old name keep loading through legacy specifiers (design.md, Decision 10).
  - The SDK is published privately to GitHub Packages by a workflow in the plugin repository with `GITHUB_TOKEN` (Decision 3).
  - Sandy, the plugin repository and the package belong to one GitHub organization `<org>`: `nesyeklaf/sandy` is transferred there (Decision 9).
  - The plugin repository's CI runs on boat.dev runners. The list of sandy jobs that could move is an owner question (Decision 11).
- `<org>` is a placeholder until the owner names the organization and confirms that the package scope follows it.
  - Until the first publish, a packed SDK from a pinned sandy release bridges the gap.
  - Nothing is published without the owner's explicit OK.
- Per-unit semver, a release script, CI per changed unit, and `compat.json` with the sandy releases each unit release was tested against.
- History of `extensions/` and `packages/skill-dialect` is preserved with `git filter-repo` from a fresh sandy clone.
- The plugin holons (genui, holon, field-latency) move with their code into the plugin repository's own Holon root, and their exported specs move with them.
- Core sandy change: `sandy plugin install <source> --replace-source` gives an installed plugin a new source and keeps its settings, secrets, schedules and data. It has the same surface in the server API, the SDK client, the CLI, the guide and Settings → Installed plugins.
- Migration in this order, keeping every installed plugin working at every step:
  1. Path sources move to a checkout of the new repository.
  2. pi-setup points pi at that checkout.
  3. Plugins switch to git sources with `--replace-source`.
  4. `extensions/` leaves sandy last.
  The four disabled installs that point at `/home/aemon/...` are re-pointed to the new repository like the others.
- Rollback steps for each migration step.

## Capabilities

### New Capabilities
- `plugin-repository`: where the owner's sandy plugins and pi extensions live, how they are built (pnpm), versioned, tested against sandy releases, released, installed and updated, and how they are migrated out of the sandy repository without breaking installed plugins.
- `plugin-sdk-package-name`: the SDK under `@<org>/plugin-sdk`, with old names still resolving for installed plugins.
- `plugin-source-replacement`: replacing the source of an installed plugin while keeping its state, through the API, SDK, CLI and UI.

### Modified Capabilities
None. The final removal step changes sandy files (README, docs, exception lists, perf harness, `sandy.holon`, the plugin holons and `openspec/specs/holon-*`) as listed in design.md.

## Impact

This change adds only `openspec/changes/extract-plugins-repo/` and one line in AGENTS.md. Later steps touch:
- the new repository;
- pi-setup (`links.tsv` and `settings/base.json`);
- the owner's installed plugin sources;
- sandy, for the rename to `@<org>/plugin-sdk`: the SDK package, about 1549 files including 80 `package.json`, the plugin runtime and plugin-build specifiers, templates, CLI, Plugin Guide, docs, scripts and CI filters;
- sandy, for the transfer to `<org>`: 88 files referencing `nesyeklaf/sandy`;
- sandy core, for `--replace-source`: server install route and service, server contract, SDK client, CLI, guide template, Settings UI and tests;
- finally the removal of `extensions/` and `packages/skill-dialect` from sandy.

The core change touches only the server and its clients. It does not change any server/daemon wire field, so `HOST_DAEMON_PROTOCOL_VERSION` stays the same. It adds no plugin API member, so `docs/api_to_audit.md` is unaffected.

## Non-goals

- Moving the builtin plugins under `plugins/`. They are core: they ship bundled in `sandy-app` through `prepare:bundled`, are registered in `BUILTIN_PLUGINS`/`OFFICIAL_PLUGINS`, are workspace dependencies of `@sandy/bundled-plugins`, and are held to `scripts/forkable-plugins.json`. Nothing found argues for moving them.
- Moving the Plugin SDK, `@sandy/plugin-build`, the plugin registry, the Plugin Guide (`plugins/plugin-api-docs`) or `docs/forkable-plugins.md`.
- Reviving or changing `nesyeklaf/plugins` or `/home/feysen/projects/private/gh/pi-extensions`. pi-extensions is a separate curated pi package on the `eysenfalk` account and only overlaps through npm `pi-fabric`.
- Editing the owner's map (`master-repo/docs/maps/private.md`). design.md, "Owner's map", lists the edits; the owner makes them.
- Teaching sandy's git install to honor `pnpm-lock.yaml`. Runtime dependencies stay registry ranges (design.md, Decision 3).

## Approval State

- 2026-11-12, the owner decided to write a new spec.
- 2026-11-12, owner's answers:
  - **Holon gate:** standalone OpenSpec ("OpenSpec only"). Holon modeling, approval, export and READY checks are not prerequisites for this change, and AGENTS.md lists `extract-plugins-repo` next to `sidebar-spaces` and `space-coordination`.
  - **Repository:** a new repository, not a revived `nesyeklaf/plugins`.
  - **Visibility:** private.
  - **SDK:** publish `@sandy-sdk/plugin-sdk` to a registry.
  - **SDK registry (later the same day):** GitHub Packages, private; only the owner and GitHub Actions install it.
  - **SDK name (later):** a real rename to `@<org>/plugin-sdk` in sandy and every plugin, with no alias.
  - **GitHub organization (later):** sandy moves into its own organization `<org>`, name still open.
  - **CI:** boat.dev runners (`runs-on: boat*`; GitHub App on the organization; paid plan; Linux x86-64 only).
  - **Phase 2:** core `--replace-source` is part of this spec.
  - **The four disabled `/home/aemon/...` installs:** re-point them to the new repository.
  - **Holons:** the plugin holons move with their code.
  - **Package manager (new rule):** all plugins use pnpm (no `package-lock.json`, a pnpm workspace in the new repository).
- Still open:
  - the organization name `<org>`, and whether the package scope follows it;
  - whether anything besides `@sandy-sdk/plugin-sdk` is renamed;
  - which sandy jobs move to boat;
  - the publishing repository (P1, the plugin repository, recommended);
  - the final repository name (`<org>/sandy-plugins` is a proposal);
  - pi/fabric's bun toolchain under the pnpm rule (design.md, Open Questions).
- This change authorizes writing the spec only. Creating the repository, pushing, publishing, installing, changing pi-setup and deploying each need the owner's explicit OK.
