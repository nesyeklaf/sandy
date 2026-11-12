# Tasks

Spec only in this change. Every task that creates or changes a repository, pushes, publishes, unarchives, or changes installed plugins or pi-setup needs the owner's explicit OK first. Run tests and builds serially (`VITEST_MAX_WORKERS=1`, `--concurrency=1`).

## 1. Decisions
- [ ] 1.1 Owner answers the open questions in design.md (name, visibility, Holon gate, SDK publishing, phase 2, aemon sources); record the answers in proposal.md Approval State.
- [ ] 1.2 Freeze: `sidebar-spaces` and `space-coordination` finished or merged; no open branch touches `extensions/`; verify with `git branch -r --no-merged main` and `git diff --stat main...<branch> -- extensions` per branch.

## 2. Spikes (staging instance, serial)
- [ ] 2.1 Install one unit from a test tag with `--subdirectory sandy/<unit> --tag-prefix <unit>-v` and a semver range; verify `sandy plugin source <id>` shows the resolved tag, and `sandy plugin outdated` sees a newer test tag.
- [ ] 2.2 Git-install `skill-usecases` with `@sandy/skill-dialect` as `file:../../packages/skill-dialect`; verify the server bundle builds and the plugin runs. Otherwise switch to vendoring at release.
- [ ] 2.3 `pi install` the repository root as a pi package from a test ref into a scratch `PI_AGENT_DIR`; verify pi/work (with goal deps), pi/context, pi/permissions and the lifecycle extension load.

## 3. Decouple in place (sandy branch)
- [ ] 3.1 Replace the `file:` SDK devDependency in all 19 units with an optional peer range at each unit's `engines.sandyPluginSdk` floor; add `extensions/scripts/sdk.sh`; verify each unit's tests and `sandy plugin build` serially.
- [ ] 3.2 Drop the `sandy-app` devDependency from sandy-sidebar-delegate; the e2e script takes `--app`; verify `npm run check`.
- [ ] 3.3 Prepare `scripts/release.mjs`, `scripts/compat.mjs`, `compat.json` and the CI workflow under `extensions/`; verify the release script dry run on one unit.

## 4. Build the repository (scratch clone)
- [ ] 4.1 `git filter-repo` with path renames and message callback, graft onto `plugins@a924aa4f` (or new root per 1.1); verify the history checks in the spec.
- [ ] 4.2 Owner OK: unarchive or create, push, CI green, tag current versions of all units and the pi train.

## 5. Switch sources (live host, one unit at a time)
- [ ] 5.1 Check out the plugin repository on the server host; build units with `scripts/build.sh`.
- [ ] 5.2 Re-point SANDY path sources in the order in design.md; verify after each `sandy plugin source <id>` and the status `running`; roll back on failure.
- [ ] 5.3 pi-setup change: `links.tsv` and `settings/base.json` to the plugin checkout, `node apply.mjs <host>`; verify the pi tool inventory matches the pre-switch list.
- [ ] 5.4 Resolve the disabled `/home/aemon/...` sources per 1.1.

## 6. Remove from sandy (separate change)
- [ ] 6.1 After one soak cycle, remove `extensions/` and `packages/skill-dialect`, and update README, docs/configuration.md, docs/designs, `scripts/fork/*-exceptions.tsv`, `scripts/perf/render-attribution/run.sh`, `scripts/migrate-from-bb.mjs`, AGENTS.md and the Holon model per 1.1; verify sandy CI and `grep -rn "extensions/sandy\|extensions/pi"` outside history.

## 7. Optional
- [ ] 7.1 Core `--replace-source` for path→git with CLI guide, SDK and UI parity; or the owner's chosen alternative.
- [ ] 7.2 Owner updates `master-repo/docs/maps/private.md` lines 13, 19 and 20 as listed in design.md, "Owner's map".
