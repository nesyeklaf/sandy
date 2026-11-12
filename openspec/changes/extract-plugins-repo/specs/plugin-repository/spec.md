# Plugin repository

## ADDED Requirements

### Requirement: Separate public plugin repository
The owner's sandy plugins (`extensions/sandy/*`), pi extensions (`extensions/pi/*`), their scripts and `packages/skill-dialect` SHALL live in one new public repository `sandy-sdk/sandy-plugins` outside sandy, whose root replaces `extensions/` so that every relative path inside the tree stays unchanged. The archived `nesyeklaf/plugins` SHALL NOT be changed.

#### Scenario: Relative imports survive
- **GIVEN** `pi/work/delegate/gate.ts` imports `../../../sandy/work/delegate/shared/policy.ts`
- **WHEN** the plugin repository is checked out
- **THEN** the import resolves without edits and the tests of `pi/work` pass

#### Scenario: Builtins stay in sandy
- **GIVEN** a plugin under sandy's `plugins/` is bundled into `sandy-app`
- **WHEN** the extraction is complete
- **THEN** it remains in sandy, and the plugin repository contains only units that came from `extensions/` plus `packages/skill-dialect`

### Requirement: pnpm workspace
All units SHALL be managed by one pnpm workspace at the repository root with a single `pnpm-lock.yaml`; the repository SHALL contain no `package-lock.json`, and CI SHALL install with `pnpm install --frozen-lockfile`.

#### Scenario: No npm lockfile
- **WHEN** `git ls-files '**/package-lock.json' 'package-lock.json'` runs in the plugin repository
- **THEN** it prints nothing, and `pnpm install --frozen-lockfile` at the root succeeds

#### Scenario: Different toolchains coexist
- **GIVEN** two units pin different majors of the same dev tool
- **WHEN** the workspace is installed
- **THEN** each unit's tests run with its own pinned version

### Requirement: Dependencies a sandy git install can resolve
A unit's `dependencies` and `devDependencies` SHALL be public npm registry ranges only, with no `workspace:`, `file:` or `link:` protocol and no private registry. The Plugin SDK SHALL be an optional peer of each unit, provided in development by the workspace root. Internal shared code SHALL be imported by relative source path.

#### Scenario: Git install simulation passes
- **GIVEN** a clean clone of the plugin repository
- **WHEN** `scripts/check-git-install.mjs <unit>` deletes `.npmrc`, runs `npm install --ignore-scripts --omit=dev --omit=optional` in the unit's directory, and runs `sandy plugin build`
- **THEN** both commands succeed for every unit

#### Scenario: No link into sandy's tree
- **WHEN** `grep -rE '"(file|link|workspace):' --include=package.json` runs outside `node_modules`
- **THEN** it finds matches only in the workspace root `package.json`, and none point outside the repository

### Requirement: Public SDK from npmjs
The plugin repository SHALL import the Plugin SDK as `@sandy-sdk/plugin-sdk`, a public npmjs package that sandy publishes with npm Trusted Publishing. The plugin repository SHALL need no registry token or registry `.npmrc`. Until the first publish, it SHALL use the same package packed locally from a pinned sandy release. Nothing SHALL be published without the owner's explicit OK.

#### Scenario: Bridge before the first publish
- **GIVEN** no registry has the SDK
- **WHEN** `scripts/sdk.sh <sandy-tag> --local` runs and the workspace is installed
- **THEN** the units' tests and builds use the SDK packed from that sandy tag, and no unit's `package.json` changes

#### Scenario: Anonymous install
- **WHEN** the plugin repository's CI or a fresh clone without any npm login runs `pnpm install --frozen-lockfile`
- **THEN** the SDK installs from registry.npmjs.org without a token

#### Scenario: Git installs need no token
- **GIVEN** a host without any npm login
- **WHEN** a unit is installed from a git source
- **THEN** the install succeeds, because the SDK is an optional peer that sandy's install does not fetch

### Requirement: boat only for the owner's own content
The plugin repository's workflows SHALL run on GitHub-hosted runners, except that a job SHALL run on a boat label when the owner `nesyeklaf` pushed or started it from the repository itself. No workflow SHALL use `pull_request_target`.

#### Scenario: Owner's pull request
- **WHEN** the owner opens a pull request from a branch of the repository that changes one unit
- **THEN** its `unit` job runs on `boat`

#### Scenario: Pull request from a fork
- **WHEN** anyone, including the owner, opens a pull request from a fork
- **THEN** every job runs on a GitHub-hosted runner

### Requirement: Recorded compatibility with sandy releases
Each unit SHALL declare `engines.sandy` and `engines.sandyPluginSdk`, and every unit release SHALL record in `compat.json` the sandy tag and SDK version it was tested against.

