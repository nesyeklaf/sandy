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
| GitHub Packages' npm registry only accepts a scope equal to the owning account [G1]. The only `@sandy-sdk/*` package is `@sandy-sdk/plugin-sdk` 0.6.106. It appears in 1549 tracked files, 80 of them `package.json` (468 under `extensions/sandy`, 195 `apps/app`, 88 `apps/server`) | `git grep -l -F @sandy-sdk/plugin-sdk` |
| Installed plugin bundles import the SDK by specifier, and sandy maps it at load: `PLUGIN_SDK_SPECIFIER` plus `LEGACY_PLUGIN_SDK_SPECIFIER = "@sandy/plugin-sdk"` (`apps/server/src/services/plugins/plugin-runtime.ts:115-139, 1249`); `PLUGIN_SDK_APP_SPECIFIER` plus `LEGACY_PLUGIN_SDK_APP_SPECIFIER` (`packages/plugin-build/src/runtime-shims.mjs:14-21, 75`); `PLUGIN_SDK_HOST_FALLBACK_SPECIFIER` (`build-plugin-host.ts:52`); `PLUGIN_SDK_PACKAGE_NAME` (`plugin-sdk-install.ts:5`). The earlier `@sandy/` to `@sandy-sdk/` rename kept old names as legacy specifiers, and `sandy plugin migrate` rewrites imports (`apps/cli/src/commands/plugin.ts:236`) | source |
| Sandy is a hard fork with no upstream (FORK.md:3), so a project-wide rename causes no merge conflicts with an upstream | FORK.md |
| `nesyeklaf/sandy` appears in 88 tracked files (22 under `extensions/sandy`), including runtime URLs: `CommunitySettingsSection.tsx:11`, `AppSidebar.tsx:77` (new issue), `SettingsView.tsx:117`, `apps/desktop/src/menu.ts:20`, and the plugin registry raw URL in `plugin-scaffold.ts:740` | `git grep -l nesyeklaf/sandy` |
| Sandy's workflows use `ubuntu-24.04`/`ubuntu-latest` (22 jobs), `blacksmith-4vcpu-ubuntu-2404`/`2204` (5), `windows-2025`/`windows-latest` (6), `blacksmith-4vcpu-windows-2025` (2), `blacksmith-6vcpu-macos-15`/`27` (3), and `macos-15` legs in the `package-smoke` and `node-compat-smoke` matrices | `.github/workflows/*.yml` |
| Holon: `sandy.holon` lists `extensions/sandy/` as code. 7 `.holon` files sit in genui, holon and field-latency. `openspec/specs/holon-*` are exported from them | `git ls-files '*.holon'` |
| Sandy files that name `extensions/`: `README.md`, `docs/configuration.md`, `docs/designs/skill-authoring-in-flow-editor.md`, `scripts/fork/package-manager-exceptions.tsv`, `scripts/fork/egress-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`, `AGENTS.md` (sidebar-spaces exception), and the open changes `sidebar-spaces` and `space-coordination` | grep |
| The owner's map (`/home/feysen/projects/work/code/FEysen/master-repo/docs/maps/private.md`) describes today's state: plugins and Sandy-specific pi extensions are developed in `gh/sandy`, and `gh/plugins` holds the earlier copies. Its rows for `gh/sandy`, `gh/plugins`, `gh/pi-extensions` and `gh/plugins-wt` change with this migration | lines 13, 19, 20, 86 |

## Decision 1: repository (owner decided)

