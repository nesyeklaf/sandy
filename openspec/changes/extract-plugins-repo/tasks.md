# Tasks

The spec is all this change delivers. Every task that creates or changes a repository, pushes, publishes, deploys, or changes installed plugins or pi-setup needs the owner's explicit OK first. Run tests and builds serially (`VITEST_MAX_WORKERS=1`, `--concurrency=1`).

## 1. Decisions
- [x] 1.1 Owner answers: standalone OpenSpec, new repository (visibility later changed to public), publish the SDK (registry later changed to npmjs), core `--replace-source` in scope, re-point the aemon installs, holons move, pnpm for all plugins.
- [x] 1.2 Owner answers (last version): organization `sandyhq` with the npm scope following it, so the SDK is renamed to `@sandyhq/plugin-sdk`; `sandyhq/sandy` and `sandyhq/sandy-plugins` both new and public; `nesyeklaf/sandy` kept, not archived, `desktop-v*` releases stay there; SDK public on npmjs; boat only for the owner's own content; pi/fabric to pnpm.
- [x] 1.2b Owner decided Blacksmith: GitHub-hosted labels (design.md, Decision 11); recorded in proposal.md Approval State.
- [ ] 1.3 Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/`; verify with `git branch -r --no-merged main` and `git diff --stat main...<branch> -- extensions` per branch.

## 1b. Organization, new sandy repository, cutover
- [ ] 1.4 Owner: close #37, #29, #23 and #2 on `nesyeklaf/sandy` (done; their branches `feat/context-release-rework`, `feat/14-android-push`, `bb/bb-features-und-plugins-als-clips-pr-sentieren-thr_6623n9ubwp`, `perf/trace` stay there), merge or close any other open pull request, and freeze `main`; verify `gh pr list -R nesyeklaf/sandy --state open` is empty.
- [x] 1.5a Owner: GitHub organization `sandyhq` (free plan), empty public non-fork `sandyhq/sandy` and `sandyhq/sandy-plugins`, npm organization `sandyhq`, `gh` scopes `admin:org`, `workflow`, `repo`, boat approved on the organization.
- [ ] 1.5 Owner: push `main`, all tags and the four pull-request branches of 1.4 from a fresh bare clone to `sandyhq/sandy` (design.md, Decision 9); verify `gh api repos/sandyhq/sandy --jq .fork` is `false` and `git ls-remote` shows the same `main` sha, tags and four branch shas on both repositories.
- [ ] 1.6 Owner: re-create environment `npm-release`, secrets, variables, ruleset, fork-PR approval and apps on `sandyhq/sandy`; boat allow-list `boat ci public sandyhq on --users nesyeklaf`; verify a `workflow_dispatch` of `ci-health` by the owner runs.
- [ ] 1.7 Sandy cutover change on `sandyhq/sandy` (Decision 12): guards, runtime URLs, `plugin-scaffold.ts` registry URL, package metadata, `check-egress-hosts.sh`, `runs-on` routing plus `scripts/check-runs-on.mjs` (Decision 11), Blacksmith labels replaced by GitHub-hosted ones (`macos-15`, `windows-2025`, `ubuntu-*`; perf baseline re-recorded, Windows `diskpart` step checked), the SDK rename to `@sandyhq/plugin-sdk` by codemod with legacy specifiers, version guard, scaffold, migrate and `check-plugin-sdk-scope.mjs` (Decision 10), SDK package metadata (Decision 3). Verify the Decision 10 tests (an old-name fixture plugin loads; `sandy plugin migrate`; the guard's 404 case), the Decision 12 checks, the template tests via turbo serially, `check-runs-on.mjs`, one owner push running on boat, and one pull request from a test fork running only on GitHub-hosted runners.
- [ ] 1.8 Owner: switch `~/projects/sandy`, `~/projects/private/gh/sandy` and the managed worktrees to the new remote; verify `scripts/fork/deploy.sh` deploys from it.
- [ ] 1.9 Owner: disable Actions on `nesyeklaf/sandy` and add the "moved" note; keep the repository unarchived; verify no new workflow runs there, and an old `nesyeklaf/sandy` registry URL still returns 200.

## 2. Spikes (staging instance, serial; ask the orchestrator for the slot)
- [ ] 2.1 Install one unit from a test tag with `--subdirectory sandy/<unit> --tag-prefix <unit>-v` and a semver range; verify `sandy plugin source <id>` shows the resolved tag and `sandy plugin outdated` sees a newer test tag.
- [ ] 2.2 Git-install `skill-usecases` importing `skill-dialect` by relative source path, with its runtime deps in `dependencies`; verify the server bundle builds and the plugin runs.
- [ ] 2.3 `pi install` the repository root as a pi package from a test ref into a scratch `PI_AGENT_DIR`; verify pi/work (with goal deps), pi/context, pi/permissions and the lifecycle extension load.
- [ ] 2.4 Git install from the public repository over HTTPS on the server host with no key; verify install and `sandy plugin outdated` work.
- [ ] 2.5 Holon: a scratch plugin root with `field-latency`, `holon-genui` and `holon-extension` re-parented; verify `holon check` passes in it and in sandy.

## 3. Core `--replace-source` (sandy branch)
- [ ] 3.1 Contract: `replaceSource` on `pluginInstallRequestSchema` and the `source` install job target, default filled at the server boundary; verify the server-contract typecheck via turbo.
- [ ] 3.2 Server: staged replace in registration and artifact services, keeping settings, secrets, schedules, data and enabled state; the path move routed through it; verify server tests on `createMigratedConnection()` for path → git, git → path, build failure, engine mismatch, id mismatch, builtin refusal.
- [ ] 3.3 SDK client, CLI flag with confirmation, Settings → Installed plugins → Change source; verify one contract table run against CLI and SDK, and a UI test for the dialog.
- [ ] 3.4 Guide: replace the remove-and-reinstall text in `sandy-guide-plugins.md`, and check the surfaces in `docs/cli-guide-and-skill.md`; verify the templates build via turbo.
- [ ] 3.5 Owner OK: release and deploy with `scripts/fork/deploy.sh` under `systemd-run --user`; verify on staging that path → git → path keeps a plugin's settings.

## 4. Build the repository (scratch clone)
- [ ] 4.1 `git filter-repo` with path rename and `#N` message callback; verify the history checks in the spec.
- [ ] 4.2 On top, as separate commits:
  - the pnpm workspace (delete every `package-lock.json`; fold `sandy/holon`'s workspace into the root);
  - pi/fabric fully on pnpm and vitest: remove `bun.lock` and every `bun` call; verify `git grep -n -E "\\bbun\\b|Bun\\." -- pi/fabric` is empty and its tests pass;
  - the SDK as an optional peer plus the root devDependency, `@sandyhq/plugin-sdk` imports only (already rewritten in sandy before the filter, Decision 10; `check-plugin-sdk-scope.mjs` with an empty allow-list), no `.npmrc` (bridge: `scripts/sdk.sh --local`);
  - drop the `sandy-app` devDependency;
  - `skill-dialect` by relative import;
  - `check-git-install.mjs`, `release.mjs`, `compat.json`, and CI with the `runs-on` labels of design.md Decision 11.
  Verify `pnpm install --frozen-lockfile`, then every unit's tests, `check-git-install.mjs` and `sandy plugin build`, serially.
- [ ] 4.3 Holon move: `sandy-plugins.holon`, re-parented plugin holons, `openspec/specs/holon-*` re-exported; verify `holon check` and `openspec validate --all --strict` in the scratch clone.
- [ ] 4.4 Owner OK: create the public repository with fork-PR approval on, push, CI green (`check-runs-on.mjs` included), tag the current versions of all units and the pi train.
- [ ] 4.5 Owner OK: publish `@sandyhq/plugin-sdk` once by hand with `--access public` from `sandyhq/sandy` after the cutover, add the trusted publisher (`sandyhq/sandy`, `publish-sandy-app.yml`, environment `npm-release`); verify `npm view @sandyhq/plugin-sdk` works without login, the next release publishes with provenance from `sandyhq/sandy`, and the plugin repository's CI installs it with no secret; then switch the root devDependency from the bridge to the npm range.

## 5. Switch sources (live host, one unit at a time)
- [ ] 5.1 Check out `sandy-plugins` on the server host and build with `scripts/build.sh`.
- [ ] 5.2 Phase 1: re-point SANDY path sources in the order in design.md, then the four disabled `/home/aemon/...` installs; verify after each `sandy plugin source <id>` and the status; roll back on failure.
- [ ] 5.3 pi-setup change: `links.tsv` and `settings/base.json` to the checkout, `node apply.mjs <host>`; verify the pi tool inventory matches the pre-switch list.
- [ ] 5.4 Phase 2: `--replace-source` to git sources in the same order; verify `sandy plugin source <id>` shows git and the resolved tag, and the settings are kept.

## 6. Remove from sandy (separate change)
- [ ] 6.1 After one soak cycle, remove `extensions/` and `packages/skill-dialect`, and update:
  - README, `docs/configuration.md`, `docs/designs`;
  - `scripts/fork/*-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`;
  - `sandy.holon` and the moved `openspec/specs/holon-*`;
  - the AGENTS.md exception.
  Verify sandy CI and `grep -rn "extensions/sandy\|extensions/pi"` outside history.

## 7. Owner
- [ ] 7.1 Owner updates `master-repo/docs/maps/private.md` (lines 13, 19, 20, a new `gh/sandy-plugins` row, line 86) as listed in design.md, "Owner's map".
