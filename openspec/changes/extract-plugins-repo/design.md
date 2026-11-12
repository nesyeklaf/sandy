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
| `nesyeklaf/sandy` is a fork whose parent is not visible: `fork: true`, 0 forks, 0 stars, about 202 MB (`size` 207195 KB), 35 issues and 32 pull requests, 6 releases, no Pages, no wiki, one active ruleset "Protecc", no classic branch protection | `gh api repos/nesyeklaf/sandy`, `/rulesets`, search API, 2026-11-12 |
| Workflows guard on the repository name: `if: github.repository == 'nesyeklaf/sandy'` in `ci-cache-maintenance.yml:20`, `ci-health.yml:14`, `ci.yml:583`, `close-stale-prs.yml:18`, `mobile-android-e2e.yml:27`, `mobile-e2e.yml:60`, `publish-sandy-app.yml:58, 384` | `git grep github.repository -- .github` |
| The desktop app has no update check: no feed URL in `apps/desktop/src`, and `scripts/fork/check-egress-hosts.sh:11` forbids `nesyeklaf/sandy/releases` in code. The `desktop-latest`/`desktop-nightly` feed URLs appear only in CI job summaries (`build-desktop.yml:492-495`, `publish-sandy-app.yml:1049-1051`) | source |
| `components.json` of 9 plugins and `plugin-scaffold.ts:740` point their `@sandy` registry at `https://raw.githubusercontent.com/nesyeklaf/sandy/<tag>/packages/plugin-registry/r/{name}.json` | `git grep raw.githubusercontent` |
| npm rejects provenance from self-hosted runners (E422), so sandy's npm publish jobs stay on GitHub-hosted runners | `publish-sandy-app.yml:36-37` |
| `nesyeklaf/sandy` appears in 88 tracked files (22 under `extensions/sandy`), including runtime URLs: `CommunitySettingsSection.tsx:11`, `AppSidebar.tsx:77` (new issue), `SettingsView.tsx:117`, `apps/desktop/src/menu.ts:20`, and the plugin registry raw URL in `plugin-scaffold.ts:740` | `git grep -l nesyeklaf/sandy` |
| Sandy's workflows use `ubuntu-24.04`/`ubuntu-latest` (22 jobs), `blacksmith-4vcpu-ubuntu-2404`/`2204` (5), `windows-2025`/`windows-latest` (6), `blacksmith-4vcpu-windows-2025` (2), `blacksmith-6vcpu-macos-15`/`27` (3), and `macos-15` legs in the `package-smoke` and `node-compat-smoke` matrices | `.github/workflows/*.yml` |
| Holon: `sandy.holon` lists `extensions/sandy/` as code. 7 `.holon` files sit in genui, holon and field-latency. `openspec/specs/holon-*` are exported from them | `git ls-files '*.holon'` |
| Sandy files that name `extensions/`: `README.md`, `docs/configuration.md`, `docs/designs/skill-authoring-in-flow-editor.md`, `scripts/fork/package-manager-exceptions.tsv`, `scripts/fork/egress-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`, `AGENTS.md` (sidebar-spaces exception), and the open changes `sidebar-spaces` and `space-coordination` | grep |
| The owner's map (`/home/feysen/projects/work/code/FEysen/master-repo/docs/maps/private.md`) describes today's state: plugins and Sandy-specific pi extensions are developed in `gh/sandy`, and `gh/plugins` holds the earlier copies. Its rows for `gh/sandy`, `gh/plugins`, `gh/pi-extensions` and `gh/plugins-wt` change with this migration | lines 13, 19, 20, 86 |

## Decision 1: repository (owner decided)

