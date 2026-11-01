# workflows-plus upstream sync (slice 16)

workflows-plus is a fork of nesyeklaf/sandy `plugins/workflows` (MIT). This file records
which upstream changes it carries. The dry run that chose the base and target is
[UPSTREAM-dryrun.md](UPSTREAM-dryrun.md) (slice 2).

| | |
| --- | --- |
| Upstream | https://github.com/nesyeklaf/sandy, path `plugins/workflows` |
| Fork base (inferred, closest tree) | `6852284f82a8c50f6de5e46b4de016a50fa4b37a` (2026-10-14) |
| Target (pinned upstream main, slice 2) | `b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d` (2026-10-26), subtree tree `b0c5e7a2` |
| Upstream main when slice 16 ran | `f15275b83134efcbb94623a0689c9b07a24e0a7d`, not taken (see "After the target") |
| Plugin id | `workflows-plus` (unchanged) |

## Method

Same model as the dry run: base `B:plugins/workflows`, target `T:plugins/workflows`,
fork = this directory. The dry run replayed the fork's ten own commits onto the
target; only the first stopped (2 files, 4 hunks) and the other nine applied
cleanly, so the rebased tree equals a per-file three-way merge
(`git merge-file --diff3`, base = B, ours = fork, theirs = T) of the files upstream
changed. Paths map `skills/workflows/` → `skills/workflows-plus/`. The bundled
shared-UI copies under `components/` and `lib/` were merged the same way against
`packages/shared-ui/src/` at B and T. Every conflict was resolved by hand (below).

## Upstream commits between base and target

Every commit in `B..T` that touches `plugins/workflows`, oldest first.

