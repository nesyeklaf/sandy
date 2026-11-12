# Design: extract-plugins-repo

## Observed state (2026-11-12, sandy main 8c7401246, sandy 0.49.0, SDK 0.6.106)

| Fact | Evidence |
| --- | --- |
| 19 sandy plugins, 5 pi extensions, 4 scripts under `extensions/` | `ls extensions/sandy extensions/pi extensions/scripts`, `extensions/README.md` |
| All 19 sandy plugins link `@sandy-sdk/plugin-sdk` as `file:../../../packages/plugin-sdk`, always as a devDependency | each `extensions/sandy/*/package.json` |
| `sandy-sidebar-delegate` also links `sandy-app` (devDependency, used by `scripts/e2e/server.mjs`, which already takes the app directory as an argument) | its `package.json` line 79 |
| `skill-usecases` depends at runtime on `@sandy/skill-dialect` (`file:`); `work` uses it as a devDependency. Nothing else in sandy uses `packages/skill-dialect` | `grep -rl skill-dialect` |
| `pi/work/delegate/gate.ts` imports `../../../sandy/work/delegate/shared/policy.ts`, so pi and sandy units share source | grep for relative imports |
| `@sandy-sdk/plugin-sdk` is **not** on npm (404). The `publish-plugin-sdk` job exists but waits on a manual first publish | `npm view`, `.github/workflows/publish-sandy-app.yml` BOOTSTRAP note, `docs/sandy-release-process.md#publishing-the-plugin-sdk` |
| A git install runs `npm install --ignore-scripts --omit=dev --omit=optional` after deleting `.npmrc`, then builds the server, app and host bundles on the sandy host. It refuses ranges that do not fit `engines` | `apps/server/src/services/plugins/git-plugin-dependencies.ts`, `managed-plugin-artifacts.ts` |
| Git sources support `@<ref|semver-range>`, `--subdirectory` and `--tag-prefix`. `sandy plugin outdated|update|source` read them | `sandy guide plugins` |
| Switching an installed id from `path:` to `git:` is refused ("remove it first"). `sandy plugin remove` deletes settings, secrets and schedules. `install path:<new dir>` for the same id moves it and keeps its configuration | `plugin-registration.ts` `assertInstallRegistrationAvailable`, `sandy guide plugins` |
| Installed path sources: 13 enabled units from `~/projects/private/gh/sandy/extensions/sandy/*`. bookmarks, chief-of-staff, personas and receipts are disabled and point at `/home/aemon/projects/sandy/...`. fabric-render and tasks-fork are not installed | `sandy plugin list --json` |
| pi loads from a second checkout, `~/projects/sandy`: pi-setup `links.tsv` (`extensions/permissions`, `autopilots`, `extensions/lifecycle/index.ts` -> `sandy/pi-lifecycle/pi-extension.ts`) and `settings/base.json` packages `pi/context` and `pi/work`. pi/advisor and pi/fabric are not loaded | pi-setup |
| pi treats a git package as a whole repository identified by URL without the ref, with no subdirectory option, and pins tags | pi `docs/packages.md` |
| `extensions/` arrived in sandy on 2026-10-31 as a "files only" move from `nesyeklaf/plugins` (0ca6e2122), and has 139 commits since | `git log -- extensions` |
| `nesyeklaf/plugins` is private and **archived** (last push 2026-11-01, last commit 2026-10-31). It holds `bb/*` and `pi/*`, including units since dropped (`bb/ideas`, `bb/workflows-plus`) and the forks' kept history | `gh api repos/nesyeklaf/plugins` |
| `nesyeklaf/sandy` is public | `gh api` |
| 19 sandy units carry a `package-lock.json`; `sandy/holon` is already a standalone pnpm project with its own `pnpm-workspace.yaml` | `ls extensions/sandy/*/package-lock.json` |
| Holon tree: `field-latency` is `partOf: sandy`; `holon-genui` (with card, markdown, view-reader) and `holon-extension` (with cli, engine) are `partOf: holons` (`docs/designs/holons/holons.holon`, stays in sandy). Exported specs that belong to them: `openspec/specs/holon-{cli,engine,extension,genui,genui-card,genui-markdown,genui-view-reader}`; `openspec/specs/holons` stays | `.holon` files |
| GitHub Packages' npm registry only accepts a scope equal to the owning account [G1]. The only `@sandy-sdk/*` package is `@sandy-sdk/plugin-sdk` 0.6.106, in 1549 tracked files. An organization named `sandy-sdk` makes that scope valid with no rename | `git grep -l -F @sandy-sdk/plugin-sdk`; orchestrator check: GitHub name `sandy-sdk` free |
| `nesyeklaf/sandy` is a fork whose parent is not visible: `fork: true`, 0 forks, 0 stars, about 202 MB (`size` 207195 KB), 6 open pull requests, 30 open issues, 6 releases, no Pages, no wiki, one active ruleset "Protecc", one environment `npm-release` | `gh api repos/nesyeklaf/sandy`, `/rulesets`, `/environments`, `gh pr list`, `gh issue list`, 2026-11-12 |
| Workflows guard on the repository name: `if: github.repository == 'nesyeklaf/sandy'` in `ci-cache-maintenance.yml:20`, `ci-health.yml:14`, `ci.yml:583`, `close-stale-prs.yml:18`, `mobile-android-e2e.yml:27`, `mobile-e2e.yml:60`, `publish-sandy-app.yml:58, 384` | `git grep github.repository -- .github` |
| Desktop update feeds are published as `desktop-version*.json` and `latest-mac.yml` assets on the moving releases `desktop-latest` and `desktop-nightly` of `nesyeklaf/sandy` (`build-desktop.yml:383, 492-495`, `publish-sandy-app.yml:968, 1049-1051`). No tracked source in `apps/desktop/src` reads them, and `scripts/fork/check-egress-hosts.sh:11` forbids `nesyeklaf/sandy/releases` in code; whether an installed build reads them (electron-updater defaults) is unverified | source |
| `pr-gate.yml:3` runs on `pull_request_target` (on `ubuntu-latest`) | `git grep pull_request_target -- .github` |
| `components.json` of 9 plugins and `plugin-scaffold.ts:740` point their `@sandy` registry at `https://raw.githubusercontent.com/nesyeklaf/sandy/<tag>/packages/plugin-registry/r/{name}.json` | `git grep raw.githubusercontent` |
| npm rejects provenance from self-hosted runners (E422), so sandy's npm publish jobs stay on GitHub-hosted runners | `publish-sandy-app.yml:36-37` |
| `nesyeklaf/sandy` appears in 88 tracked files (22 under `extensions/sandy`), including runtime URLs: `CommunitySettingsSection.tsx:11`, `AppSidebar.tsx:77` (new issue), `SettingsView.tsx:117`, `apps/desktop/src/menu.ts:20`, and the plugin registry raw URL in `plugin-scaffold.ts:740` | `git grep -l nesyeklaf/sandy` |
| Sandy's workflows use `ubuntu-24.04`/`ubuntu-latest` (22 jobs), `blacksmith-4vcpu-ubuntu-2404`/`2204` (5), `windows-2025`/`windows-latest` (6), `blacksmith-4vcpu-windows-2025` (2), `blacksmith-6vcpu-macos-15`/`27` (3), and `macos-15` legs in the `package-smoke` and `node-compat-smoke` matrices | `.github/workflows/*.yml` |
| Holon: `sandy.holon` lists `extensions/sandy/` as code. 7 `.holon` files sit in genui, holon and field-latency. `openspec/specs/holon-*` are exported from them | `git ls-files '*.holon'` |
| Sandy files that name `extensions/`: `README.md`, `docs/configuration.md`, `docs/designs/skill-authoring-in-flow-editor.md`, `scripts/fork/package-manager-exceptions.tsv`, `scripts/fork/egress-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`, `AGENTS.md` (sidebar-spaces exception), and the open changes `sidebar-spaces` and `space-coordination` | grep |
| The owner's map (`/home/feysen/projects/work/code/FEysen/master-repo/docs/maps/private.md`) describes today's state: plugins and Sandy-specific pi extensions are developed in `gh/sandy`, and `gh/plugins` holds the earlier copies. Its rows for `gh/sandy`, `gh/plugins`, `gh/pi-extensions` and `gh/plugins-wt` change with this migration | lines 13, 19, 20, 86 |