#### Scenario: Release records its test target
- **WHEN** `scripts/release.mjs genui` creates `genui-v0.3.2`
- **THEN** `compat.json` holds an entry for genui 0.3.2 with the sandy tag and SDK version whose tests, git install simulation and `sandy plugin build` passed

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
The plugin repository SHALL run, for each changed unit, the workspace install, tests, the git install simulation and `sandy plugin build`. It SHALL run all units when shared scripts, `packages/`, the root manifest, the lockfile or `compat.json` change.

#### Scenario: One unit changed
- **WHEN** a pull request changes only `sandy/thread-namer/`
- **THEN** CI runs thread-namer only and reports its results

### Requirement: Install and update from the plugin repository
After migration, no installed sandy plugin or pi extension on the owner's hosts SHALL load code from a sandy checkout. This includes the disabled installs whose sources point at `/home/aemon/...`.
- Sandy plugins SHALL first be installed from a checkout of the plugin repository (phase 1), then from `git:<repo>@<range> --subdirectory sandy/<unit> --tag-prefix <unit>-v` (phase 2).
- pi SHALL load the pi extensions through pi-setup from the same repository.

#### Scenario: Phase 1 move keeps configuration
- **GIVEN** a plugin is installed from `path:~/projects/private/gh/sandy/extensions/sandy/<unit>` with settings
- **WHEN** `sandy plugin install path:<plugin checkout>/sandy/<unit>` runs
- **THEN** `sandy plugin source <id>` shows the new path, the plugin keeps its enabled state, and its settings, secrets and schedules are unchanged

#### Scenario: Disabled aemon install re-pointed
- **GIVEN** bookmarks is disabled and installed from `path:/home/aemon/projects/sandy/extensions/sandy/bookmarks`
- **WHEN** it is re-pointed to the plugin repository
- **THEN** `sandy plugin list --json` shows its source in the plugin repository, and it is still disabled

#### Scenario: Phase 2 update
- **GIVEN** a unit is installed from a git source with a semver range and a tag prefix
- **WHEN** a newer compatible `<unit>-v*` tag is pushed
- **THEN** `sandy plugin outdated` lists it, and `sandy plugin update <id>` installs it

#### Scenario: pi follows pi-setup
- **WHEN** pi-setup's `links.tsv` and `settings/base.json` point at the plugin checkout and `node apply.mjs <host>` has run
- **THEN** a new pi session registers the same tools as before the switch, and no path under `~/.pi/agent` resolves into a sandy checkout

### Requirement: Migration keeps installed plugins working
The migration SHALL proceed in the order given in design.md, with `extensions/` removed from sandy last. After every step, each enabled plugin SHALL be `running`. Each step SHALL have a rollback that restores the previous source without losing plugin state.

#### Scenario: Roll back one plugin
- **GIVEN** a plugin moved to the plugin repository fails to start
- **WHEN** its previous source is restored with a path move or `--replace-source`
- **THEN** the plugin runs from the previous source with its settings intact

#### Scenario: Removal waits for every source
- **GIVEN** any installed plugin source or pi path still points into `extensions/` of a sandy checkout
- **WHEN** the sandy removal change is prepared
- **THEN** it is not merged

### Requirement: History preserved
The plugin repository SHALL contain the full commit history of `extensions/` and `packages/skill-dialect` from sandy, and sandy references `#N` SHALL point to `nesyeklaf/sandy#N`, where those issues and pull requests stay.

#### Scenario: History is complete
- **WHEN** the filtered history is built
- **THEN** its commit count equals `git log --oneline -- extensions packages/skill-dialect | wc -l` in sandy at the import point, and its tree at that commit equals sandy's trees for those paths

### Requirement: Holons move with their code
The holons of genui, holon and field-latency SHALL move with their code into the plugin repository's own Holon root, and their exported OpenSpec specs SHALL move with them. Sandy SHALL keep `holons`, `sandy` and its other holons and SHALL drop `extensions/sandy/` from `sandy.holon`.

#### Scenario: Both models check
- **WHEN** the holon move is complete
- **THEN** `holon check` passes in the plugin repository and in sandy, and no `partOf` points to a holon in the other repository

### Requirement: Sandy keeps the plugin platform
Sandy SHALL keep the Plugin SDK, `@sandy/plugin-build`, the plugin registry, the Plugin Guide (`plugins/plugin-api-docs`), `docs/forkable-plugins.md`, the SDK publish job and the install and update machinery. The plugin repository SHALL link to the Plugin Guide instead of documenting the plugin API.

#### Scenario: No plugin API documentation copied
- **WHEN** the plugin repository's README and AGENTS.md are written
- **THEN** they link to the Plugin Guide for API questions and contain only build, test, release and install rules
