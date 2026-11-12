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
| Holon: `sandy.holon` lists `extensions/sandy/` as code. 7 `.holon` files sit in genui, holon and field-latency. `openspec/specs/holon-*` are exported from them | `git ls-files '*.holon'` |
| Sandy files that name `extensions/`: `README.md`, `docs/configuration.md`, `docs/designs/skill-authoring-in-flow-editor.md`, `scripts/fork/package-manager-exceptions.tsv`, `scripts/fork/egress-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`, `AGENTS.md` (sidebar-spaces exception), and the open changes `sidebar-spaces` and `space-coordination` | grep |
| The owner's map in the master repository names the old plugins repo. It was not found in local `mastervault` or `ecosystem` | grep, unresolved |

## Decision 1: repository name and origin

- **Revive `nesyeklaf/plugins` (recommended).** Unarchive it and fast-forward `main` to a graft. The graft takes the filtered sandy history of `extensions/` and puts it on top of `plugins@a924aa4f`, with the "files only" move as the joining commit. One repository then has the whole history: the forks' kept history, the bb era and the sandy era. The owner's map stays correct. Costs: unarchiving is an external change that needs the owner's OK; old issue and PR numbers continue; the joining commit deletes `bb/*` and the dropped units (they stay in history).
- **New `nesyeklaf/sandy-plugins`.** A clean name with no archive to undo. History only from 2026-10-31. Pre-move history stays in an archived repository. The owner's map needs an edit.

## Decision 2: repository shape

| | A. Monorepo of plugins (recommended) | B. One repository per plugin |
| --- | --- | --- |
| Install source | `git:github.com/nesyeklaf/plugins@^0.3 --subdirectory sandy/genui --tag-prefix genui-v` | `git:github.com/nesyeklaf/sandy-plugin-genui@^0.3` |
| Versioning | per-unit semver, per-unit tags `<unit>-v<x.y.z>`; pi train `pi-v<x.y.z>` | one semver and plain `v<x.y.z>` tags per repo |
| Shared code | `pi/work` imports `sandy/work/delegate/shared` unchanged; `packages/skill-dialect` is one internal package | shared code must be published or copied; skill-dialect becomes its own package |
| Paired units (`work`+`pi/work`, `permissions`+`pi/permissions`, `pi-lifecycle`) | one commit and one PR changes both sides | coordinated releases across repos |
| pi delivery | one pi package at the root (`pi` manifest), one git source | five pi packages, one per repo, or local paths |
| CI | one workflow, matrix over changed units | 25 copies of CI to keep in step |
| Blast radius | a bad merge can touch many units; per-unit tags still pin installs | isolated by repository |
| Upstream forks (genui, BB forks) | `UPSTREAM.md` per unit, as today | a fork per repository is easier to sync with upstream |

The reason for A is that the units are already coupled: shared source, paired protocols, and one pi entry point. Sandy's git source already resolves a per-unit tag inside one repository. B would buy isolation the owner does not need for one-person plugins, and in exchange add 25 places to keep CI, scripts and the SDK pin in step. Cheapest check that would disprove A: install one unit from a test tag with `--subdirectory` and `--tag-prefix` on the staging instance (task 2.1). If sandy cannot resolve a prefixed tag in a subdirectory, B or a tag-per-repo variant wins.

## Target layout (option A)

```
plugins/                      repository root (today's extensions/)
  sandy/<unit>/               19 sandy plugins, paths unchanged
  pi/<unit>/                  5 pi extensions, paths unchanged
  packages/skill-dialect/     moved from sandy; only these units use it
  scripts/                    build.sh, install-pi.sh, install-sandy.sh, lib.sh, sdk.sh, release.mjs, compat.mjs
  package.json                private root; "pi" manifest = the pi package (pi/context, pi/work, pi/permissions,
                              sandy/pi-lifecycle/pi-extension.ts, autopilots); version = pi train
  compat.json                 sandy and SDK versions each unit release was tested against
  .github/workflows/          ci.yml, release.yml
  AGENTS.md, README.md        working rules from extensions/README.md, plus the release rules
```

Holon models (`*.holon` in genui, holon, field-latency) move with their code. Whether the plugin repository gets its own Holon root and OpenSpec export depends on the owner's answer on the Holon gate (Open Question 3).

## Decision 3: dependency decoupling

