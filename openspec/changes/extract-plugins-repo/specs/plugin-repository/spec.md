# Plugin repository

## ADDED Requirements

### Requirement: Separate plugin repository
The owner's sandy plugins (`extensions/sandy/*`), pi extensions (`extensions/pi/*`), their scripts and `packages/skill-dialect` SHALL live in one repository outside sandy whose root replaces `extensions/`, so that every relative path inside the tree stays unchanged.

#### Scenario: Relative imports survive
- **GIVEN** `pi/work/delegate/gate.ts` imports `../../../sandy/work/delegate/shared/policy.ts`
- **WHEN** the plugin repository is checked out
- **THEN** the import resolves without edits and `npm test` in `pi/work` passes

#### Scenario: Builtins stay in sandy
- **GIVEN** a plugin under sandy's `plugins/` is bundled into `sandy-app`
- **WHEN** the extraction is complete
- **THEN** it remains in sandy, and the plugin repository contains only units that came from `extensions/` plus `packages/skill-dialect`

### Requirement: No link into the sandy tree
No `package.json` in the plugin repository SHALL reference sandy's tree through `file:`, `link:` or `workspace:`; the Plugin SDK and `sandy-app` SHALL be declared by version range.

#### Scenario: Clean clone installs
- **GIVEN** a clone of the plugin repository with no sandy checkout next to it
- **WHEN** `npm ci` runs in any unit
- **THEN** it succeeds, and `grep -rE '"(file|link|workspace):' --include=package.json` outside `node_modules` finds only paths inside the plugin repository

#### Scenario: SDK not yet on npm
- **GIVEN** `@sandy-sdk/plugin-sdk` is not published on npm
- **WHEN** a unit's tests run
- **THEN** `scripts/sdk.sh <sandy-ref>` installs an SDK packed from that sandy release, and the unit's `package.json` is unchanged afterwards

#### Scenario: Git install needs no dev dependency
- **GIVEN** a unit is installed through a sandy git source, which runs `npm install --omit=dev --omit=optional` without `.npmrc`
- **WHEN** sandy builds its bundles
- **THEN** every runtime dependency resolves from npm or from inside the plugin repository checkout

### Requirement: Recorded compatibility with sandy releases
Each unit SHALL declare `engines.sandy` and `engines.sandyPluginSdk`, and every unit release SHALL record in `compat.json` the sandy tag and SDK version it was tested against.

#### Scenario: Release records its test target
- **WHEN** `scripts/release.mjs genui` creates `genui-v0.3.2`
- **THEN** `compat.json` holds an entry for genui 0.3.2 with the sandy tag and SDK version whose tests and `sandy plugin build` passed

#### Scenario: SDK change in sandy main is reported early
- **GIVEN** sandy `main` changes an SDK export a unit uses
- **WHEN** the nightly compatibility job runs that unit against sandy `main`
- **THEN** the job fails for that unit, and blocking CI against the owner's sandy release stays green

### Requirement: Per-unit versioning and release tags
Each sandy plugin SHALL be versioned on its own and released as an annotated tag `<unit>-v<semver>`. The pi extensions SHALL be released together as `pi-v<semver>` from the root `package.json`. Paired units SHALL be released from the same commit.

#### Scenario: Tag matches the manifest
- **WHEN** `<unit>-v<x.y.z>` is created
- **THEN** `sandy/<unit>/package.json` at that commit has version `x.y.z`, and the release script refuses an existing tag or a dirty tree

#### Scenario: Paired release
- **GIVEN** a commit changes `sandy/work` and `pi/work`
- **WHEN** it is released
- **THEN** `work-v*` and `pi-v*` point at the same commit, and both release notes name the pair

### Requirement: CI per changed unit
The plugin repository SHALL run, for each changed unit, install, packed-SDK setup, tests and `sandy plugin build`, and SHALL run all units when shared scripts, `packages/` or `compat.json` change.

#### Scenario: One unit changed
- **WHEN** a pull request changes only `sandy/thread-namer/`
- **THEN** CI runs thread-namer only and reports its test and build results

### Requirement: Install and update from the plugin repository
After migration, no installed sandy plugin or pi extension on the owner's hosts SHALL load code from a sandy checkout. Sandy plugins SHALL be installed from a checkout of the plugin repository (phase 1) or from `git:<repo>@<range> --subdirectory sandy/<unit> --tag-prefix <unit>-v` (phase 2). pi SHALL load the pi extensions through pi-setup from the same repository.

#### Scenario: Phase 1 move keeps configuration
- **GIVEN** a plugin is installed from `path:~/projects/private/gh/sandy/extensions/sandy/<unit>` with settings
- **WHEN** `sandy plugin install path:<plugin checkout>/sandy/<unit>` runs
- **THEN** `sandy plugin source <id>` shows the new path, the plugin is `running`, and its settings, secrets and schedules are unchanged

#### Scenario: Phase 2 update
- **GIVEN** a unit is installed from a git source with a semver range and a tag prefix
- **WHEN** a newer compatible `<unit>-v*` tag is pushed
- **THEN** `sandy plugin outdated` lists it, and `sandy plugin update <id>` installs it

#### Scenario: pi follows pi-setup
- **WHEN** pi-setup's `links.tsv` and `settings/base.json` point at the plugin checkout and `node apply.mjs <host>` has run
- **THEN** a new pi session registers the same tools as before the switch, and no path under `~/.pi/agent` resolves into a sandy checkout

### Requirement: Migration keeps installed plugins working
The migration SHALL proceed in the order given in the design, with `extensions/` removed from sandy last. After every step, each enabled plugin SHALL be `running`. Each step SHALL have a rollback that restores the previous source without losing plugin state.

#### Scenario: Roll back one plugin
- **GIVEN** a plugin moved to the plugin checkout fails to start
- **WHEN** `sandy plugin install path:~/projects/private/gh/sandy/extensions/sandy/<unit>` runs
- **THEN** the plugin runs from sandy again with its settings intact

#### Scenario: Removal waits for every source
- **GIVEN** any installed plugin source or pi path still points into `extensions/` of a sandy checkout
- **WHEN** the sandy removal change is prepared
- **THEN** it is not merged

### Requirement: History preserved
The plugin repository SHALL contain the full commit history of `extensions/` and `packages/skill-dialect` from sandy, joined to the pre-move history of `nesyeklaf/plugins` when that repository is revived, and sandy references `#N` SHALL point to `nesyeklaf/sandy#N`.

#### Scenario: History is complete
- **WHEN** the filtered history is built
- **THEN** its commit count equals `git log --oneline -- extensions packages/skill-dialect | wc -l` in sandy, its HEAD tree equals sandy's trees for those paths, and `git log --follow sandy/genui/package.json` reaches commits from before 2026-10-31

### Requirement: Sandy keeps the plugin platform
Sandy SHALL keep the Plugin SDK, `@sandy/plugin-build`, the plugin registry, the Plugin Guide (`plugins/plugin-api-docs`), `docs/forkable-plugins.md`, the SDK publish job, and the install and update machinery. The plugin repository SHALL link to the Plugin Guide instead of documenting the plugin API.

#### Scenario: No plugin API documentation copied
- **WHEN** the plugin repository's README and AGENTS.md are written
- **THEN** they link to the Plugin Guide for API questions and contain only build, test, release and install rules