## Decision 1: repository (owner decided)

A new **public** repository **`sandy-sdk/sandy-plugins`**, checkout `~/projects/private/gh/sandy-plugins`, worktrees in `~/projects/private/gh/sandy-plugins-wt`. The owner first chose private, then public (2026-11-12, same day), together with a public `sandy-sdk/sandy` (Decision 9). The archived `nesyeklaf/plugins` stays as it is. Its pre-move history (the forks' kept history, the bb era) stays readable there. The new repository's README links to it from a "History before 2026-10-31" note. Grafting that history into the new repository is possible later without touching the old repository; this change does not do it.

Public visibility means:
- Git sources and pi git packages install over HTTPS without a key on any host. No deploy key is needed (task 2.4 checks it).
- Outside pull requests are possible. The repository sets "Require approval for all outside collaborators" for workflow runs, and its workflows never use `pull_request_target` (Decision 11).
- Nothing secret goes into the tree. The owner's personal settings stay in pi-setup and in sandy's database, not in units.

## Decision 2: repository shape

| | A. Monorepo of plugins (recommended) | B. One repository per plugin |
| --- | --- | --- |
| Install source | `git:git@github.com:sandy-sdk/sandy-plugins@^0.3 --subdirectory sandy/genui --tag-prefix genui-v` | `git:git@github.com:sandy-sdk/sandy-plugin-genui@^0.3` |
| Versioning | per-unit semver, per-unit tags `<unit>-v<x.y.z>`; pi train `pi-v<x.y.z>` | one semver and plain `v<x.y.z>` tags per repo |
| pnpm | one workspace, one lockfile, one SDK pin | 25 lockfiles and SDK pins |
| Shared code | `pi/work` imports `sandy/work/delegate/shared` unchanged; `packages/skill-dialect` is one internal package | shared code must be published or copied |
| Paired units (`work`+`pi/work`, `permissions`+`pi/permissions`, `pi-lifecycle`) | one commit and one PR changes both sides | coordinated releases across repos |
| pi delivery | one pi package at the root (`pi` manifest), one git source | five pi packages or local paths |
| CI and access | one workflow, matrix over changed units | 25 workflows and 25 sets of repository settings |
| Blast radius | a bad merge can touch many units; per-unit tags still pin installs | isolated by repository |
| Upstream forks (genui, BB forks) | `UPSTREAM.md` per unit, as today | a fork per repository is easier to sync with upstream |

The reason for A is that the units are already coupled: shared source, paired protocols, one pi entry point. With the pnpm rule, B multiplies lockfiles, SDK pins and repository settings by 25. Cheapest check that would disprove A: install one unit from a test tag with `--subdirectory` and `--tag-prefix` (task 2.1). If sandy cannot resolve a prefixed tag in a subdirectory, B wins.

## Target layout (option A)

```
sandy-plugins/                repository root (today's extensions/)
  sandy/<unit>/               19 sandy plugins, paths unchanged
  pi/<unit>/                  5 pi extensions, paths unchanged
  packages/skill-dialect/     moved from sandy; only these units use it
  scripts/                    build.sh, install-pi.sh, install-sandy.sh, lib.sh, sdk.sh, release.mjs,
                              compat.mjs, check-git-install.mjs
  package.json                private root: devDependencies (SDK, shared test tools), "pi" manifest = the pi
                              package (pi/context, pi/work, pi/permissions, sandy/pi-lifecycle/pi-extension.ts,
                              autopilots), version = pi train, packageManager = pnpm@<pinned>
  pnpm-workspace.yaml         packages: sandy/*, pi/*, pi/work/goal, packages/*; excludes pi/work/evals/**
  pnpm-lock.yaml              the only lockfile
  compat.json                 sandy and SDK versions each unit release was tested against
  sandy-plugins.holon         Holon root context of this repository
  openspec/                   config.yaml and the specs exported from the moved holons
  .github/workflows/          ci.yml, release.yml
  AGENTS.md, README.md        working rules from extensions/README.md, plus the pnpm and release rules
```

## Decision 3: pnpm, dependencies and the SDK

**pnpm (owner rule).**
- One pnpm workspace at the repository root and one `pnpm-lock.yaml`. Every `package-lock.json` is deleted, and `sandy/holon`'s nested `pnpm-workspace.yaml` is folded into the root.
- CI and local work use `pnpm install --frozen-lockfile`, and `scripts/build.sh` calls pnpm.
- Units keep their own versions of their toolchains. pnpm isolates each package's `node_modules`, so different React or Vitest majors can coexist.

**The constraint the pnpm rule meets.** Sandy's git install does not use pnpm. In the unit's subdirectory of a full checkout, it deletes `.npmrc` and runs `npm install --ignore-scripts --omit=dev --omit=optional`. That means:
- the pnpm lockfile does not apply to git installs;
- `workspace:` and other non-npm protocols fail there;
- every dependency npm has to resolve must come from the public npm registry.
So:
- A unit's `dependencies` and `devDependencies` are public-registry ranges only. Nothing private, no `workspace:`, no `file:` or `link:`.
- The SDK, `sandy-app` and internal packages are not unit dependencies. Each unit declares the SDK as an optional peer (`peerDependencies` plus `peerDependenciesMeta.optional`). npm neither fetches nor fails on an optional peer.
- In development, pnpm resolves the peer from the root `devDependencies` (`resolve-peers-from-workspace-root`, pnpm's default).
- `skill-dialect` is imported by relative source path (`../../packages/skill-dialect/src/...`) and bundled by sandy's host build. Its runtime dependencies (e.g. `@markdoc/markdoc`) are listed in the consuming unit's `dependencies`. Task 2.2 verifies this.
- `scripts/check-git-install.mjs <unit>` repeats what sandy does in a clean clone: delete `.npmrc`, run the same `npm install`, then `sandy plugin build`. It runs in CI for every changed unit.
- Making sandy's git install honor `pnpm-lock.yaml` is out of scope. If floating runtime ranges cause trouble, that is a separate core change.

**The SDK: `@sandy-sdk/plugin-sdk` on GitHub Packages (owner decided); public or private is the owner's open choice.**
- The name stays `@sandy-sdk/plugin-sdk`: the organization is named `sandy-sdk`, so the scope already matches the owner (G1) and nothing is renamed (Decision 10).
- `sandy-sdk` owns sandy, the plugin repository and the package (Decision 9).
- Sandy publishes it in both variants. The plugin repository only installs it.
- A sandy git install never needs the SDK (optional peer, above), so installed plugins never need a token.

Facts from GitHub's docs (read 2026-11-12):
- [G1] GitHub Packages "only supports scoped npm packages", scoped to "the user or organization account to which the package will be scoped". Authentication outside Actions uses only classic tokens ("GitHub Packages only supports authentication using a personal access token (classic)"). "You need an access token to publish, install, and delete private, internal, and public packages." Source: [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
- [G2] In Actions, `GITHUB_TOKEN` publishes "packages associated with the workflow repository". It installs packages of other private repositories "if the repository is granted read access to the package"; otherwise a classic PAT with `read:packages` is needed. "In most registries, to pull a package, you must authenticate ... regardless of whether the package is public or private"; only the Container registry allows anonymous pulls. Sources: G1 and [About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).
- [G3] "If a workflow creates a package using the `GITHUB_TOKEN`, ... the package inherits the visibility and permissions model of the repository where the workflow is run." Uploading a new version needs write permission on the package. "If you grant a public repository access to private packages, forks of the repository may be able to access the private packages." Source: [Publishing and installing a package with GitHub Actions](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions).
- [G4] "Once you make a package public, you cannot make it private again." A linked package inherits the repository's access permissions (not its visibility), and workflows in the linked repository get access automatically. A package published outside Actions starts private for organization packages unless members may create public ones. Further repositories are added under "Manage Actions access". Source: [Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
- [G5] "GitHub Packages usage is free for public packages." Private packages on GitHub Free for organizations get 500 MB storage, shared with Actions artifacts, and 1 GB transfer a month. Downloads by Actions with `GITHUB_TOKEN` are free. Source: [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).

The two variants. The owner chooses; this change does not decide.

| | S1. Public package | S2. Private package |
| --- | --- | --- |
| Created by | sandy's `publish-plugin-sdk` job, retargeted to `npm.pkg.github.com`, with `GITHUB_TOKEN` and `packages: write`. A public repository creates a public package (G3) | the owner, by one manual `pnpm publish` with a classic PAT (`write:packages`) from a checkout at a sandy tag, so it starts private (G4). Then, under "Manage Actions access": `sandy-sdk/sandy` with Write, `sandy-sdk/sandy-plugins` with Read. After that, the same sandy job publishes new versions |
| Install in CI | `GITHUB_TOKEN` with `packages: read` in both repositories | `GITHUB_TOKEN` with `packages: read` after the grant |
| Install locally | a classic PAT with `read:packages` in `~/.npmrc`. A token is still needed: the npm registry has no anonymous pulls (G2) | the same PAT, and only org members can use it |
| Outside contributors to `sandy-plugins` | can install with their own PAT | cannot install the SDK, so they cannot build or test a unit locally; fork PR runs can only use `scripts/sdk.sh --local` |
| Cost | free (G5) | counts against 500 MB storage and 1 GB transfer (G5); PAT downloads count, Actions downloads do not |
| Protection | none needed: the source is public in `sandy-sdk/sandy` | protects little: the same source is public. GitHub warns that forks of a public repository granted access may reach the package (G3) |
| Catches | irreversible (G4); the first run must happen only after the owner's OK | the publish job must never run before the manual first publish, or `GITHUB_TOKEN` from the public sandy creates the package public, for good (G3, G4). The job therefore refuses to publish when `npm view` of the package returns 404 |

What changes in sandy (both variants), in the cutover change (Decision 12):
- `packages/plugin-sdk/package.json`: `publishConfig` to `{ "registry": "https://npm.pkg.github.com" }` (drop `access: public`), and `repository`/`homepage`/`bugs` to `sandy-sdk/sandy`.
- `publish-plugin-sdk` targets `npm.pkg.github.com` with `GITHUB_TOKEN`, stays on a GitHub-hosted runner, and keeps publish-if-missing. `check-npm-version-guard.mjs` is pointed at the GitHub registry or removed.
- `docs/sandy-release-process.md#publishing-the-plugin-sdk` describes the chosen variant instead of the npm bootstrap.

Plugin repository settings:
- The committed `.npmrc` holds only the scope mapping, `@sandy-sdk:registry=https://npm.pkg.github.com`, and no token. Sandy's git install deletes `.npmrc` and does not fetch the optional peer.
- `ci.yml` sets `permissions: { contents: read, packages: read }` and `actions/setup-node` with `registry-url: https://npm.pkg.github.com` and `scope: '@sandy-sdk'`, with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Whether a fork pull request's read-only `GITHUB_TOKEN` can read the package is checked at the first fork PR (unverified); if not, fork runs use the bridge.
- Locally, `~/.npmrc` holds `//npm.pkg.github.com/:_authToken=<classic PAT, read:packages>`. pnpm reads the project and user `.npmrc`; nothing pnpm-specific is needed.
- Bridge until the first publish, and for runs without registry access: `scripts/sdk.sh <sandy-tag> --local` packs the same package into `.sdk/`, and the root devDependency points at `file:.sdk/sandy-sdk-plugin-sdk.tgz`.
- Checks at the first publish: the package page shows the chosen visibility and the link to `sandy-sdk/sandy`; the plugin repository's CI installs it with `GITHUB_TOKEN` only.

Nothing is published without the owner's explicit OK.

**sandy-app** (sidebar-delegate e2e): drop the dependency. The e2e harness already takes `--app <dir>`; CI passes the `sandy-app` it built from the pinned sandy ref.

**Compatibility.**
- `engines.sandy` and `engines.sandyPluginSdk` stay the contract sandy enforces.
- `compat.json` records, per unit release, the sandy tag and SDK version the release was tested against.
- CI runs each changed unit against the sandy release the owner runs (blocking) and against sandy `main` (nightly, reports only).
- Raising an `engines` floor is a minor release of the unit.

**pi/fabric.** It builds and tests with bun today. The owner decided it moves fully to pnpm: its scripts run under pnpm and Node, its tests run on vitest like the other units, `bun.lock` and every `bun` call are removed, and the root `pnpm-lock.yaml` covers it. Any bun-only API it uses (`Bun.*`, `bun:test`) is replaced as part of that move (task 4.2 checks `git grep -n -E "\\bbun\\b|Bun\\." -- pi/fabric` is empty).

## Decision 4: versioning, release, CI

- Per-unit semver in the unit's `package.json`; sandy shows this version and `sandy plugin outdated` compares against it.
- Tags: `<unit>-v<x.y.z>` for sandy plugins (unit = directory name). The pi train is `pi-v<x.y.z>` from the root `package.json`, because pi pins one ref per git repository.
- Paired units release from the same commit: `work` with `pi/work`, `permissions` with `pi/permissions`, `pi-lifecycle` with the pi train.
- `scripts/release.mjs <unit>`:
  1. refuses a version already tagged and a dirty tree;
  2. runs the unit's tests serially;
  3. runs `check-git-install.mjs` and `sandy plugin build` against the pinned SDK;
  4. writes the `compat.json` entry;
  5. creates an annotated tag.
  The push and the GitHub release are separate steps that need the owner.
- CI on pull requests selects changed units (a change to `scripts/`, `packages/`, the root manifest, the lockfile or `compat.json` selects all). Per unit: `pnpm install --frozen-lockfile`, tests (`VITEST_MAX_WORKERS=1`), `check-git-install.mjs`, `sandy plugin build`. The Holon check runs on changed `.holon` files.

## Decision 5: install and update afterwards

- **Phase 1, path sources.**
  - The `sandy-plugins` checkout sits on the server host.
  - `sandy plugin install path:<checkout>/sandy/<unit>` moves each installed id and keeps its configuration. That includes the four disabled installs that point at `/home/aemon/...`; they stay disabled.
  - Updates work as today, from the new directory: `git pull`, `scripts/build.sh <unit>`, `sandy plugin reload <id>`.
- **Phase 2, git sources.**
  - `sandy plugin install git:git@github.com:sandy-sdk/sandy-plugins@^<major.minor> --subdirectory sandy/<unit> --tag-prefix <unit>-v --replace-source` switches each id while keeping its state (Decision 6).
  - From then on, `sandy plugin outdated`, `sandy plugin update` and Settings → Updates apply releases.
- **pi.**
  - pi-setup is the only writer of `~/.pi/agent`. Its `links.tsv` (`extensions/permissions`, `autopilots`, `extensions/lifecycle/index.ts`) and `settings/base.json` packages (`pi/context`, `pi/work`) switch to the `sandy-plugins` checkout, applied with `node apply.mjs <host>`.
  - Later, if task 2.3 shows pi installs the root package and its pnpm-managed dependencies, one `git:git@github.com:sandy-sdk/sandy-plugins@pi-v<x.y.z>` package replaces the local paths.
  - `scripts/install-pi.sh` stays only as a bootstrap for hosts without pi-setup.

## Decision 6: core `--replace-source`

Today:
- `assertInstallRegistrationAvailable` (`apps/server/src/services/plugins/plugin-registration.ts`) refuses an install for an id installed from another source, except a path-to-path move (`pathSourceMoveFrom`).
- `sandy plugin remove` deletes settings, secrets and schedules.

Behavior:
- `replaceSource: true` on an install request names an existing install. The new source's manifest id must equal the installed id; otherwise the request is refused and nothing changes.
- The new source is staged, validated (engines, artifact meta) and built before anything switches. If any step fails, the old source stays active and running.
- On success the row's source, version and artifact switch in one transaction. Settings, secrets, schedules, the plugin data directory and the enabled state are kept, and a source-history entry is recorded. The plugin restarts if it was enabled.
- Every source kind works in every direction (path → git, git → path, git → another git URL or range). That makes the switch its own rollback.
- Bundled and builtin ids (`builtin:`, `sandy--`) are refused.
- A local path source stays on disk. Replaced git versions are removed with the same rules as updates and `prune`.
- The existing path-to-path move becomes this code path with `replaceSource` implied, so there is one implementation (AGENTS.md, "CLI And Plugin API").

Surfaces (one implementation, one contract test table run against every surface):
- **Server contract:** `pluginInstallRequestSchema` and the `source` install job target (`packages/server-contract/src/api/plugins.ts`) gain `replaceSource`. The server boundary fills the default `false` once.
- **Server:** install route and install job (`apps/server/src/routes/plugins.ts`, `plugin-install-jobs.ts`), and the registration and artifact services.
- **SDK client:** `packages/sdk/src/areas/plugins.ts`.
- **CLI:** `sandy plugin install <source> --replace-source` (`apps/cli/src/commands/plugin.ts`). It asks for confirmation like install, `--yes` skips it, and a non-TTY refuses without `--yes`.
- **UI:** Settings → Installed plugins → Change source, which uses the same request.
- **Docs:**
  - `packages/templates/src/templates/sandy-guide-plugins.md`, where the text "Change a pinned git: source with sandy plugin remove ..." is replaced;
  - `docs/configuration.md` only if a setting is added (none planned);
  - the surfaces in `docs/cli-guide-and-skill.md`.
- **Not affected:** the server/daemon wire protocol (no `HOST_DAEMON_PROTOCOL_VERSION` bump) and the plugin API (no `docs/api_to_audit.md` entry).
- **Tests:** server service tests on a real migrated SQLite (`createMigratedConnection()`):
  - path → git keeps settings, secrets and schedules;
  - a failed build leaves the old source running;
  - an id mismatch is refused;
  - git → path rollback;
  - builtin refusal.
  The CLI and SDK surfaces run the same contract table.

## Decision 7: history preservation

- **`git filter-repo` (recommended).**
  1. Run in a fresh clone of `sandy-sdk/sandy` in a scratch directory, never in a working checkout: `git filter-repo --path extensions/ --path packages/skill-dialect/ --path-rename extensions/:`.
  2. A message callback rewrites `#N` to `nesyeklaf/sandy#N`, because the issues and pull requests stay on the old repository (Decision 9), which is kept.
  The result's root is the 2026-10-31 move commit. Checks:
  - the commit count equals `git log --oneline -- extensions packages/skill-dialect | wc -l` in sandy;
  - the HEAD tree equals sandy's trees for those paths;
  - `git log --follow` on a sample file reaches the move commit.
- **`git subtree split --prefix=extensions`.** Built into git, but it handles one prefix only (skill-dialect's history is lost), is slow on sandy's history, and leaves `#N` references pointing at the wrong repository. Rejected.

The pnpm conversion, the holon move and the decoupling land as normal commits on top of the filtered history, so the import commit stays a pure move.

## Decision 8: holons move with their code (owner decided)

- The plugin repository gets its own Holon root, `sandy-plugins.holon` (`kind: context`, `partOf: null`, `code: ["sandy/", "pi/", "packages/"]`), and a copy of the `nesyeklaf` carrier holon.
- `field-latency` changes from `partOf: sandy` to `partOf: sandy-plugins`.
- `holon-genui` and `holon-extension` are `partOf: holons`, which stays in sandy (`docs/designs/holons/holons.holon`). In the plugin repository they become `partOf: sandy-plugins`, and their link to the holon format is written as a seam, because a `partOf` cannot cross repositories (task 2.5 checks this with `holon check`).
- The seven exported specs `openspec/specs/holon-{cli,engine,extension,genui,genui-card,genui-markdown,genui-view-reader}` move to the plugin repository's `openspec/specs` and are re-exported there. Sandy keeps `openspec/specs/holons`.
- In sandy, `sandy.holon` drops `extensions/sandy/` from `code`, and the export is regenerated.
- Once the plugin repository has `.holon` files, the owner's global rule applies there: implementer build work waits for the holon-openspec READY gate. The standalone exception in sandy's AGENTS.md covers only this change in sandy.

## Migration order

Every step keeps the installed plugins running, and each step can be rolled back.

| Step | What | Check | Rollback |
| --- | --- | --- | --- |
| 0 | Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/` | open branches and PRs listed | none needed |
| 0a | Owner: merge or close the 6 open pull requests on `nesyeklaf/sandy`; then freeze its `main` | `gh pr list -R nesyeklaf/sandy --state open` is empty | none needed |
| 0b | Owner: create the organization `sandy-sdk` and an empty public `sandy-sdk/sandy` (not a fork); repository settings as in Decision 9 | the repository exists, `fork: false` | delete the empty repository |
| 0c | Owner (the agent can prepare the commands): push sandy's full history from a fresh bare clone, branch `main` and all tags | `git ls-remote` of both repositories shows the same `main` sha and the same tags | delete and re-create the new repository |
| 0d | Sandy cutover change on `sandy-sdk/sandy` (Decision 12): guards, runtime URLs, registry URL, package metadata, `runs-on` routing | the checks of Decision 12; `ci.yml` green; the next scheduled `ci-health` runs | revert; the old repository is unchanged |
| 0e | Owner: switch local remotes and the deploy host to `sandy-sdk/sandy`; after one soak cycle, disable Actions on `nesyeklaf/sandy`, add a "moved" note, archive it. Never delete it | `scripts/fork/deploy.sh` deploys from the new remote; no workflow runs on the old repository | unarchive |
| 1 | Core `--replace-source` in sandy (Decision 6), released and deployed with owner OK | contract tests green; staging: path → git → path keeps settings | revert; nothing uses it yet |
| 2 | Spikes 2.1–2.5 on the staging instance | spike verdicts | none |
| 3 | Scratch clone: filter-repo; then on top: pnpm workspace, decoupling, holon move, scripts, CI | Decision 7 checks; every unit's tests, `check-git-install.mjs`, `sandy plugin build` serially; `holon check` | delete the scratch clone |
| 4 | Owner OK: create the public repository, push, CI green, first tags at current versions | tags exist; CI green | delete the repository; sandy is untouched |
| 5 | Phase 1: switch SANDY path sources to the `sandy-plugins` checkout, low-risk units first (thread-namer, value, field-latency, compact-composer, codex-voice, files-editor), then genui, holon, skill-usecases, sandy-sidebar-delegate, pi-lifecycle, then permissions and work with step 6; then the four disabled `/home/aemon/...` installs | `sandy plugin source <id>` shows the new path; plugin `running` (or still disabled); settings present | `sandy plugin install path:~/projects/private/gh/sandy/extensions/sandy/<unit>` (move back, keeps settings) |
| 6 | pi-setup switches `links.tsv` and `settings/base.json` to the checkout; `node apply.mjs <host>` | the pi tool inventory matches the pre-switch list | revert the pi-setup commit, apply again |
| 7 | Phase 2: `--replace-source` to git sources, same order as step 5 | `sandy plugin source <id>` shows git + resolved tag; `sandy plugin outdated` sees a test tag | `--replace-source path:<checkout>/sandy/<unit>` |
| 8 | Soak: one sandy deploy and one plugin release cycle on the new sources | no source or pi path points into a sandy checkout | steps 5–7 rollback |
| 9 | Separate sandy change: remove `extensions/` and `packages/skill-dialect`; update README, docs, `scripts/fork/*-exceptions.tsv`, `scripts/perf/render-attribution/run.sh` (takes a plugin checkout path), `scripts/migrate-from-bb.mjs` references, `sandy.holon`, the moved `openspec/specs/holon-*`, the AGENTS.md exception | sandy CI green; `grep -rn "extensions/sandy\|extensions/pi"` only in history | revert the removal commit; sources already point at `sandy-plugins` |
| 10 | Owner updates his map | owner | n/a |

## Owner's map

`master-repo/docs/maps/private.md` is the owner's file and is not edited here. After step 6, these rows need the owner's edit:

| Line | Today | After the migration |
| --- | --- | --- |
| 13 `gh/pi-extensions` | "Sandy-specific Pi extensions are developed in `gh/sandy`." | "... are developed in `gh/sandy-plugins` (`pi/`)." |
| 19 `gh/sandy` | "... plus its plugins and Sandy-specific Pi extensions; managed and developed together here." Note: second checkout in `~/projects/sandy` | "Sandy, the agentic IDE, its Plugin SDK, Plugin Guide and builtin plugins." The second-checkout note goes once pi-setup no longer reads `~/projects/sandy` |
| 20 `gh/plugins` | "Separate checkout containing earlier BB/Sandy plugins ... New Sandy-specific work belongs in `gh/sandy`." | "Archived. Earlier BB/Sandy plugins and pi extensions, history before 2026-10-31. New plugin work belongs in `gh/sandy-plugins`." |
| new row `gh/sandy-plugins` | — | "`sandy-sdk/sandy-plugins` (public): the owner's sandy plugins (`sandy/`) and Sandy-specific pi extensions (`pi/`), pnpm workspace, released per unit (`<unit>-v*`, `pi-v*`). Conventions: AGENTS.md. SANDY and pi load from it; worktrees under `gh/sandy-plugins-wt/`." |
| 86 `gh/plugins-wt` | worktrees of `gh/plugins` | unchanged; add `gh/sandy-plugins-wt` |

## Risks

- **Two checkouts drift.** SANDY reads `~/projects/private/gh/sandy` and pi reads `~/projects/sandy` today. The migration points both at one `sandy-plugins` checkout per host.
- **Floating runtime ranges.** A git install ignores `pnpm-lock.yaml`, so a dependency release can change what a git install builds. Mitigation: `check-git-install.mjs` in CI and before each release, exact versions for runtime dependencies, and few runtime dependencies.
- **A job on boat for someone else's code** if the routing expression is wrong (Decision 11). Mitigation: boat's own allow-list and `check-runs-on.mjs`.
- **Old URLs** in installed versions (Decision 12). Mitigation: `nesyeklaf/sandy` is kept and archived, never deleted.
- **Holon `partOf` across repositories** (task 2.5).
- **History rewrite mistakes.** The work runs in a scratch clone; the trees are compared before anything is pushed.

## Decision 9: organization `sandy-sdk` with two new public repositories (owner decided)

The organization `sandy-sdk` owns two new public repositories and the package:
- `sandy-sdk/sandy`, which gets sandy's full history pushed into it. It is a fresh repository, not a fork. There is no transfer and no fork detach, so nothing on `nesyeklaf/sandy` changes until step 0e.
- `sandy-sdk/sandy-plugins` (Decision 1).
- `@sandy-sdk/plugin-sdk` (Decision 3).

One owner keeps the same-owner `GITHUB_TOKEN` rule (G2, G4). `pi-setup` and `forge-skills` stay under `nesyeklaf`, and so does the archived `nesyeklaf/plugins`.

Why a new repository instead of a transfer: `nesyeklaf/sandy` is a fork whose parent is gone. A transfer keeps the fork flag, and GitHub can only drop it through Support or "Leave fork network". Leaving drops issues and pull requests, and leaving is permanent. A fresh push gives a non-fork repository and leaves the old one intact.

What does not move, by the owner's decision:
- Issues and pull requests. The 30 open issues stay on `nesyeklaf/sandy`, readable after archiving. The 6 open pull requests are merged or closed there first (step 0a). Moving single issues is not possible anyway: GitHub transfers issues only between repositories of the same owner.
- Releases. The 6 releases and the moving `desktop-latest`/`desktop-nightly` releases stay. The first desktop build on the new repository creates them there.
- Stars, watchers and the old pull-request refs (`refs/pull/*` are hidden refs, so they are not pushed).

Push, from a scratch directory, never a working checkout:
1. `git clone --bare git@github.com:nesyeklaf/sandy.git sandy.git`
2. `git -C sandy.git push git@github.com:sandy-sdk/sandy.git refs/heads/main:refs/heads/main 'refs/tags/*:refs/tags/*'`. Other branches stay on the old repository.
3. Check: the same `main` sha and tag list on both repositories. The tags matter because the plugin registry URL contains a sandy tag (Decision 12).

Repository settings the owner sets again, since a push does not carry them:
- environment `npm-release` with its protection rules, and the Actions secrets and variables. The read without admin rights listed none, so the owner reads them in the old repository's settings;
- the ruleset "Protecc" (rulesets are available on public repositories in the Free plan);
- "Require approval for all outside collaborators" for workflow runs from forks;
- apps: boat (Decision 11), CodeRabbit, SlopCop, Blacksmith if kept (open question), Expo/EAS if it is connected;
- npm trusted publisher for `sandy-app`, re-pointed to `sandy-sdk/sandy`.

## Decision 10: the SDK keeps its name (owner decided)

The owner named the organization `sandy-sdk`, so `@sandy-sdk/plugin-sdk` is already a valid GitHub Packages name (G1), and nothing is renamed: no import, `package.json`, template, CLI message or bundled type changes, and installed plugins are unaffected. `sandy-app` and the private `@sandy/*` workspace packages keep their names too. Only the registry changes (Decision 3). The `engines.sandyPluginSdk` floor and `check-plugin-sdk-version.mjs` stay as they are.

## Decision 11: CI on boat.dev

Facts from [docs.boat.dev/ci](https://docs.boat.dev/ci) (read 2026-11-12):
- [B1] Install the GitHub App with `boat ci connect`. An organization that cannot grant "Administration: write" can install "Boat CI for orgs" instead (organization permission "Self-hosted runners: write", one runner group per repository).
- [B2] Labels:
  - `boat-small`: 2 vCPU, 4 GB;
  - `boat`: 4 vCPU, 8 GB;
  - `boat-large`: 8 vCPU, 16 GB;
  - `boat-xlarge`: 16 vCPU, 32 GB, $100 plan.
  Options follow after `/` (`from=<snapshot>`, `debug`). The jobs are full Linux x86-64 VMs with Docker and `/dev/kvm`, a fresh sandbox per job, at most 6 hours.
- [B3] CI needs the $20/month plan; the trial refuses jobs. Starts on the $20 plan: 12/min, 60/h, 200/day. Above that a job waits or uses paid extra starts.
- [B4] Actions secrets and `GITHUB_TOKEN` work as on GitHub-hosted runners. Boat adds none of its own environment.
- [B5] "Jobs from public repositories do not run on boat by default." The switch is per account (`boat ci public <account> on --users ...`). A run uses boat only when its author and the user who started it are both on the list; a pull request from anyone else is refused. `--anyone` allows everyone, which is safe only together with GitHub's "Require approval for all outside collaborators".
- [B6] No Windows or macOS runners; Wine is the suggested way to run Windows console programs.

**Rule (owner decided):** GitHub-hosted runners by default, in both repositories. A job runs on boat only for the owner's own content: the owner pushed or started it, and it comes from the repository itself, never from a fork and never through `pull_request_target`. Everything else, including every outside pull request, runs on GitHub-hosted runners. Both repositories are public, so standard GitHub-hosted runners cost nothing (Actions billing: "free for public repositories").

Two locks, both required:
1. **Routing in the workflow.** Every job that may use boat sets
   ```yaml
   runs-on: ${{ (github.repository_owner == 'sandy-sdk'
                 && github.actor == 'nesyeklaf'
                 && github.triggering_actor == 'nesyeklaf'
                 && contains(fromJSON('["push","workflow_dispatch","schedule","pull_request"]'), github.event_name)
                 && (github.event_name != 'pull_request'
                     || (github.event.pull_request.head.repo.full_name == github.repository
                         && github.event.pull_request.user.login == 'nesyeklaf')))
               && 'boat' || 'ubuntu-24.04' }}
   ```
   with the label sized per job (`boat-small`/`boat`/`boat-large`, and the matching GitHub-hosted fallback).
   - `triggering_actor` covers re-runs: a re-run by someone else goes to GitHub.
   - Dependabot, `github-actions[bot]` and outside authors fall through to GitHub.
   - A scheduled run's actor is whoever last changed the cron line, so it goes to boat only when that was the owner.
2. **boat's allow-list (B5).** The owner runs `boat ci public sandy-sdk on --users nesyeklaf`, never `--anyone`. If the routing is wrong, boat refuses the job instead of running foreign code. A refused job stays queued until GitHub cancels it after 24 hours, which makes the mistake visible.

Enforced by `scripts/check-runs-on.mjs` in both repositories, run in CI on GitHub-hosted runners:
- every `runs-on` is a plain GitHub-hosted label or exactly the routing expression with a known size;
- no workflow has the trigger `pull_request_target` together with a boat label;
- `pr-gate.yml` (`pull_request_target`) stays on `ubuntu-latest`, and no other workflow gains `pull_request_target`.

Plugin repository `sandy-sdk/sandy-plugins`:

| Job | Owner's content | Otherwise |
| --- | --- | --- |
| `plan` (select changed units), `holon`, `release`, `check-runs-on` | `boat-small` (`check-runs-on` always GitHub) | `ubuntu-24.04` |
| `unit` matrix: install, tests (`VITEST_MAX_WORKERS=1`), `check-git-install.mjs`, `sandy plugin build`; `strategy.max-parallel: 12` keeps a full matrix within boat's per-minute starts (B3) | `boat` | `ubuntu-24.04` |
| `compat-nightly` against sandy `main` | `boat-large` | `ubuntu-24.04` |

Sandy `sandy-sdk/sandy`. This change does not edit sandy's workflows; the cutover change (Decision 12) does.

| Jobs | Today | Owner's content | Otherwise |
| --- | --- | --- | --- |
| `ci.yml` fork-egress, plan, dependencies, static-checks, checks, plugin-forks, provider-model-listing; `version-lockstep`; `ci-health`; `ci-cache-maintenance`; `close-stale-prs` | `ubuntu-24.04`, `ubuntu-latest` | `boat-small` or `boat` | as today |
| `ci.yml` tests, `perf-regression` | `ubuntu-24.04`, `blacksmith-4vcpu-ubuntu-2404` | `boat-large`; perf needs a baseline per runner type | `ubuntu-24.04` |
| `package-smoke`, `node-compat-smoke` Ubuntu legs | matrix `ubuntu-24.04` | `boat` | as today |
| `mobile-android-e2e`, `mobile-android-eas`, `mobile-ios-eas` | `ubuntu-latest` | `boat` (emulator with `/dev/kvm`, B2) | as today |
| `build-desktop` linux, `nightly-desktop-linux` | `blacksmith-4vcpu-ubuntu-2204` | `boat` with `container: ubuntu:22.04` for the glibc floor | `ubuntu-22.04` |
| `build-desktop` publish, `nightly-desktop-publish` | `blacksmith-4vcpu-ubuntu-2404` | `boat-small` | `ubuntu-24.04` |
| `publish`, `publish-nightly` (npmjs `sandy-app`), `publish-plugin-sdk` | `ubuntu-latest` | GitHub-hosted only: npm rejects provenance from self-hosted runners (`publish-sandy-app.yml:36`) | `ubuntu-latest` |
| `pr-gate` (`pull_request_target`), `approve-contributor` | `ubuntu-latest` | GitHub-hosted only | `ubuntu-latest` |
| Windows: 5 jobs in `ci.yml`, `fork-build-windows`, `build-desktop` windows, `nightly-desktop-windows` | `windows-2025`, `windows-latest`, `blacksmith-4vcpu-windows-2025` | GitHub-hosted (B6; owner decided) | `windows-2025` |
| macOS: `build-desktop` macos, `nightly-desktop-macos`, `mobile-e2e` (iOS), `macos-15` matrix legs | `blacksmith-6vcpu-macos-15/27`, `macos-15` | GitHub-hosted (B6; owner decided) | `macos-15`, or the nearest GitHub-hosted image for the `macos-27` job, checked at the change |

Blacksmith jobs move to GitHub-hosted labels under the owner's rule, unless the owner installs Blacksmith on `sandy-sdk` and keeps it (open question). Larger runners would be billed even on public repositories; the table uses only standard labels.

## Decision 12: cutover from `nesyeklaf/sandy` to `sandy-sdk/sandy` (owner decided)

`nesyeklaf/sandy` is kept, later archived, and never deleted. Installed versions call it:

| URL in installed versions | Where | Keeps working because |
| --- | --- | --- |
| `raw.githubusercontent.com/nesyeklaf/sandy/<tag>/packages/plugin-registry/r/{name}.json` | `components.json` of scaffolded plugins and 9 units, `plugin-scaffold.ts:740` | the old repository and its tags stay; an archived repository still serves raw files |
| `github.com/nesyeklaf/sandy/releases/download/desktop-latest/…`, `…/desktop-nightly/…` | desktop update feeds (`build-desktop.yml:492-495`, `publish-sandy-app.yml:1049-1051`) | the releases stay; the last feed before the cutover keeps being served. Installed builds that read it see no newer version after the cutover (no reader in tracked source; unverified for installed builds), so the owner installs one build from the new repository by hand |
| `github.com/nesyeklaf/sandy`, `…/blob/main/…`, `…/issues/new` | Settings → Community, `SettingsView.tsx:117`, the bug-report link, desktop LICENSE menu | the pages stay readable. New issues fail once the repository is archived; the "moved" note points to the new one |

The cutover change, landed on `sandy-sdk/sandy` as its first commit after the push (step 0d):
- the 8 `github.repository == 'nesyeklaf/sandy'` guards to `sandy-sdk/sandy`, so scheduled jobs and `ci.yml:583` run on the new repository and never again on the old one;
- runtime URLs (`CommunitySettingsSection.tsx:11`, `AppSidebar.tsx:77`, `SettingsView.tsx:117`, `apps/desktop/src/menu.ts:20`), `plugin-scaffold.ts:740, 1420`, `build-bundled-dts.mjs:146`, and `repository`/`homepage`/`bugs` in `packages/plugin-sdk` and `packages/sandy-app`. npm's provenance check needs `repository.url` to match the building repository (npm docs, not re-read today);
- the feed URLs printed in job summaries, and docs; `check-egress-hosts.sh:11` forbids both `nesyeklaf/sandy/releases` and `sandy-sdk/sandy/releases`;
- the `runs-on` routing and `check-runs-on.mjs` (Decision 11), and Blacksmith labels replaced;
- the SDK publish target (Decision 3);
- the `components.json` of units still in `extensions/sandy`; the moved copies change in the plugin repository.

Left unchanged: history, archived OpenSpec and holon records, `scripts/rename-sandy.mjs` (a one-time migration), fixtures, stories, and `nesyeklaf` as a person (holon `owners`, `answeredBy`). Contributor gates (`pr-gate`, `approve-contributor`, `APPROVED_CONTRIBUTORS`, the `add-contributor` skill) stay, because the repository is public.

Order on the old repository, after one soak cycle on the new one:
1. Disable Actions on `nesyeklaf/sandy`. Its `main` still has the old guards, so its scheduled jobs would otherwise keep running.
2. Commit a "moved to sandy-sdk/sandy" note to its README and description.
3. Archive it.

Checks:
- `git grep -n nesyeklaf/sandy` on `sandy-sdk/sandy` shows only the items left unchanged above.
- `sandy plugin new demo` writes a registry URL on `sandy-sdk/sandy` at an existing tag, and `curl -sf` of one registry item there succeeds without a token.
- An already scaffolded plugin still resolves its old `nesyeklaf/sandy` registry URL.
- After step 0e, the old repository shows no workflow runs, and `scripts/fork/deploy.sh` deploys from the new remote.

## Owner steps (org, repositories, registry, CI)

Only the owner does these. The agent creates no organization, repository, app installation or token, pushes nothing, and publishes nothing.

1. Merge or close the 6 open pull requests on `nesyeklaf/sandy`; freeze `main` (step 0a).
2. Create the free organization `sandy-sdk` and an empty public `sandy-sdk/sandy`, not a fork (step 0b).
3. Push `main` and all tags from a fresh bare clone (Decision 9, step 0c).
4. Re-create the settings a push does not carry: environment `npm-release`, secrets and variables, the ruleset "Protecc", fork-PR approval, apps (CodeRabbit, SlopCop, Expo/EAS), npm trusted publisher (Decision 9).
5. Start the boat $20 plan, install the boat CI app on `sandy-sdk` (`boat ci connect --org sandy-sdk`), and run `boat ci public sandy-sdk on --users nesyeklaf` (Decision 11).
6. Choose the SDK package's visibility (Decision 3). For S2, publish the first version by hand with a classic PAT and grant Actions access before any workflow publishes.
7. Approve the first SDK publish.
8. Switch local remotes and the deploy host to `sandy-sdk/sandy`; after one soak cycle, disable Actions on `nesyeklaf/sandy`, add the "moved" note, archive it (step 0e). Never delete it.
9. Create the public `sandy-sdk/sandy-plugins` with fork-PR approval on (task 4.4).
10. For each dev host, create a classic PAT with only `read:packages` and put it in `~/.npmrc`, not in pi-setup's tracked files. Both variants need it.

## Open questions for the owner

Answered on 2026-11-12, last version: organization `sandy-sdk` with the scope following it (no rename); `sandy-sdk/sandy` and `sandy-sdk/sandy-plugins` both new and public; `nesyeklaf/sandy` kept and archived; issues and pull requests do not move; GitHub-hosted runners by default, boat only for the owner's own content; desktop macOS and Windows on GitHub runners; pi/fabric to pnpm; nothing else renamed. The earlier plans (transfer, fork detach, private sandy) are dropped.

Still open:
1. SDK package: S1 public or S2 private (Decision 3)?
2. Blacksmith: install it on `sandy-sdk` and keep its labels, or move those jobs to GitHub-hosted labels (the default in this spec)?
3. Desktop: re-create the immutable `desktop-v*` releases on the new repository, or leave them on the old one?
4. Soak time before archiving `nesyeklaf/sandy` (proposal: one sandy release cycle)?
