# Tasks

The spec is all this change delivers. Every task that creates or changes a repository, pushes, publishes, deploys, or changes installed plugins or pi-setup needs the owner's explicit OK first. Run tests and builds serially (`VITEST_MAX_WORKERS=1`, `--concurrency=1`).

## 1. Decisions
- [x] 1.1 Owner answers: standalone OpenSpec, new private repository, publish the SDK, registry GitHub Packages private, core `--replace-source` in scope, re-point the aemon installs, holons move, pnpm for all plugins.
- [ ] 1.2 Owner names `<org>`, confirms the scope `@<org>` and the repository name, answers design.md open questions 4–6; replace every `<org>` in this change and record the answers in proposal.md Approval State.
- [ ] 1.3 Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/`; verify with `git branch -r --no-merged main` and `git diff --stat main...<branch> -- extensions` per branch.

## 1b. Organization, transfer, rename (sandy)
- [ ] 1.4 Owner: create `<org>`, transfer `nesyeklaf/sandy`, start the boat plan and install the boat CI app on `<org>` (design.md, Owner steps); verify that `git ls-remote` works on the new URL and the old URL redirects.
- [ ] 1.5 Sandy change: replace `nesyeklaf/sandy` with `<org>/sandy` (runtime URLs, docs, workflows, templates); update local remotes and pi-setup git sources; verify with `git grep -l nesyeklaf/sandy` (history only) and the affected app and template tests via turbo.
- [ ] 1.6 Sandy change: rename to `@<org>/plugin-sdk` (Decision 10); keep `@sandy-sdk/plugin-sdk` and `@sandy/plugin-sdk` as legacy specifiers in plugin-runtime, runtime-shims, the host fallback and the package-name checks; extend `sandy plugin migrate`; regenerate bundled-types with an old-name re-export; Plugin Guide and docs; remove the npmjs `publish-plugin-sdk` job and `check-npm-version-guard.mjs`; add the stale-name ratchet. Verify a fixture plugin with old imports (server, host, app) loads, `sandy plugin new` scaffolds the new name, `sandy plugin migrate` rewrites an old plugin, and the ratchet passes. Run checks via turbo serially.
- [ ] 1.7 Owner OK: release and deploy the rename; verify every installed plugin is `running` afterwards without a rebuild.

## 2. Spikes (staging instance, serial; ask the orchestrator for the slot)
- [ ] 2.1 Install one unit from a test tag with `--subdirectory sandy/<unit> --tag-prefix <unit>-v` and a semver range; verify `sandy plugin source <id>` shows the resolved tag and `sandy plugin outdated` sees a newer test tag.
- [ ] 2.2 Git-install `skill-usecases` importing `skill-dialect` by relative source path, with its runtime deps in `dependencies`; verify the server bundle builds and the plugin runs.
- [ ] 2.3 `pi install` the repository root as a pi package from a test ref into a scratch `PI_AGENT_DIR`; verify pi/work (with goal deps), pi/context, pi/permissions and the lifecycle extension load.
- [ ] 2.4 Git install from a private repository over SSH on the server host (read-only deploy key); verify install and `sandy plugin outdated` work, or name the source form sandy needs.
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
  - the SDK as an optional peer plus the root devDependency, `@<org>/plugin-sdk` imports (from the rename commit in sandy), and the scope-only `.npmrc` (bridge: `scripts/sdk.sh --local`);
  - drop the `sandy-app` devDependency;
  - `skill-dialect` by relative import;
  - `check-git-install.mjs`, `release.mjs`, `compat.json`, and CI with the `runs-on` labels of design.md Decision 11.
  Verify `pnpm install --frozen-lockfile`, then every unit's tests, `check-git-install.mjs` and `sandy plugin build`, serially.
- [ ] 4.3 Holon move: `sandy-plugins.holon`, re-parented plugin holons, `openspec/specs/holon-*` re-exported; verify `holon check` and `openspec validate --all --strict` in the scratch clone.
- [ ] 4.4 Owner OK: create the private repository, push, add the server host's deploy key, CI green, tag the current versions of all units and the pi train.
- [ ] 4.5 Owner OK: run `publish-sdk.yml` (on `boat`) for the owner's sandy tag with `GITHUB_TOKEN`; verify that the package page shows Private and is linked to `<org>/sandy-plugins`, that an unauthenticated `npm view @<org>/plugin-sdk` fails, and that CI installs with `GITHUB_TOKEN` only; then switch the root devDependency from the bridge to the registry range.
- [ ] 4.6 Owner: classic PAT `read:packages` in `~/.npmrc` on each dev host (design.md, Owner steps); verify `pnpm install --frozen-lockfile` in a fresh local clone.

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
