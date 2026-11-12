# Tasks

The spec is all this change delivers. Every task that creates or changes a repository, pushes, publishes, deploys, or changes installed plugins or pi-setup needs the owner's explicit OK first. Run tests and builds serially (`VITEST_MAX_WORKERS=1`, `--concurrency=1`).

## 1. Decisions
- [x] 1.1 Owner answers: standalone OpenSpec, new private repository, publish the SDK, registry GitHub Packages private, core `--replace-source` in scope, re-point the aemon installs, holons move, pnpm for all plugins.
- [x] 1.2 Owner answers: organization `sandy-sdk` with the scope following it (no rename), `sandy-sdk/sandy` and `sandy-sdk/sandy-plugins`, pi/fabric to pnpm, boat for the plugin repository and sandy's Linux jobs, publisher P1, sandy private.
- [ ] 1.2b Owner answers design.md open questions 1–5; record them in proposal.md Approval State.
- [ ] 1.3 Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/`; verify with `git branch -r --no-merged main` and `git diff --stat main...<branch> -- extensions` per branch.

## 1b. Organization, transfer, private sandy
- [ ] 1.4 Owner: export issues, pull requests and release metadata of `nesyeklaf/sandy`; verify the export counts (35 issues, 32 pull requests, 6 releases on 2026-11-12) against the search API.
- [ ] 1.5 Owner: detach from the fork network through GitHub Support, or "Leave fork network" (design.md, Decision 12); verify `gh api repos/nesyeklaf/sandy --jq .fork` returns `false`.
- [ ] 1.6 Owner: create `sandy-sdk`, transfer to `sandy-sdk/sandy`, start the boat plan, install the boat CI app on `sandy-sdk`, set the Actions spending limit to $0, uninstall CodeRabbit and SlopCop; verify `git ls-remote git@github.com:sandy-sdk/sandy.git` and that the old URL redirects.
- [ ] 1.7 Sandy change (step 0c): the 8 `github.repository` guards first, then the 88 `nesyeklaf/sandy` references and `check-egress-hosts.sh`; update local remotes; verify `git grep -n nesyeklaf/sandy` shows history only, and the next scheduled `ci-health` run is not skipped.
- [ ] 1.8 Sandy change (step 0d, Decision 12): plugin registry inside `@sandy-sdk/plugin-sdk` (or the owner's choice) for `plugin-scaffold.ts` and the 9 `components.json`; remove `pr-gate`, `approve-contributor`, `APPROVED_CONTRIBUTORS` and the `add-contributor` skill; switch off the npmjs `publish`/`publish-nightly` jobs; the SDK `publishConfig` and the npmjs `publish-plugin-sdk` job and guard (Decision 10); Linux jobs to the boat labels and Windows/macOS jobs gated (Decision 11, Decision 12); new perf baseline. Verify `sandy plugin new demo` plus a registry add with no token, the template tests via turbo, and one green `ci.yml` run on boat.
- [ ] 1.9 Before going private: measure the last 30 days of GitHub-hosted minutes per job and record the estimated monthly cost after gating in design.md.
- [ ] 1.10 Owner: make `sandy-sdk/sandy` private; verify an unauthenticated request returns 404, the server host still fetches over SSH, and `scripts/fork/deploy.sh` deploys.

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
  - pi/fabric fully on pnpm and vitest: remove `bun.lock` and every `bun` call; verify `git grep -n -E "\\bbun\\b|Bun\\." -- pi/fabric` is empty and its tests pass;
  - the SDK as an optional peer plus the root devDependency, unchanged `@sandy-sdk/plugin-sdk` imports, and the scope-only `.npmrc` (bridge: `scripts/sdk.sh --local`);
  - drop the `sandy-app` devDependency;
  - `skill-dialect` by relative import;
  - `check-git-install.mjs`, `release.mjs`, `compat.json`, and CI with the `runs-on` labels of design.md Decision 11.
  Verify `pnpm install --frozen-lockfile`, then every unit's tests, `check-git-install.mjs` and `sandy plugin build`, serially.
- [ ] 4.3 Holon move: `sandy-plugins.holon`, re-parented plugin holons, `openspec/specs/holon-*` re-exported; verify `holon check` and `openspec validate --all --strict` in the scratch clone.
- [ ] 4.4 Owner OK: create the private repository, push, add the server host's deploy key, CI green, tag the current versions of all units and the pi train.
- [ ] 4.5 Owner OK: run `publish-sdk.yml` (on `boat`) for the owner's sandy tag with `GITHUB_TOKEN`; verify that the package page shows Private and is linked to `sandy-sdk/sandy-plugins`, that an unauthenticated `npm view @sandy-sdk/plugin-sdk` fails, and that CI installs with `GITHUB_TOKEN` only; then switch the root devDependency from the bridge to the registry range.
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