- **SDK.** The SDK is a devDependency only: sandy externalises the bare specifier and builds git installs with its own toolchain. So decoupling affects development and CI, not the runtime.
  - Bridge (no external action): replace the `file:` devDependency with `peerDependencies: {"@sandy-sdk/plugin-sdk": "^<floor>"}` plus `peerDependenciesMeta.optional`. Npm then neither fetches it nor fails on the 404. `scripts/sdk.sh <sandy-ref|checkout>` builds and packs the SDK from a sandy release tag and installs it with `--no-save`, the method `extensions/README.md` already uses for tests.
  - Target (owner's OK to publish): bootstrap `@sandy-sdk/plugin-sdk` on npm through the existing job, then use a normal devDependency range.
- **sandy-app** (sidebar-delegate e2e): drop the dependency. The e2e harness takes `--app <dir>`. CI passes the `sandy-app` package it built from the pinned sandy ref.
- **skill-dialect.** Moves to `packages/skill-dialect` in the plugin repository. `skill-usecases` needs it at runtime, and a git install runs `npm install --omit=dev` inside the subdirectory of a full checkout, so `file:../../packages/skill-dialect` has to resolve there. Task 2.2 verifies this. If it fails, `skill-usecases` vendors a built copy into its own directory at release time.
- **Compatibility.**
  - `engines.sandy` and `engines.sandyPluginSdk` stay the contract sandy enforces.
  - `compat.json` records, per unit release, the sandy tag and SDK version the release was tested against.
  - CI runs each changed unit against the sandy release the owner runs (blocking) and sandy `main` (nightly, reports only), so an SDK change shows up before a sandy upgrade.
  - Raising an `engines` floor is a minor release of the unit.

## Decision 4: versioning, release, CI

- Per-unit semver in its `package.json`; sandy shows this version and `sandy plugin outdated` compares against it.
- Tags: `<unit>-v<x.y.z>` for sandy plugins (unit = directory name). The pi train is `pi-v<x.y.z>` from the root `package.json`, because pi pins one ref per git repository.
- Paired units release from the same commit: `work` with `pi/work`, `permissions` with `pi/permissions`, `pi-lifecycle` with the pi train. Release notes name the pair.
- `scripts/release.mjs <unit>`:
  1. refuses a version already tagged and a dirty tree;
  2. runs the unit's check and tests serially;
  3. runs `sandy plugin build` against the pinned SDK;
  4. writes the `compat.json` entry;
  5. creates an annotated tag.
  The push and the GitHub release are separate steps that need the owner.
- CI on pull requests selects changed units (a change to `scripts/`, `packages/` or `compat.json` selects all). Per unit it runs `npm ci`, `scripts/sdk.sh`, `npm test`, `sandy plugin build`. pi/fabric uses bun as today. Tests run serially (`VITEST_MAX_WORKERS=1`).

## Decision 5: install and update afterwards

- **Phase 1, path sources (keeps state).**
  - A checkout of the plugin repository sits on the server host (proposed `~/projects/private/gh/plugins`, the existing local clone, fast-forwarded to the graft).
  - `sandy plugin install path:<checkout>/sandy/<unit>` moves each installed id and keeps its configuration.
  - Updates: `git pull` plus `scripts/build.sh <unit>` plus `sandy plugin reload <id>`. This is what happens today, from a different directory.
- **Phase 2, git sources (needs core support or the owner's OK to lose state).**
  - Source: `git:github.com/nesyeklaf/plugins@^<major.minor> --subdirectory sandy/<unit> --tag-prefix <unit>-v`.
  - Updates: `sandy plugin outdated` / `update` / Settings, Updates.
  - A private repository needs read credentials on the sandy host (Open Question 2).
- **pi.**
  - pi-setup is the only writer of `~/.pi/agent`. Its `links.tsv` and `settings/base.json` switch from `projects/sandy/extensions/...` to the plugin checkout, applied with `node apply.mjs <host>`.
  - Later, if task 2.3 shows pi installs the root package with `pi/work/goal`'s dependencies, a single `git:github.com/nesyeklaf/plugins@pi-v<x.y.z>` package replaces the local paths.
  - `extensions/scripts/install-pi.sh` stays only as a bootstrap for hosts without pi-setup.

## Decision 6: path-to-git switch without losing state

Sandy refuses to replace a path source with a git source except by `remove`, and `remove` deletes settings, secrets and schedules. Phase 2 therefore needs one of these:
- (a) **Recommended:** a core change, `sandy plugin install git:... --replace-source` for an id already installed from a path. It keeps settings, secrets, schedules and data, like the path move does. This is sandy core work with CLI guide, SDK and UI parity (AGENTS.md "CLI And Plugin API", `docs/cli-guide-and-skill.md`). No new plugin API member is needed, so `docs/api_to_audit.md` is unaffected.
- (b) Per plugin: export settings, then remove, install and re-enter. Acceptable for plugins without secrets or schedules.

Phase 1 alone already meets the owner's goal: releases happen in their own repository with tags, and sandy no longer carries the code.

## Decision 7: history preservation

- **`git filter-repo` (recommended).**
  1. Run in a fresh clone of `nesyeklaf/sandy` in a scratch directory, never in a working checkout: `git filter-repo --path extensions/ --path packages/skill-dialect/ --path-rename extensions/:`.
  2. A message callback rewrites `#N` to `nesyeklaf/sandy#N` so PR references keep pointing at sandy.
  3. Graft the root of the result onto `plugins@a924aa4f` (`git replace --graft` then `git filter-repo --force` to bake it).
  Checks:
  - the commit count on `extensions/` in sandy equals the filtered count;
  - the new HEAD tree equals sandy's `extensions/` tree plus `packages/skill-dialect`;
  - `git log --follow` on a sample file reaches back past 2026-10-31.
- **`git subtree split --prefix=extensions`.** Built into git and needs no rewrite tooling. But it handles one prefix only (skill-dialect's history is lost), is slow on sandy's history, and leaves `#N` references pointing at the wrong repository. Rejected.

## Migration order

Every step keeps the installed plugins running, and each step can be rolled back.

| Step | What | Check | Rollback |
| --- | --- | --- | --- |
| 0 | Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/` | `git branch -r --contains` / open PRs list | none needed |
| 1 | Decouple in place in sandy: optional SDK peer + `scripts/sdk.sh`, drop `sandy-app` devDep, skill-dialect path prepared | every unit's tests and `sandy plugin build` pass serially; installed plugins unchanged | revert the commit |
| 2 | Build the history (scratch clone) and spikes 2.1–2.3 on the staging instance | Decision 7 checks; spike verdicts | delete the scratch clone |
| 3 | Owner OK: unarchive or create the repository, push, CI green, first tags at current versions | tags exist; CI green | archive again / delete the tags; sandy is untouched |
| 4 | Switch SANDY path sources to the new checkout, low-risk units first (thread-namer, value, field-latency, compact-composer, codex-voice, files-editor), then genui, holon, skill-usecases, sandy-sidebar-delegate, pi-lifecycle, then permissions and work together with step 5 | `sandy plugin source <id>` shows the new path; plugin `running`; settings present | `sandy plugin install path:~/projects/private/gh/sandy/extensions/sandy/<unit>` (move back, keeps settings) |
| 5 | pi-setup switches `links.tsv` and `settings/base.json` to the checkout; `node apply.mjs <host>` | `pi list`, the tool inventory shows the same tools (track guard, tasks, notebook, history_search, permissions) | revert the pi-setup commit, apply again |
| 6 | Disabled `/home/aemon/...` sources: owner chooses re-point or remove | `sandy plugin list --json` has no source into the sandy tree | n/a |
| 7 | Soak: one sandy deploy and one plugin release cycle on the new sources | no source points into `sandy/extensions` | steps 4–5 rollback |
| 8 | Separate sandy change: remove `extensions/` and `packages/skill-dialect`, update README, docs, exception lists, perf harness (takes a plugin checkout path), `migrate-from-bb.mjs` references, `sandy.holon` code list, holon models and `openspec/specs/holon-*`, AGENTS.md exception | sandy CI green; `grep -r extensions/` only in history | revert the removal commit; sources still point at the plugin checkout |
| 9 | Optional phase 2 (Decision 6) | `sandy plugin outdated` lists the units | reinstall the path source |
| 10 | The owner updates his master-repo map | owner | n/a |

## Risks

- **Two checkouts drift.** SANDY reads `~/projects/private/gh/sandy` and pi reads `~/projects/sandy` today. The migration points both at one plugin checkout per host, and the README says which.
- **A git install cannot resolve skill-dialect** (task 2.2). Fallback: vendor it at release time.
- **pi's git package install skips the nested `pi/work/goal` dependencies** (task 2.3). Fallback: keep local paths.
- **History rewrite mistakes.** The work runs in a scratch clone; the trees are compared before anything is pushed.

## Open questions for the owner

1. Revive `nesyeklaf/plugins` (recommended) or create `nesyeklaf/sandy-plugins`?
2. Keep the repository private (the sandy host needs a read credential for git sources) or make it public like sandy?
3. Holon: standalone OpenSpec without the Holon gate for this change? And do the plugin holons (genui, holon, field-latency) move into the plugin repository's own Holon root, or stay modeled in sandy's?
4. Publish `@sandy-sdk/plugin-sdk` to npm (bootstrap the existing job), or stay on the packed-tarball bridge?
5. Phase 2 git sources: build `--replace-source` in core (recommended), or accept losing settings per plugin, or stay on path sources?
6. The four disabled `/home/aemon/...` installs: re-point or remove?