A new private repository, proposed name **`sandy-sdk/sandy-plugins`**, checkout `~/projects/private/gh/sandy-plugins`, worktrees in `~/projects/private/gh/sandy-plugins-wt`. The archived `nesyeklaf/plugins` stays as it is. Its pre-move history (the forks' kept history, the bb era) stays readable there. The new repository's README links to it from a "History before 2026-10-31" note. Grafting that history into the new repository is possible later without touching the old repository; this change does not do it.

Private visibility has two consequences:
- The sandy server host needs read access for git sources (a read-only deploy key or the host's SSH key; task 2.4).
- pi needs the same for a git package. pi-setup already loads `git:git@github.com:eysenfalk/pi-extensions` over SSH.

## Decision 2: repository shape

| | A. Monorepo of plugins (recommended) | B. One repository per plugin |
| --- | --- | --- |
| Install source | `git:git@github.com:sandy-sdk/sandy-plugins@^0.3 --subdirectory sandy/genui --tag-prefix genui-v` | `git:git@github.com:sandy-sdk/sandy-plugin-genui@^0.3` |
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

**The SDK: `@sandy-sdk/plugin-sdk` on GitHub Packages, private (owner decided 2026-11-12).**
- Only the owner and GitHub Actions install it.
- The name stays `@sandy-sdk/plugin-sdk`: the owner named the organization `sandy-sdk`, so the scope already matches the owner (G1) and nothing is renamed (Decision 10).
- `sandy-sdk` owns sandy, the plugin repository and the package (Decision 9).
- A sandy git install never needs the SDK (optional peer, above), so installed plugins never need a token.

Facts from GitHub's docs (read 2026-11-12):
- [G1] GitHub Packages "only supports scoped npm packages", scoped to "the user or organization account to which the package will be scoped". Authentication outside Actions uses only classic tokens ("GitHub Packages only supports authentication using a personal access token (classic)"). Source: [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
- [G2] In Actions, `GITHUB_TOKEN` publishes "packages associated with the workflow repository". It installs packages of other private repositories "if the repository is granted read access to the package"; otherwise a classic PAT with `read:packages` is needed. Sources: G1 and [About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).
- [G3] "If a workflow creates a package using the `GITHUB_TOKEN`, ... the package inherits the visibility and permissions model of the repository where the workflow is run." Uploading a new version needs write permission on the package. "If you grant a public repository access to private packages, forks of the repository may be able to access the private packages." Source: [Publishing and installing a package with GitHub Actions](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions).
- [G4] "Once you make a package public, you cannot make it private again." A linked package inherits the repository's access permissions (not its visibility), and workflows in the linked repository get access automatically. A private organization package can be shared "only ... to other organization members or teams". Further repositories are added under "Manage Actions access". Source: [Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
- [G5] GitHub Free for organizations includes 500 MB storage, shared with Actions artifacts, and 1 GB transfer a month. Downloads by Actions with `GITHUB_TOKEN` are free; downloads with a PAT count against transfer. Source: [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).
- [G6] On a repository transfer, "packages associated with the repository may be transferred, or may lose their link"; for npm, packages stay with the account they are scoped to. Sources: [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository) and G2.
- The docs do not say whether a repository of one account can be added to "Manage Actions access" of another account's package. That is why all three (sandy, the plugin repository, the package) live under the one owner `sandy-sdk`.

Same owner, so `GITHUB_TOKEN` suffices (G2, G4). The remaining question is which repository publishes:

| | P1. The private plugin repository publishes (recommended) | P2. Sandy publishes (alternative once sandy is private) |
| --- | --- | --- |
| How | `.github/workflows/publish-sdk.yml` in `sandy-sdk/sandy-plugins` (`workflow_dispatch`, input: sandy tag) runs `scripts/sdk.sh <tag>` (checkout, sandy's turbo build of `packages/plugin-sdk`, pack), then `pnpm publish` with `GITHUB_TOKEN`, `packages: write` | sandy's existing `publish-plugin-sdk` job retargeted to `npm.pkg.github.com` with `GITHUB_TOKEN` |
| Visibility at creation | private, because the creating repository is private (G3) | **public, and that cannot be undone** (G3, G4), unless the owner creates the first version by hand with a PAT |
| Access | linked to the plugin repository; its CI reads automatically (G4) | sandy must get write access under "Manage Actions access", and GitHub warns that forks of a public repository may then reach the package (G3) |
| Catch | a sandy release is packed and published by another repository; the version comes from sandy's `plugin-sdk-version.ts` at that tag, and the workflow refuses a version that already exists | the risks in the two rows above, on a repository that accepts outside pull requests |

**Owner decision: P1 for now.** The package is private from its first version, no public repository gets access, and no step needs a stored token. In sandy, the `publish-plugin-sdk` job that targets npmjs (still waiting on its bootstrap) and `check-npm-version-guard.mjs` are removed (Decision 10). Sandy builds the SDK from source in its workspace and never installs the package.

**P2 becomes safe once sandy is private (Decision 12).** Both rows against P2 come from sandy being public: a package created by a private repository's `GITHUB_TOKEN` is private (G3), and a private repository has no outside forks. Then sandy's `publish-plugin-sdk` job, retargeted to `npm.pkg.github.com`, can publish at each sandy release, and the plugin repository gets read access under "Manage Actions access" (G4). Switching from P1 to P2 later is an owner choice: add the sandy repository with write access to the existing package, move the job, and delete `publish-sdk.yml` in the plugin repository.

Plugin repository settings:
- The committed `.npmrc` holds only the scope mapping, `@sandy-sdk:registry=https://npm.pkg.github.com`, and no token. Sandy's git install deletes `.npmrc` and does not fetch the optional peer.
- `ci.yml` sets `permissions: { contents: read, packages: read }` and `actions/setup-node` with `registry-url: https://npm.pkg.github.com` and `scope: '@sandy-sdk'`, with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- Locally, `~/.npmrc` holds `//npm.pkg.github.com/:_authToken=<classic PAT, read:packages>`. pnpm reads the project and user `.npmrc`; nothing pnpm-specific is needed.
- Storage: every version counts against 500 MB (G5). Measure the packed size at the first publish, and delete versions below the lowest `engines.sandyPluginSdk` floor in use.
- Bridge until the first publish: `scripts/sdk.sh <sandy-tag> --local` packs the same package into `.sdk/`, and the root devDependency points at `file:.sdk/sandy-sdk-plugin-sdk.tgz`.
- Checks at the first publish:
  - the package page shows Private and the link to `sandy-sdk/sandy-plugins`;
  - an unauthenticated `npm view @sandy-sdk/plugin-sdk --registry=https://npm.pkg.github.com` fails;
  - CI installs it with `GITHUB_TOKEN` only.

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
  2. A message callback rewrites `#N` to `sandy-sdk/sandy#N` so PR references keep pointing at sandy.
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
| 0a | Owner: export issues and pull requests (`gh issue list`/`gh pr list --state all --json ...` into a private archive), then detach `nesyeklaf/sandy` from its fork network (Decision 12) | `gh api repos/nesyeklaf/sandy --jq .fork` is `false`; the issue and PR counts match the export | none: detaching is permanent; the export is the fallback |
| 0b | Owner: create the organization `sandy-sdk`, transfer the repository to `sandy-sdk/sandy` (Decision 9); boat plan and app on `sandy-sdk` (Decision 11) | `git ls-remote git@github.com:sandy-sdk/sandy.git`; the old URL redirects | transfer back while `nesyeklaf/sandy` is not re-created |
| 0c | Sandy change: `nesyeklaf/sandy` → `sandy-sdk/sandy` references and the 8 `github.repository` guards; local remotes updated | grep shows only history hits; the next scheduled `ci-health` run is not skipped | revert; redirects still work |
| 0d | Sandy change for the private repository (Decision 12): registry URLs, contributor gates removed, npmjs publish jobs off, macOS/Windows jobs gated, Linux jobs on boat | the checks of Decision 12 | revert |
| 0e | Owner: make `sandy-sdk/sandy` private | an unauthenticated `curl -sI https://github.com/sandy-sdk/sandy` returns 404; CI runs | make it public again (stars and watchers are already lost) |
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
| new row `gh/sandy-plugins` | — | "`sandy-sdk/sandy-plugins` (private): the owner's sandy plugins (`sandy/`) and Sandy-specific pi extensions (`pi/`), pnpm workspace, released per unit (`<unit>-v*`, `pi-v*`). Conventions: AGENTS.md. SANDY and pi load from it; worktrees under `gh/sandy-plugins-wt/`." |
| 86 `gh/plugins-wt` | worktrees of `gh/plugins` | unchanged; add `gh/sandy-plugins-wt` |

## Risks

- **Two checkouts drift.** SANDY reads `~/projects/private/gh/sandy` and pi reads `~/projects/sandy` today. The migration points both at one `sandy-plugins` checkout per host.
- **Floating runtime ranges.** A git install ignores `pnpm-lock.yaml`, so a dependency release can change what a git install builds. Mitigation: `check-git-install.mjs` in CI and before each release, exact versions for runtime dependencies, and few runtime dependencies.
- **Private repository access** from the sandy host and pi (task 2.4).
- **Holon `partOf` across repositories** (task 2.5).
- **History rewrite mistakes.** The work runs in a scratch clone; the trees are compared before anything is pushed.

## Decision 9: the GitHub organization `sandy-sdk` (owner decided)

The organization `sandy-sdk` owns `sandy-sdk/sandy` (transferred from `nesyeklaf/sandy`), the new private `sandy-sdk/sandy-plugins`, and the package `@sandy-sdk/plugin-sdk`. This keeps one owner for the same-owner `GITHUB_TOKEN` rule (Decision 3) and lets the boat CI app be installed once on the organization (Decision 11). `pi-setup` and `forge-skills` stay under `nesyeklaf`, and so does the archived `nesyeklaf/plugins`.

Transferring `nesyeklaf/sandy` to `sandy-sdk/sandy` (G6) happens after the fork detach (Decision 12), because GitHub refuses to transfer "single repositories forked from a private upstream network":
- Issues, pull requests, wiki, stars, secrets, webhooks and deploy keys move along. Web links and `git clone/fetch/push` redirect to the new location.
- The redirect is deleted for good if anyone ever creates a repository or fork named `nesyeklaf/sandy` again. Installed sandy versions keep the old URLs in Settings → Community, the bug-report link and the desktop LICENSE menu, so **`nesyeklaf/sandy` must never be re-created**. Once the repository is private, those links need a login anyway (Decision 12).
- A private repository transferred to a GitHub Free organization "will lose access to features like protected branches" (G6). See Decision 12 for the ruleset.
- After the transfer, the organization's default repository permissions apply.

In sandy, as its own change right after the transfer:
- Replace the 88 `nesyeklaf/sandy` references with `sandy-sdk/sandy`, runtime URLs first.
- Replace the 8 `github.repository == 'nesyeklaf/sandy'` guards first of all: after the transfer they are false, so scheduled jobs (`ci-health`, `ci-cache-maintenance`, `close-stale-prs`, the nightly publish) and the SDK build step in `ci.yml:583` are skipped without an error.
- Update `scripts/fork/check-egress-hosts.sh:11` to forbid `sandy-sdk/sandy/releases`.
- Leave history and archived OpenSpec and holon records. `nesyeklaf` as a person (holon `owners`, `answeredBy`) stays.
- Locally: `git remote set-url origin git@github.com:sandy-sdk/sandy.git` in `~/projects/sandy`, `~/projects/private/gh/sandy` and the managed worktrees.

## Decision 10: the SDK keeps its name (owner decided)

The owner named the organization `sandy-sdk`, so `@sandy-sdk/plugin-sdk` is already a valid GitHub Packages name (G1), and nothing is renamed: no import, `package.json`, template, CLI message or bundled type changes, and installed plugins are unaffected. `sandy-app` and the private `@sandy/*` workspace packages keep their names too.

What changes in sandy, as part of the step 0d change:
- `packages/plugin-sdk/package.json`: `publishConfig` to `{ "registry": "https://npm.pkg.github.com" }` (drop `access: public`), and `repository` to `sandy-sdk/sandy`.
- `publish-sandy-app.yml` job `publish-plugin-sdk` (npmjs, never bootstrapped) and `check-npm-version-guard.mjs` are removed under P1, or retargeted under P2 (Decision 3). `ci.yml:588` drops its call to the guard.
- `docs/sandy-release-process.md#publishing-the-plugin-sdk` describes the GitHub Packages publish instead of the npm bootstrap.
- The `engines.sandyPluginSdk` floor and `check-plugin-sdk-version.mjs` stay as they are.

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

Plugin repository `sandy-sdk/sandy-plugins` (private, so B5 does not apply):

| Job | `runs-on` | Why |
| --- | --- | --- |
| `plan` (select changed units) | `boat-small` | git diff only |
| `unit` matrix: install, tests (`VITEST_MAX_WORKERS=1`), `check-git-install.mjs`, `sandy plugin build` | `boat` | needs a sandy CLI from the pinned tag; 8 GB covers one unit plus the build. `strategy.max-parallel: 12` keeps a full matrix within the per-minute starts (B3) |
| `holon` | `boat-small` | one CLI check |
| `compat-nightly` against sandy `main` | `boat-large` | builds sandy from source, then all units |
| `publish-sdk` | `boat` | turbo build of `packages/plugin-sdk` at a sandy tag |
| `release` (GitHub release from a pushed tag) | `boat-small` | metadata only |

A saved snapshot `from=sandy-plugins-ci` with Node 26.13.0, pnpm and the pinned sandy CLI can cut start time later. It is not needed at first.

Sandy (`sandy-sdk/sandy`). The owner decided its Linux jobs move to boat too. Sandy is private by then (Decision 12), so the public-repository restriction (B5) no longer applies. This change does not edit sandy's workflows; step 0d does.

| Jobs | Today | Target |
| --- | --- | --- |
| `ci.yml` fork-egress, plan, dependencies, static-checks, checks, plugin-forks, provider-model-listing; `version-lockstep`; `ci-health` | `ubuntu-24.04`, `ubuntu-latest` | `boat-small` (plan, guards) or `boat` |
| `ci.yml` tests, `perf-regression` | `ubuntu-24.04`, `blacksmith-4vcpu-ubuntu-2404` | `boat-large`; perf numbers need a new baseline on the new hardware |
| `package-smoke`, `node-compat-smoke` Ubuntu legs | matrix `ubuntu-24.04` | `boat` |
| `mobile-android-e2e`, `mobile-android-eas`, `mobile-ios-eas` (EAS cloud build) | `ubuntu-latest` | `boat`; the Android emulator runs with `/dev/kvm` (B2) |
| `build-desktop` linux, `nightly-desktop-linux` | `blacksmith-4vcpu-ubuntu-2204` | `boat` with `container: ubuntu:22.04`, keeping the glibc floor of the Linux build; check the built AppImage on the Laptop |
| `build-desktop` publish, `nightly-desktop-publish` | `blacksmith-4vcpu-ubuntu-2404` | `boat-small` |
| `publish`, `publish-nightly` (npmjs `sandy-app`) | `ubuntu-latest` | not moved: npm rejects provenance from self-hosted runners (`publish-sandy-app.yml:36`); switched off by Decision 12 anyway |
| `ci-cache-maintenance`, `close-stale-prs` | `ubuntu-latest` | `boat-small`, or removed (Decision 12) |
| `approve-contributor`, `pr-gate` | `ubuntu-latest` | removed (Decision 12) |
| Windows: 5 jobs in `ci.yml`, `fork-build-windows`, `build-desktop` windows, `nightly-desktop-windows` | `windows-2025`, `windows-latest`, `blacksmith-4vcpu-windows-2025` | stay; boat has no Windows (B6). Gated by Decision 12 |
| macOS: `build-desktop` macos, `nightly-desktop-macos`, `mobile-e2e` (iOS), `macos-15` matrix legs | `blacksmith-6vcpu-macos-15/27`, `macos-15` | stay; boat has no macOS (B6). Gated by Decision 12 |

## Decision 12: sandy becomes private (owner decided: "Sandy ist kein Fork mehr")

Facts from GitHub's docs (read 2026-11-12):
- [V1] "You cannot change the visibility of a fork by itself." Source: [About forks / visibility of forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/what-happens-to-forks-when-a-repository-is-deleted-or-changes-visibility).
- [V2] "Leave fork network" (Settings → Danger Zone) works only when the fork is public, smaller than 1 GB and has no child forks. All three hold for `nesyeklaf/sandy` (public, about 202 MB, 0 forks). The new standalone repository "will not retain any of its issues, pull requests, wikis, stars, watchers, comments, child forks, or other metadata", and leaving is permanent. The manual route (bare clone, delete, re-create, mirror push) also deletes pull requests. Source: [Detaching a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork).
- [V3] Making a repository private erases stars and watchers. On GitHub Free, features that need a paid plan stop working. Source: [Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
- [V4] GitHub Free for organizations includes $12 of Actions compute a month for private repositories. Standard GitHub-hosted runners are free only in public repositories. Rates per minute: Linux $0.006, Windows $0.010, macOS $0.062, so $12 covers about 2000 Linux, 1200 Windows or 190 macOS minutes. Source: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- [V5] Rulesets on private repositories need GitHub Team or Enterprise. A private repository on GitHub Free also loses protected branches (G6). Source: [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

Order, each step only after the one before succeeded:
1. **Export:** the owner archives issues, pull requests and their comments (`gh issue list --state all`, `gh pr list --state all`, `--json` with comments) and the 6 releases' metadata into a private location. Both detach routes may drop them (V2).
2. **Detach:** the owner asks GitHub Support to detach `nesyeklaf/sandy` from its fork network, and asks whether Support's detach keeps issues and pull requests. The docs do not describe Support's route (unverified). If Support cannot do it, use "Leave fork network" (V2) and accept losing the 35 issues and 32 pull requests on GitHub; the export from step 1 keeps them.
3. **Transfer** to `sandy-sdk/sandy` (Decision 9), then land the references and guards change (step 0c).
4. **Prepare** sandy for a private repository (step 0d), below.
5. **Go private:** the owner switches visibility. Stars and watchers are erased (V3); there are 0 stars.

Consequences and what step 0d changes:
- **Actions minutes (V4).** Every GitHub-hosted job now costs money. The Linux jobs move to boat (Decision 11), which bills by the second on its own plan. Blacksmith jobs bill Blacksmith, not GitHub (Blacksmith's price for private repositories is unchecked). The remaining GitHub-hosted minutes are the Windows jobs (`windows-2025` ×5 in `ci.yml`, `fork-build-windows` on `windows-latest`) and the `macos-15` legs of `package-smoke` and `node-compat-smoke`. Proposal:
  - run the Windows and macOS jobs only on `push` to `main`, on release tags, nightly, and by `workflow_dispatch`; pull requests run them only with a `ci:full` label or when files under `apps/desktop`, `packages/*/src/**/win*` or the platform helpers change;
  - drop the `macos-15` legs of `package-smoke` and `node-compat-smoke` to nightly only;
  - before step 5, measure the last 30 days of minutes per job (`gh api /repos/{repo}/actions/runs` timing, or the billing usage report) and set an Actions spending limit of $0, so an overrun stops jobs instead of billing.
- **Release downloads.** GitHub releases of a private repository need a login. The desktop app reads no update feed (observed state), so nothing installed breaks; only the download links in job summaries and docs do. Desktop builds stay as release assets for the owner, fetched with `gh release download`.
- **Raw registry URLs.** `https://raw.githubusercontent.com/sandy-sdk/sandy/<tag>/packages/plugin-registry/r/{name}.json` returns 404 without a token. That breaks `shadcn add @sandy/...` in the 9 plugins' `components.json` and in every plugin scaffolded by `sandy plugin new` (`plugin-scaffold.ts:740`, its test at `plugin-scaffold.test.ts:85`). Options:
  - (a) ship `packages/plugin-registry/r/` inside `@sandy-sdk/plugin-sdk` and point the registry at the installed copy;
  - (b) keep the URL and send a token header from `GITHUB_TOKEN`, if the shadcn CLI's per-registry `headers` support is confirmed (unverified).
  Recommendation (a): it needs no token and pins the registry to the installed SDK version. The plugin repository's `components.json` files are changed in the same way when they move.
- **Repository guards.** The 8 `github.repository` checks are updated in step 0c (Decision 9). Without that, the scheduled jobs are skipped without an error.
- **Contributor gates are moot.** Nobody without access can open a pull request on a private repository. Removed in step 0d:
  - `.github/workflows/pr-gate.yml`, `approve-contributor.yml`, `.github/APPROVED_CONTRIBUTORS`;
  - the `add-contributor` skill (`.sandy/skills/add-contributor`);
  - `close-stale-prs.yml` (optional, it only closes the owner's own PRs now);
  - the PR-template and `CONTRIBUTING.md` text for outside contributors.
  The owner uninstalls the CodeRabbit and SlopCop GitHub apps (CodeRabbit on private repositories is a paid plan). No repository file configures either.
- **npmjs `sandy-app`.** `publish` and `publish-nightly` would put sandy's built code on the public npm registry, which contradicts a private repository, and npm provenance does not come from private repositories (inferred from npm's provenance requirements, unverified). `sandy-app` has never been published (404). Both jobs are switched off in step 0d. The owner installs sandy from source with `scripts/fork/deploy.sh`, which is unaffected. If a packaged `sandy-app` is wanted later, it goes to GitHub Packages like the SDK.
- **Ruleset "Protecc" (V5).** It stops being enforced on a private repository in a Free organization. Either GitHub Team ($4 per user a month) keeps it, or the owner accepts no server-side protection on `main`, since he is the only author. Owner question.
- **Who is affected.** The owner is the only author, and one host (the Laptop) is enrolled. No outside user installs sandy from GitHub.

Checks:
- `git grep -n nesyeklaf/sandy` shows only history.
- `git grep -n raw.githubusercontent.com/sandy-sdk/sandy` is empty.
- `sandy plugin new demo` followed by a registry add works with no token.
- No workflow refers to `pr-gate` or `APPROVED_CONTRIBUTORS`.
- After step 5: an unauthenticated request for the repository returns 404, and the next `ci.yml` run is green on boat plus the gated GitHub-hosted jobs.

## Owner steps (org, registry, CI, visibility)

Only the owner does these. The agent creates no organization, repository, app installation or token, changes no visibility, and publishes nothing.

1. Export issues, pull requests and release metadata of `nesyeklaf/sandy` (Decision 12, step 1).
2. Ask GitHub Support to detach `nesyeklaf/sandy` from its fork network, or use "Leave fork network" (Decision 12, step 2).
3. Create the free organization `sandy-sdk`.
4. Transfer the repository to `sandy-sdk/sandy`. Never re-create `nesyeklaf/sandy`.
5. Start the boat $20 plan, and install the boat CI app on `sandy-sdk` (`boat ci connect --org sandy-sdk`, or "Boat CI for orgs") for `sandy` and `sandy-plugins`.
6. Set the Actions spending limit of `sandy-sdk` to $0 (Decision 12).
7. Uninstall the CodeRabbit and SlopCop apps from the repository.
8. After the step 0d change is merged, make `sandy-sdk/sandy` private.
9. Create the private `sandy-sdk/sandy-plugins` (task 4.4).
10. Approve the first run of `publish-sdk.yml` and check the first-publish catches (Decision 3).
11. For each dev host, create a classic PAT with only `read:packages` and put it in `~/.npmrc`, not in pi-setup's tracked files.

## Open questions for the owner

Answered on 2026-11-12: organization `sandy-sdk` with the scope following it (no rename); `sandy-sdk/sandy` and `sandy-sdk/sandy-plugins`; pi/fabric moves to pnpm; nothing else is renamed; boat for the plugin repository and sandy's Linux jobs; publisher P1 for now; sandy becomes private.

Still open:
1. Detach route: GitHub Support (asked first) or "Leave fork network", which loses the 35 issues and 32 pull requests on GitHub (Decision 12)?

[Showing lines 1-414 of 419 (50.0KB limit). Use offset=415 to continue.]