A new private repository, proposed name **`<org>/sandy-plugins`**, checkout `~/projects/private/gh/sandy-plugins`, worktrees in `~/projects/private/gh/sandy-plugins-wt`. The archived `nesyeklaf/plugins` stays as it is. Its pre-move history (the forks' kept history, the bb era) stays readable there. The new repository's README links to it from a "History before 2026-10-31" note. Grafting that history into the new repository is possible later without touching the old repository; this change does not do it.

Private visibility has two consequences:
- The sandy server host needs read access for git sources (a read-only deploy key or the host's SSH key; task 2.4).
- pi needs the same for a git package. pi-setup already loads `git:git@github.com:eysenfalk/pi-extensions` over SSH.

## Decision 2: repository shape

| | A. Monorepo of plugins (recommended) | B. One repository per plugin |
| --- | --- | --- |
| Install source | `git:git@github.com:<org>/sandy-plugins@^0.3 --subdirectory sandy/genui --tag-prefix genui-v` | `git:git@github.com:<org>/sandy-plugin-genui@^0.3` |
| Versioning | per-unit semver, per-unit tags `<unit>-v<x.y.z>`; pi train `pi-v<x.y.z>` | one semver and plain `v<x.y.z>` tags per repo |
| pnpm | one workspace, one lockfile, one SDK pin | 25 lockfiles and SDK pins |
| Shared code | `pi/work` imports `sandy/work/delegate/shared` unchanged; `packages/skill-dialect` is one internal package | shared code must be published or copied |
| Paired units (`work`+`pi/work`, `permissions`+`pi/permissions`, `pi-lifecycle`) | one commit and one PR changes both sides | coordinated releases across repos |
| pi delivery | one pi package at the root (`pi` manifest), one git source | five pi packages or local paths |
| CI and access | one workflow, matrix over changed units; one deploy key | 25 workflows and 25 deploy keys for private repos |
| Blast radius | a bad merge can touch many units; per-unit tags still pin installs | isolated by repository |
| Upstream forks (genui, BB forks) | `UPSTREAM.md` per unit, as today | a fork per repository is easier to sync with upstream |

The reason for A is that the units are already coupled: shared source, paired protocols, one pi entry point. With a private repository and the pnpm rule, B multiplies deploy keys and lockfiles by 25. Cheapest check that would disprove A: install one unit from a test tag with `--subdirectory` and `--tag-prefix` (task 2.1). If sandy cannot resolve a prefixed tag in a subdirectory, B wins.

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

**The SDK: `@<org>/plugin-sdk` on GitHub Packages, private (owner decided 2026-11-12).**
- Only the owner and GitHub Actions install it.
- The package is renamed for real, with no alias: sandy and every unit import `@<org>/plugin-sdk` (Decision 10).
- `<org>` is the GitHub organization that will own sandy, the plugin repository and the package (Decision 9). Its name is still being decided.
- A sandy git install never needs the SDK (optional peer, above), so installed plugins never need a token.

Facts from GitHub's docs (read 2026-11-12):
- [G1] GitHub Packages "only supports scoped npm packages", scoped to "the user or organization account to which the package will be scoped". Authentication outside Actions uses only classic tokens ("GitHub Packages only supports authentication using a personal access token (classic)"). Source: [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
- [G2] In Actions, `GITHUB_TOKEN` publishes "packages associated with the workflow repository". It installs packages of other private repositories "if the repository is granted read access to the package"; otherwise a classic PAT with `read:packages` is needed. Sources: G1 and [About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).
- [G3] "If a workflow creates a package using the `GITHUB_TOKEN`, ... the package inherits the visibility and permissions model of the repository where the workflow is run." Uploading a new version needs write permission on the package. "If you grant a public repository access to private packages, forks of the repository may be able to access the private packages." Source: [Publishing and installing a package with GitHub Actions](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions).
- [G4] "Once you make a package public, you cannot make it private again." A linked package inherits the repository's access permissions (not its visibility), and workflows in the linked repository get access automatically. A private organization package can be shared "only ... to other organization members or teams". Further repositories are added under "Manage Actions access". Source: [Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
- [G5] GitHub Free for organizations includes 500 MB storage, shared with Actions artifacts, and 1 GB transfer a month. Downloads by Actions with `GITHUB_TOKEN` are free; downloads with a PAT count against transfer. Source: [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).
- [G6] On a repository transfer, "packages associated with the repository may be transferred, or may lose their link"; for npm, packages stay with the account they are scoped to. Sources: [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository) and G2.
- The docs do not say whether a repository of one account can be added to "Manage Actions access" of another account's package. That is why all three (sandy, the plugin repository, the package) live under the one owner `<org>`. If the scope stayed `@nesyeklaf` while the repositories moved to the org, every Actions step would need a PAT.

Same owner, so `GITHUB_TOKEN` suffices (G2, G4). The remaining question is which repository publishes:

| | P1. The private plugin repository publishes (recommended) | P2. The public sandy repository publishes |
| --- | --- | --- |
| How | `.github/workflows/publish-sdk.yml` in `<org>/sandy-plugins` (`workflow_dispatch`, input: sandy tag) runs `scripts/sdk.sh <tag>` (checkout, sandy's turbo build of `packages/plugin-sdk`, pack), then `pnpm publish` with `GITHUB_TOKEN`, `packages: write` | sandy's existing `publish-plugin-sdk` job retargeted to `npm.pkg.github.com` with `GITHUB_TOKEN` |
| Visibility at creation | private, because the creating repository is private (G3) | **public, and that cannot be undone** (G3, G4), unless the owner creates the first version by hand with a PAT |
| Access | linked to the plugin repository; its CI reads automatically (G4) | sandy must get write access under "Manage Actions access", and GitHub warns that forks of a public repository may then reach the package (G3) |
| Catch | a sandy release is packed and published by another repository; the version comes from sandy's `plugin-sdk-version.ts` at that tag, and the workflow refuses a version that already exists | the risks in the two rows above, on a repository that accepts outside pull requests |

**Recommendation: P1.** The package is private from its first version, no public repository gets access, and no step needs a stored token. In sandy, the `publish-plugin-sdk` job that targets npmjs (still waiting on its bootstrap) and `check-npm-version-guard.mjs` are removed by the rename change; sandy builds the SDK from source in its workspace and never installs the package.

Plugin repository settings:
- The committed `.npmrc` holds only the scope mapping, `@<org>:registry=https://npm.pkg.github.com`, and no token. Sandy's git install deletes `.npmrc` and does not fetch the optional peer.
- `ci.yml` sets `permissions: { contents: read, packages: read }` and `actions/setup-node` with `registry-url: https://npm.pkg.github.com` and `scope: '@<org>'`, with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- Locally, `~/.npmrc` holds `//npm.pkg.github.com/:_authToken=<classic PAT, read:packages>`. pnpm reads the project and user `.npmrc`; nothing pnpm-specific is needed.
- Storage: every version counts against 500 MB (G5). Measure the packed size at the first publish, and delete versions below the lowest `engines.sandyPluginSdk` floor in use.
- Bridge until the first publish: `scripts/sdk.sh <sandy-tag> --local` packs the same package into `.sdk/`, and the root devDependency points at `file:.sdk/<org>-plugin-sdk.tgz`.
- Checks at the first publish:
  - the package page shows Private and the link to `<org>/sandy-plugins`;
  - an unauthenticated `npm view @<org>/plugin-sdk --registry=https://npm.pkg.github.com` fails;
  - CI installs it with `GITHUB_TOKEN` only.

Nothing is published without the owner's explicit OK.

**sandy-app** (sidebar-delegate e2e): drop the dependency. The e2e harness already takes `--app <dir>`; CI passes the `sandy-app` it built from the pinned sandy ref.

**Compatibility.**
- `engines.sandy` and `engines.sandyPluginSdk` stay the contract sandy enforces.
- `compat.json` records, per unit release, the sandy tag and SDK version the release was tested against.
- CI runs each changed unit against the sandy release the owner runs (blocking) and against sandy `main` (nightly, reports only).
- Raising an `engines` floor is a minor release of the unit.

**pi/fabric.** It builds and tests with bun today. Under the pnpm rule, pnpm owns its dependencies and lockfile entry, and bun stays only as its build and test runner, unless the owner wants bun removed (open question).

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
  - `sandy plugin install git:git@github.com:<org>/sandy-plugins@^<major.minor> --subdirectory sandy/<unit> --tag-prefix <unit>-v --replace-source` switches each id while keeping its state (Decision 6).
  - From then on, `sandy plugin outdated`, `sandy plugin update` and Settings → Updates apply releases.
- **pi.**
  - pi-setup is the only writer of `~/.pi/agent`. Its `links.tsv` (`extensions/permissions`, `autopilots`, `extensions/lifecycle/index.ts`) and `settings/base.json` packages (`pi/context`, `pi/work`) switch to the `sandy-plugins` checkout, applied with `node apply.mjs <host>`.
  - Later, if task 2.3 shows pi installs the root package and its pnpm-managed dependencies, one `git:git@github.com:<org>/sandy-plugins@pi-v<x.y.z>` package replaces the local paths.
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
  1. Run in a fresh clone of `<org>/sandy` in a scratch directory, never in a working checkout: `git filter-repo --path extensions/ --path packages/skill-dialect/ --path-rename extensions/:`.
  2. A message callback rewrites `#N` to `<org>/sandy#N` so PR references keep pointing at sandy.
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
| 0a | Owner: create `<org>`, transfer `nesyeklaf/sandy` (Decision 9); boat plan and app on `<org>` (Decision 11) | `git ls-remote git@github.com:<org>/sandy.git`; the old URL redirects; installed plugins unaffected (they use local paths) | transfer back (GitHub allows it while `nesyeklaf/sandy` is not re-created) |
| 0b | Sandy change: `nesyeklaf/sandy` → `<org>/sandy` references; local remotes and pi-setup git sources updated | grep shows only history hits | revert; redirects still work |
| 0c | Sandy change: rename to `@<org>/plugin-sdk` with legacy specifiers (Decision 10), released and deployed with owner OK | fixture plugin with old imports loads; every installed plugin `running` after deploy; stale-name ratchet green | revert the release; legacy specifiers mean no plugin needs a rebuild either way |
| 1 | Core `--replace-source` in sandy (Decision 6), released and deployed with owner OK | contract tests green; staging: path → git → path keeps settings | revert; nothing uses it yet |
| 2 | Spikes 2.1–2.5 on the staging instance | spike verdicts | none |
| 3 | Scratch clone: filter-repo; then on top: pnpm workspace, decoupling, holon move, scripts, CI | Decision 7 checks; every unit's tests, `check-git-install.mjs`, `sandy plugin build` serially; `holon check` | delete the scratch clone |
| 4 | Owner OK: create the private repository, push, deploy key for the server host, CI green, first tags at current versions | tags exist; CI green | delete the repository; sandy is untouched |
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
| new row `gh/sandy-plugins` | — | "`<org>/sandy-plugins` (private): the owner's sandy plugins (`sandy/`) and Sandy-specific pi extensions (`pi/`), pnpm workspace, released per unit (`<unit>-v*`, `pi-v*`). Conventions: AGENTS.md. SANDY and pi load from it; worktrees under `gh/sandy-plugins-wt/`." |
| 86 `gh/plugins-wt` | worktrees of `gh/plugins` | unchanged; add `gh/sandy-plugins-wt` |

## Risks

- **Two checkouts drift.** SANDY reads `~/projects/private/gh/sandy` and pi reads `~/projects/sandy` today. The migration points both at one `sandy-plugins` checkout per host.
- **Floating runtime ranges.** A git install ignores `pnpm-lock.yaml`, so a dependency release can change what a git install builds. Mitigation: `check-git-install.mjs` in CI and before each release, exact versions for runtime dependencies, and few runtime dependencies.
- **Private repository access** from the sandy host and pi (task 2.4).
- **Holon `partOf` across repositories** (task 2.5).
- **History rewrite mistakes.** The work runs in a scratch clone; the trees are compared before anything is pushed.

## Decision 9: the GitHub organization `<org>` (owner decided; name open)

Sandy, the plugin repository and the SDK package get one owner, the organization `<org>`. The reasons are the same-owner `GITHUB_TOKEN` rule (Decision 3) and boat CI installed once on the organization (Decision 11).

Transferring `nesyeklaf/sandy` to `<org>/sandy` (G6):
- Issues, pull requests, wiki, stars, secrets, webhooks and deploy keys move along. Web links and `git clone/fetch/push` redirect to the new location.
- The redirect is deleted for good if anyone ever creates a repository or fork named `nesyeklaf/sandy` again. Installed sandy versions keep calling the old URLs (Settings → Community, the bug-report link, the desktop LICENSE menu, the plugin registry raw URL in `plugin-scaffold.ts:740`), so **`nesyeklaf/sandy` must never be re-created**.
- GitHub Pages do not redirect (G6); sandy publishes none (unverified).
- npm packages scoped to `@nesyeklaf` would not move (G6). None exist, because `@sandy-sdk/plugin-sdk` was never published.
- After the transfer, the organization's default repository permissions apply.
- Repositories with more than 100 clones or Actions uses in the week before the transfer have their old `OWNER/NAME` retired permanently (G6). That only blocks re-creating it, which is excluded anyway.

In sandy, as its own change after the transfer: replace the 88 `nesyeklaf/sandy` references with `<org>/sandy`, runtime URLs first. Leave history and archived OpenSpec and holon records. `nesyeklaf` as a person (holon `owners`, `answeredBy`) stays. Local remotes are updated with `git remote set-url origin git@github.com:<org>/sandy.git` in `~/projects/sandy`, `~/projects/private/gh/sandy` and the managed worktrees. pi-setup's git sources need the same update.

`<org>/sandy-plugins` is created in the organization (Decision 1). `nesyeklaf/plugins` stays archived under the user.

## Decision 10: rename `@sandy-sdk/plugin-sdk` to `@<org>/plugin-sdk`

Scope:
- The package `packages/plugin-sdk` (`name`, `publishConfig` to `https://npm.pkg.github.com`, `repository` to `<org>/sandy`).
- Every import specifier, including subpaths (`/app`, `/host`, `/internal/*`, `/provider-bridge*`, `/environment-provider`, `/machine-provider`).
- The 80 `package.json` files and the turbo filters (`--filter=@sandy-sdk/plugin-sdk` in `ci.yml:445, 577`, version-lockstep).
- Scripts: `bump-plugin-sdk.mjs`, `check-plugin-forks.mjs`, `lib/plugin-fork.mjs`, `check-provider-literal-ratchet.mjs`, `oxlint-plugin.mjs`, `scripts/perf/fixtures/*`.
- `apps/app/.ladle/vite.config.ts` and the `examples/plugins/*` tsconfig paths.

Not renamed:
- the `engines.sandyPluginSdk` key; it is a field name, and renaming it would invalidate every installed manifest;
- the `bundled-types/sandy-plugin-sdk*.d.ts` file names;
- `sandy-app` and the private `@sandy/*` workspace packages (owner question 4).

The rename changes no wire field between server and daemon (the specifier lives in the server and plugin-build), so no `HOST_DAEMON_PROTOCOL_VERSION` bump.

Generated and documentation surfaces:
- **bundled-types:** generated (gitignored). `build-bundled-dts.mjs` and `normalize-bundled-dts.mjs` emit `declare module "@<org>/plugin-sdk..."` blocks, plus the old name as a re-export module so plugins on old imports still typecheck.
- **Templates and scaffolding:**
  - `packages/templates/src/plugin-scaffold.ts`: `SDK_PATH_MAP_PREFIXES` gains `@<org>/plugin-sdk` first and keeps the two old names; the devDependency written by `sandy plugin new` (line 1457) and the dependency checks (329-436, 624) use the new name;
  - `sandy plugin types` and `sandy plugin migrate` (`apps/cli/src/commands/plugin.ts:209-236, 1354`): migrate rewrites `@sandy/plugin-sdk` and `@sandy-sdk/plugin-sdk` imports and `package.json` entries to `@<org>/plugin-sdk`.
- **Plugin Guide and docs:**
  - `plugins/plugin-api-docs` (`src/surfaces.ts` SDK symbols, `src/agent-reference.ts`, `PLUGIN_OVERVIEW.md`, `app.tsx`, `server.ts`);
  - `packages/templates/src/templates/sandy-guide-plugins.md`;
  - `docs/api_to_audit.md`, `docs/forkable-plugins.md`, `docs/provider-bridge-protocol.md`, `docs/provider-plugin-api.md`, `docs/sandy-release-process.md` (the SDK publish section now names Decision 3), `docs/ci-performance.md`.

Installed plugins keep working:
- Every plugin built before the rename imports `@sandy-sdk/plugin-sdk`.
- Each specifier constant becomes the new name, and `@sandy-sdk/plugin-sdk` joins `@sandy/plugin-sdk` as a legacy specifier, mapped to the same runtime entry:
  - server `runtimeImports` and `pluginSdkRuntimeEntry`;
  - the app shims (`/app`);
  - the host fallback (`/host`);
  - `PLUGIN_SDK_PACKAGE_NAME` checks, which accept either name.
- Legacy specifiers stay with no end date, as `@sandy/` has.
- Tests:
  - a fixture plugin whose server, host and app bundles import `@sandy-sdk/plugin-sdk` loads and runs after the rename;
  - a path plugin rebuilt on reload works with either name;
  - `sandy plugin migrate` turns an old plugin into one that imports only the new name.

Stale-name search: after the rename, `git grep -n -F "@sandy-sdk/plugin-sdk"` may hit only:
- the legacy specifier constants and their tests;
- the migrate rewrite and its tests;
- the bundled-types re-export;
- release notes, `openspec/changes/archive` and `.holons` history.
A ratchet in `scripts/` (pattern of `check-provider-literal-ratchet.mjs`) fails CI on any new hit.

Order: the rename lands and ships in sandy (released and deployed with the owner's OK) **before** the plugin repository is built, so the filtered history gets the new imports in a normal commit on top (Decision 7), and the plugin repository never imports the old name.

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

Plugin repository `<org>/sandy-plugins` (private, so B5 does not apply):

| Job | `runs-on` | Why |
| --- | --- | --- |
| `plan` (select changed units) | `boat-small` | git diff only |
| `unit` matrix: install, tests (`VITEST_MAX_WORKERS=1`), `check-git-install.mjs`, `sandy plugin build` | `boat` | needs a sandy CLI from the pinned tag; 8 GB covers one unit plus the build. `strategy.max-parallel: 12` keeps a full matrix within the per-minute starts (B3) |
| `holon` | `boat-small` | one CLI check |
| `compat-nightly` against sandy `main` | `boat-large` | builds sandy from source, then all units |
| `publish-sdk` | `boat` | turbo build of `packages/plugin-sdk` at a sandy tag |
| `release` (GitHub release from a pushed tag) | `boat-small` | metadata only |

A saved snapshot `from=sandy-plugins-ci` with Node 26.13.0, pnpm and the pinned sandy CLI can cut start time later. It is not needed at first.

Sandy (`<org>/sandy`, public). Do not edit its workflows in this change. Possible moves:

| Jobs | Today | Can move to boat? |
| --- | --- | --- |
| `ci.yml` fork-egress, plan, dependencies, static-checks, checks, tests, plugin-forks, provider-model-listing; `version-lockstep`; `perf-regression`; `ci-health` | `ubuntu-24.04`, `ubuntu-latest`, `blacksmith-4vcpu-ubuntu-2404` | yes (`boat` or `boat-large` for tests), only after the public-repository switch (B5). Pull requests from contributors who are not on the list are refused, so they need a GitHub-hosted fallback or `--anyone` with approval |
| `package-smoke`, `node-compat-smoke` | matrix `ubuntu-24.04` + `macos-15` | the Ubuntu legs only |
| `mobile-android-e2e`, `mobile-android-eas`, `mobile-ios-eas` (EAS cloud build) | `ubuntu-latest` | yes; the Android emulator runs with `/dev/kvm` (B2) |
| `build-desktop` linux, `nightly-desktop-linux` | `blacksmith-4vcpu-ubuntu-2204` | only inside `container: ubuntu:22.04`; the Ubuntu 22.04 base probably sets the glibc floor of the Linux build (to check) |
| `build-desktop` publish, `nightly-desktop-publish`, `publish`, `publish-nightly` | `blacksmith-4vcpu-ubuntu-2404`, `ubuntu-latest` | technically yes; npm trusted publishing must accept a self-hosted runner (to check before moving) |
| `windows-*` (5 jobs in `ci.yml`), `fork-build-windows`, `build-desktop` windows, `nightly-desktop-windows` | `windows-2025`, `windows-latest`, `blacksmith-4vcpu-windows-2025` | **no** (B6); Wine does not cover the desktop app and installer |
| `build-desktop` macos, `nightly-desktop-macos`, `mobile-e2e` (iOS), the `macos-15` matrix legs | `blacksmith-6vcpu-macos-15/27`, `macos-15` | **no** (B6) |
| `approve-contributor`, `close-stale-prs`, `pr-gate`, `ci-cache-maintenance` | `ubuntu-latest` | possible, but each costs a VM start for seconds of work |

GitHub-hosted runners are free for public repositories, so moving sandy's Linux jobs buys speed and costs boat time. Which jobs move is the owner's call (open question 5).

## Owner steps (org, registry, CI)

Only the owner does these. The agent creates no organization, repository, app installation or token, and publishes nothing.

1. Choose the organization name `<org>` and create the free GitHub organization (with the package scope `@<org>`).
2. Transfer `nesyeklaf/sandy` to `<org>/sandy` (Decision 9). Never re-create `nesyeklaf/sandy`.
3. Create the private `<org>/sandy-plugins` (task 4.4).
4. Start the boat $20 plan. Install the boat CI app on `<org>` (`boat ci connect`, or "Boat CI for orgs") for `sandy-plugins`, and for `sandy` only if jobs move there. For `sandy`, set `boat ci public <org> on --users ...`.
5. Approve the first run of `publish-sdk.yml` for your sandy tag and check the first-publish catches (Decision 3).
6. For each dev host, create a classic PAT with only `read:packages` and put it in `~/.npmrc`, not in pi-setup's tracked files.

## Open questions for the owner

1. Organization name `<org>`, and is the package scope `@<org>`? Same-owner `GITHUB_TOKEN` works only if the package, sandy and the plugin repository share one owner (Decision 3).
2. Repository name `<org>/sandy-plugins`, or another?
3. pi/fabric: keep bun as its build and test runner under pnpm-managed dependencies, or move it fully to pnpm scripts?
4. Rename anything besides `@sandy-sdk/plugin-sdk`? No other `@sandy-sdk/*` package exists. Candidates are the npmjs package `sandy-app` and the private `@sandy/*` workspace names; the recommendation is to keep both.
5. Which sandy jobs move to boat (Decision 11): none, the Linux CI jobs only, or also Android, desktop Linux and the publish jobs? Windows and macOS cannot move.
6. Publisher: P1, the private plugin repository (recommended), or P2, sandy itself (Decision 3)?