| Commit | Subject | Files upstream | Status here |
| --- | --- | --- | --- |
| `6d1707c7` | Consolidate CLI and plugin documentation into their owning references (#4992) | `skills/workflows/SKILL.md`, `skills/workflows/references/runs.md`, `src/data.test.ts` | **Included.** The fork (restored from an installed copy) already had all three changes; the merge leaves them as they were. Adapted: the enable and config commands in the docs now name `workflows-plus` instead of `workflows`. |
| `d42cad4c` | Show total counts in banner badges (#5457) | `src/app.tsx`, `src/app.test.tsx` (+ shared-ui `prompt-stack-disclosure.tsx`) | **Included.** `PromptStackCountSlot count={runs.length}`; the vendored `components/ui/prompt-stack-disclosure.tsx` now matches upstream at T (no "+" prefix by default). The banner shows "4", not "+3". |
| `75b90b97` | Typecheck with tsrs instead of TypeScript 7 tsc (#5861) | `package.json`, `src/validation.ts` | **Adapted.** Included: the `src/validation.ts` fix (explicit lazy `jsonValueSchema` instead of `z.json()`). Not adopted: the tooling part (`tsrs` devDependency, `typecheck: tsrs --noEmit`, dropping `typescript-7`), because tsrs has no win32/darwin-x64 binaries and TS7 `tsc` is cross-platform. `npm run typecheck` stays `tsc --noEmit` from the `typescript-7` devDependency (TS 7.0.2). |
| `1e80ca7b` | Unify plugin tabs across threads and navigation pages (#6013) | `package.json` (SDK >=0.6.73), `src/app.tsx` | **Included.** The run inspector registers through `app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", ... })` and takes `ExperimentalThreadActionTabProps`. Engines: `sandyPluginSdk >=0.6.79` (the SDK SANDY 0.47.1 ships, above the 0.6.73 this commit needs). |
| `298b04ee` | One panel controller for plugins and core (#6356) | `package.json` (SDK >=0.6.88), `src/app.tsx`, `src/app.test.tsx` | **Adapted: apply when SANDY > 0.47.1 ships SDK >= 0.6.88.** It replaces `useSandyNavigate().openThreadPanel({ actionId, ... })` with `experimental_useAppPanel().openTab({ tab: {...}, ... })`. The installed SANDY 0.47.1 (latest stable sandy-app) ships plugin SDK 0.6.79, whose panel only has `experimental_openTab`, and 0.6.88 is not published (0.6.89 only with nightly sandy-app). The two openers and the two app tests stay in their `1e80ca7b` form (`openThreadPanel`, still a supported wrapper in 0.6.79). |

### Shared-UI commits outside `plugins/workflows`

The plugin vendors `packages/shared-ui` helpers. Of the nine bundled files only
`components/ui/prompt-stack-disclosure.tsx` changed in `B..T`
(`131a47b0` Redesign the child threads banner list, `d42cad4c`, `d1b60165` Align
prompt stack count badges). The fork copy was at `131a47b0`; it now equals T
byte for byte (default prefix `""`, exported `PROMPT_STACK_COUNT_PILL_CLASS` /
`PROMPT_STACK_TRAILING_SLOT_CLASS`, narrower trailing slot). The other bundled
files (`button`, `skeleton`, `motion`, `activity-row-styles`, `chrome-style-tokens`,
`workflow-progress`, `icon`, `lib/utils`) did not change in `B..T`; `icon.tsx` is the
fork's own standalone version.

### After the target

Upstream main moved to `f15275b8` (11 commits). One of them, `2f61afc2` (Move the
Diff tab, Info git rows and composer segment into the Git plugin, #6157), touches
`plugins/workflows/src/app.test.tsx` and `prompt-stack-disclosure.tsx`. Not taken:
this sync stays on the pinned target.

## Conflicts and resolutions

| File | Hunks | Resolution |
| --- | ---: | --- |
| `package.json` | 3 | Engines: kept fork's own section, `sandy >=0.47`, `sandyPluginSdk >=0.6.79` (not upstream's `sandy >=0.0` / `>=0.6.88`). Scripts: kept fork's `typecheck: tsc --noEmit` and no `prepare:bundled` (standalone build, no `sandy-plugin-build`). devDependencies: kept `typescript-7` and the fork's standalone UI deps (`class-variance-authority`, `clsx`, `tailwind-merge`, `sonner`), no `tsrs`. `@sandy-sdk/plugin-sdk` devDependency 0.6.49 → 0.6.79; `package-lock.json` regenerated by `npm install` (only the SDK and its `@tanstack/react-query` dependency changed). Name, `sandy` manifest and plugin id unchanged. |
| `skills/workflows-plus/SKILL.md` | 1 | Both sides added the same paragraph; kept the fork's (`sandy workflows-plus` commands) and fixed `sandy plugin enable workflows` → `workflows-plus`. Also fixed `sandy plugin config workflows set` → `workflows-plus` in `references/runs.md` (merged cleanly, wrong id). |
| `components/ui/prompt-stack-disclosure.tsx` (shared-ui merge) | 2 | Took upstream T: the fork side was the earlier `131a47b0` state of the same change. |

Clean merges: `src/app.tsx` and `src/app.test.tsx` (against `1e80ca7b`, see 298b04ee),
`src/validation.ts`, `references/runs.md` and `src/data.test.ts` (already equal to
upstream). No conflict in worker, service, server or data code: upstream did not
change them in `B..T`.

Deviations from upstream at T, in one list: 298b04ee panel opener and SDK minimum
(SANDY 0.47.1), 75b90b97 tooling (tsrs), the plugin id in docs, and the fork's
standalone packaging (vendored UI, no `prepare:bundled`).

## Database migrations

`src/data.ts` is unchanged by this sync (same SHA-256 as before,
`60174fdc…`), and upstream's `src/data.ts` blob is identical at B and T
(`04621f10`): **no upstream migration in `B..T`**. The ordered array passed to
`sandy.storage.migrate` is:

| # | Migration | Origin |
| ---: | --- | --- |
| 1 | `CREATE TABLE workflow_runs` / `workflow_calls` | upstream, = T |
| 2 | `workflow_runs.settings_json`, `workflow_calls.last_activity_at`, retention indexes | upstream, = T |
| 3 | `workflow_runs.notification_attempt_count` | upstream, = T |
| 4 | `workflow_runs.notification_outcome` (+ backfill) | upstream, = T |
| 5 | `workflow_runs.replay_safety_version`, `replay_barrier_index` | upstream, = T |
| 6 | `workflow_runs_origin_created_idx` | upstream, = T |
| 7 | replay barrier backfill (`UPDATE workflow_runs`) | upstream, = T |
| 8 | `workflow_calls.provider_retry_attempts` | upstream, = T |
| 9 | `CREATE TABLE workflow_workers` (cleanup ledger, backfill) | upstream, = T |
| 10 | `workflow_workers.cleanup_attempts` | upstream, = T |
| 11 | `workflow_runs_expiry_idx` | upstream, = T |
| 12 | `workflow_workers.kept` | fork-only |

Migrations 1–11 are string-equal to upstream T's array; 12 is the fork's own and
stays last, byte-identical. An existing workflows-plus DB needs no new migration
from this sync. Back it up before the install anyway.

## Behavior contract

The slice-15 characterization tests (`src/server-characterization.test.ts`,
`src/service-characterization.test.ts`, 23 tests, plus `src/worker-test-host.ts`)
are unchanged and pass. One existing test changed with upstream:
`src/app.test.tsx` "workflow composer banner" expects the badge "4" (total runs)
instead of "+3" (d42cad4c, an intended upstream UI change).

## Reproduce

```sh
U=$(mktemp -d /tmp/sandy-upstream.XXXX)
git clone --filter=blob:none https://github.com/nesyeklaf/sandy "$U"
B=6852284f82a8c50f6de5e46b4de016a50fa4b37a T=b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d
git -C "$U" log --reverse --format='%H %cI %s' "$B..$T" -- plugins/workflows
git -C "$U" diff "$B" "$T" -- plugins/workflows packages/shared-ui/src/components/ui/prompt-stack-disclosure.tsx
git -C "$U" diff "$B" "$T" -- plugins/workflows/src/data.ts   # empty
# per changed file f: git merge-file --diff3 <fork f> <B:f> <T:f>  (1e80ca7b:f for src/app*.tsx)
```
