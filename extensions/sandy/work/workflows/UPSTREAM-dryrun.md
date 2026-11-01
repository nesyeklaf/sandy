# workflows-plus upstream rebase dry run (slice 2)

Report only; 2026-10-27. Read draft [nesyeklaf/plugins#2](https://github.com/nesyeklaf/plugins/pull/2), including the owner's requirement to disable upstream workflows only after workflows-plus has its latest fixes. No production changes, installs, live DB access, commits in the project checkout, pushes, remote changes to existing repositories, or PR edits.

**Result:** base `6852284f82a8c50f6de5e46b4de016a50fa4b37a` → main `b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d`; **2 conflicting files, 4 conflict hunks**, at the restored root only. Recommend **rebase**, with characterization tests and manual packaging/shared-UI reconciliation before shipping.

## 1. Fork base: exhaustive tree comparison

Used reachable canonical **https://github.com/nesyeklaf/sandy**, not the fallback nesyeklaf/sandy or the older local SANDY checkout. Scratch clone: `/tmp/sandy-upstream-s2-1793093743`; scratch replay worktree: `/tmp/sandy-s2-rebase`. Project input pinned at `482392af472e65f221e9a7f7a3f49081a276ec67`.

Fork root: `95ac94e94f2d113c45146b796ae875b6b73fdcb7` (“restored from the installed copy”). Imported subtree tip: `90714b1354268aa1db2359f996c883fdc3267619`, **not** the fork root.

Compared the fork-root tree, at repository root, against each of the **63** upstream history commits touching `plugins/workflows`, stripping that prefix via Git tree objects. Primary score = inserted + deleted lines from `git diff --no-renames --numstat` (all tracked files, tests/docs/lockfile included). Changes elsewhere in SANDY cannot change this subtree; comparing these history states covers its successive versions. No timestamp cutoff, whitespace normalization, or plugin-name substitution.

Top candidates, ordered by the primary raw score; dates are upstream commit-local dates:

| Upstream commit | Date | Raw + | Raw − | Raw total | Files | Rename-aware total | Source-normalized total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `6852284f82a8c50f6de5e46b4de016a50fa4b37a` | 2026-10-14 | 5,602 | 686 | **6,288** | 37 | 5,222 | 760 |
| `6d1707c7fb75ac6bc657a4a5c87cbf610e3d172d` | 2026-10-14 | 5,592 | 697 | 6,289 | 37 | 5,189 | 727 |
| `d42cad4cf5c7fd0f29b1d179572466c61c1c62e9` | 2026-10-15 | 5,594 | 699 | 6,293 | 37 | 5,193 | 731 |
| `75b90b972316318d91b689f57ecb42fa2b7e926a` | 2026-10-20 | 5,597 | 713 | 6,310 | 37 | 5,210 | 748 |
| `fe1a02d7b994866cfd477e3ad7c0bc85fa525002` | 2026-10-09 | 5,602 | 709 | 6,311 | 37 | 5,245 | 783 |
| `1e80ca7b44bccd06c6da75ed9ca6ba497bd380f5` | 2026-10-22 | 5,600 | 721 | 6,321 | 37 | 5,221 | 759 |
| `1d911ab326afa7f58b5983fb000e1ef35c5fa243` | 2026-10-07 | 5,603 | 719 | 6,322 | 37 | 5,256 | 794 |
| `298b04ee823efb8b775e6b0020212168ec96eef9` | 2026-10-26 | 5,612 | 752 | 6,364 | 37 | 5,264 | 802 |

Chosen base is the **raw minimum**, `6852284f`, “Build test databases from one template, share test setup, and move DOM-free tests out of jsdom (#5261)”, committed `2026-10-14T10:44:41-07:00`. It is a closest-state inference, **not proof of historical ancestry**. The next candidate differs by only one raw line; under the auxiliary normalized metric it wins instead. The restored copy includes some already-later documentation; do not mistake the inferred base for a pristine historical checkout.

### Why the ~20% stop heuristic did not stop this run

Fork-root tree = **21,145 lines**; upstream base = **16,229 lines**. Raw score / fork tree = **29.74%**, and rename-aware = **24.70%**. These exceed 20% if interpreted literally. Breakdown of the raw 6,288-line score:

- 3,259: fork-only `package-lock.json`.
- 1,180: fork-only bundled `components/**` (1,163) and `lib/**` (17), standalone copies of monorepo helpers.
- 23: standalone `.gitignore` (2) and MIT `LICENSE` (21).
- 1,066: apparent delete/add overhead eliminated by detecting `skills/workflows` → `skills/workflows-plus` renames at 50%.
- **760**: remaining source/config/tests/docs delta; no source changes hidden.

Removing those packaging additions from the denominator gives **16,683** fork lines; 760 / 16,683 = **4.56%**. This demonstrates a plausible close source base rather than an unrelated tree. The supervisor explicitly approved proceeding using this source-normalized interpretation of the stop heuristic, while retaining the raw-minimum base and disclosing both metrics. Excluding bundled UI is only for base plausibility, **not permission to ignore its upstream fixes** (see section 5).

### Reproduction: setup and scoring

Run from this project checkout. Everything created below is under `/tmp`; use a fresh scratch path. Full blobs are fetched once to avoid one lazy partial-clone fetch per historical diff.

```sh
gh pr view 2 -R nesyeklaf/plugins --json body --jq .body
export P="$PWD"
export R="$(mktemp -d /tmp/sandy-workflows-dryrun.XXXXXX)"
git clone --filter=blob:none https://github.com/nesyeklaf/sandy "$R"
git -C "$R" fetch --refetch --filter=blob:limit=100m origin
git -C "$R" fetch "$P" \
  482392af472e65f221e9a7f7a3f49081a276ec67:refs/heads/local-plugins \
  95ac94e94f2d113c45146b796ae875b6b73fdcb7:refs/heads/fork-root \
  90714b1354268aa1db2359f996c883fdc3267619:refs/heads/fork-split
cd "$R"
export B=6852284f82a8c50f6de5e46b4de016a50fa4b37a
export T=b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d
git ls-remote origin refs/heads/main # may advance; measured target is T
git show -s --format='%H %cI %s' "$B" "$T"
python3 - <<'PY'
import subprocess
g=lambda *a: subprocess.check_output(['git',*a],text=True).strip()
def packaging(p):
    return p in ('.gitignore','LICENSE','package-lock.json') or p.startswith(('components/','lib/'))
def stats(tree,renames):
    rows=[r.split('\t') for r in g('diff','--numstat',renames,tree,'fork-root').splitlines()]
    a=sum(int(r[0]) for r in rows); d=sum(int(r[1]) for r in rows)
    normalized=sum(int(a)+int(d) for a,d,p in rows if not packaging(p))
    return a,d,len(rows),normalized
target='b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d'
scores=[]
for c in g('log','--format=%H',target,'--','plugins/workflows').splitlines():
    tree=g('rev-parse',c+':plugins/workflows')
    a,d,n,_=stats(tree,'--no-renames')
    ra,rd,_,norm=stats(tree,'--find-renames=50%')
    scores.append((a+d,c,a,d,n,ra+rd,norm))
print('candidate count',len(scores))
for total,c,a,d,n,ren,norm in sorted(scores)[:8]:
    print(c,g('show','-s','--format=%cI',c),a,d,total,n,ren,norm)
for name in ('fork-root','6852284f82a8c50f6de5e46b4de016a50fa4b37a:plugins/workflows'):
    tree=g('rev-parse',name)
    paths=g('ls-tree','-r','--name-only',tree).splitlines()
    lines=lambda p: len(subprocess.check_output(['git','show',tree+':'+p]).splitlines())
    print(name,'all',sum(map(lines,paths)),
          'normalized',sum(lines(p) for p in paths if not packaging(p)))
PY
git diff --numstat --no-renames "$B:plugins/workflows" fork-root
git diff --numstat --find-renames=50% "$B:plugins/workflows" fork-root
```

## 2. Pinned target

- Canonical upstream **main HEAD**: **`b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d`**.
- Commit date: `2026-10-26T22:20:47-07:00` = **2026-10-27 05:20:47 UTC**. Subject: “Disable double-click rename on coarse-pointer devices (#6364)”.
- Observed during this run on 2026-10-27 around 09:35 UTC.
- Latest commit actually touching `plugins/workflows`: **`298b04ee823efb8b775e6b0020212168ec96eef9`**, `2026-10-26T20:52:16-07:00`, “One panel controller for plugins and core (#6356)”.
- Target subtree tree object: **`b0c5e7a256fc70f97aec4c6e41d5e4b09c47762f`**. Distinguish this from main HEAD and the latest path-touching commit; all identify the same target plugin content here.

```sh
git log -1 --format='%H %cI %s' "$T"
git log -1 --format='%H %cI %s' "$T" -- plugins/workflows
git rev-parse "$T:plugins/workflows"
```

## 3. Upstream commits between base and target

Complete path-limited `B..T` list, oldest first. Dates are commit-local; classifications describe the workflow-related changes, not necessarily every change in the larger SANDY commit.

| SHA | Date | Subject | Classification / workflows effect |
| --- | --- | --- | --- |
| `6d1707c7fb75ac6bc657a4a5c87cbf610e3d172d` | 2026-10-14 | Consolidate CLI and plugin documentation into their owning references (#4992) | **Maintenance + fixture fix**: plugin enablement/project-thread guidance, settings reference; data tests use actual defaults. No new runtime feature. |
| `d42cad4cf5c7fd0f29b1d179572466c61c1c62e9` | 2026-10-15 | Show total counts in banner badges (#5457) | **Fix**: show total workflows, not hidden remainder; paired shared-UI badge fix outside subtree must follow. |
| `75b90b972316318d91b689f57ecb42fa2b7e926a` | 2026-10-20 | Typecheck with tsrs instead of TypeScript 7 tsc (#5861) | **Tooling change + compatibility fix**: tsrs dependency/script, explicit lazy JSON schema avoids circular type regression; runtime validation structure unchanged. |
| `1e80ca7b44bccd06c6da75ed9ca6ba497bd380f5` | 2026-10-22 | Unify plugin tabs across threads and navigation pages (#6013) | **Feature/API migration**: `experimental_tab`, action-tab props; SDK minimum 0.6.73. |
| `298b04ee823efb8b775e6b0020212168ec96eef9` | 2026-10-26 | One panel controller for plugins and core (#6356) | **Feature/API consolidation + navigation fix**: `experimental_useAppPanel().openTab`, tests use `experimental_panel`; SDK minimum 0.6.88. |

```sh
git log --reverse --format='%H %cI %s' "$B..$T" -- plugins/workflows
git diff "$B..$T" -- plugins/workflows
for c in $(git rev-list --reverse "$B..$T" -- plugins/workflows); do
  git show --format=fuller "$c" -- plugins/workflows
done
```

## 4. Scratch rebase, conflicts, and migrations

### Replay construction and own-commit coverage

Histories are unrelated: upstream is a monorepo, while restored `95ac94e9` is a parentless standalone plugin root. A naïve unrelated-history merge counts whole files as add/add and is not a meaningful base-aware rebase. Instead, construct **scratch-only** commits:

1. Base commit whose root tree is `B:plugins/workflows`.
2. Target commit with that base as parent and root tree `T:plugins/workflows`.
3. Restored root tree with the synthetic base as parent (preserves the complete base→fork-root delta).
4. Replay each subsequent plugin snapshot in original chronological order, stripping `sandy/workflows-plus/` after import.
5. `git rebase --onto <synthetic-target> <synthetic-base> --empty=keep`.

The subtree import `ca13075dfe4af3965624ef308103ee2b706018e7` is structural only and is not replayed as an extra all-files addition. Its standalone subtree history is retained:

| Own commit | Date | Content / replay outcome |
| --- | --- | --- |
| `95ac94e94f2d113c45146b796ae875b6b73fdcb7` | 2026-10-20 | Restored fork, keep/session/raw/result; **2 files / 4 hunks** |
| `4ba13bbc36cdb3c4ae9d43e85dee7f10644cae5f` | 2026-10-20 | Stable reusable-worker configuration / cache prefixes; clean |
| `62aa006c38f6a9da3265f22f7f3954446657c905` | 2026-10-20 | Sandy wait announcements; clean |
| `90714b1354268aa1db2359f996c883fdc3267619` | 2026-10-20 | Keep-warm signal in worker host thread storage; clean |
| `d68c977c7b4775d1c8f335dcdf7476f461518af7` | 2026-10-20 | Context-extension integration in keep-warm; clean |
| `3aa097bb19887dae4c2b79e42c80e2f30935b05d` | 2026-10-20 | optimize-tests example; clean |
| `0e03d5c1e949b736071de92f231bbf3e8ef747a7` | 2026-10-21 | Codex cache does not expire; no pings/cold cuts; clean |
| `ac746d6edd62a0ed2f1612e115032ee31680b2d7` | 2026-10-21 | Red report-option test; clean |
| `f3124f811028a0bfd6f9faaa764435aadf07fc2d` | 2026-10-21 | report:true waits for reported value; clean |
| `b82fa8d65680efdbef15de2157de70d2c55f0b3a` | 2026-10-21 | ship example (flow implementation is outside plugin); clean |

“Clean” means Git application only, **not tested behavior**.

### Actual conflicts (Git 2.47.3, merge backend, diff3)

| Conflicting file, relative to plugin | Hunks | First affected own commit | Required eventual resolution |
| --- | ---: | --- | --- |
| `package.json` | **3** | `95ac94e9` | Keep fork identity, standalone dependencies and build arrangement; adopt compatible upstream SDK minimum and tooling changes. Update installed dev SDK too, regenerate lockfile. |
| `skills/workflows-plus/SKILL.md` | **1** | `95ac94e9` | Keep plus namespace and reusable-worker docs, retain upstream guidance, correct enablement command to workflows-plus (restored text still says `enable workflows`). |
| **Total** | **4** | **1 stopping commit** | **2 unique files; all nine later commits applied without further conflicts** |

Hunks count literal `<<<<<<< ` markers in unmerged worktree files, **not diff line counts or file sizes**. No source .ts/.tsx file conflicted. The earlier ~15.9k-LOC estimate is not reproduced by this base-aware experiment.

To inventory later stops, the run deliberately chose the fork's **whole file** at each conflicting path (`checkout --theirs` during a rebase), staged, and continued. This is **diagnostic only**, not a proposed semantic resolution: it drops upstream package changes and some documentation. Later-stop counts are conditional on that explicit choice. All nonconflicting files kept Git's three-way result. Final diagnostic tree versus today's plugin: **3 files, +53/−18** (`src/app.tsx`, `src/app.test.tsx`, `src/validation.ts`). Small remaining diff is partly because restored docs already include later upstream text, **not** evidence the diagnostic result includes every upstream fix.

No runtime tests or typecheck were run; no semantically resolved rebase artifact is being offered. The diagnostic scratch branch is `s2-dryrun`.

### Reproduce the entire replay and hunk counts

Continue in the fresh scratch clone from section 1 (`R` exported). This script writes only scratch Git objects, a sibling `$R-rebase` worktree and `$R-rebase.json`. Synthetic commit messages retain original SHAs, while metadata is deliberately synthetic; production history is untouched.

```sh
git log --reverse --format='%H %cI %s' fork-split
git log --first-parent --reverse --format='%H %cI %s' \
  ca13075d..local-plugins -- sandy/workflows-plus
python3 - <<'PY'
import subprocess, os, json, pathlib
os.chdir(os.environ['R'])
def git(*a, **kw):
    return subprocess.check_output(['git', *a], text=True, **kw).strip()
B='6852284f82a8c50f6de5e46b4de016a50fa4b37a'
T='b6743a36bd9eae1408c35cfc2c7ab1d2419dc79d'
env=os.environ | dict(GIT_AUTHOR_NAME='Dry run', GIT_AUTHOR_EMAIL='dryrun@invalid',
    GIT_COMMITTER_NAME='Dry run', GIT_COMMITTER_EMAIL='dryrun@invalid',
    GIT_AUTHOR_DATE='2026-10-27T09:35:51Z', GIT_COMMITTER_DATE='2026-10-27T09:35:51Z')
def commit(tree,parent,msg):
    return git('commit-tree',tree,*(['-p',parent] if parent else []),input=msg+'\n',env=env)
base=commit(git('rev-parse',B+':plugins/workflows'),None,'upstream base '+B)
target=commit(git('rev-parse',T+':plugins/workflows'),base,'upstream target '+T)
originals=['95ac94e94f2d113c45146b796ae875b6b73fdcb7']
originals+=git('rev-list','--reverse','95ac94e9..fork-split').splitlines()
originals+=git('rev-list','--reverse','--first-parent','ca13075d..local-plugins','--','sandy/workflows-plus').splitlines()
head=base
mapping={}
for c in originals:
    tree=git('rev-parse',c+('^{tree}' if c in originals[:4] else ':sandy/workflows-plus'))
    msg=git('show','-s','--format=%s',c)
    head=commit(tree,head,c+' '+msg)
    mapping[head]=c
git('branch','-f','s2-dryrun',head)
work=os.environ['R']+'-rebase'
git('worktree','add',work,'s2-dryrun')
def run(*a):
    p=subprocess.run(['git','-C',work,*a],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
        env=env | dict(GIT_EDITOR='true'))
    print(p.stdout)
    return p
r=run('-c','merge.conflictStyle=diff3','rebase','--onto',target,base,'--empty=keep')
stops=[]
while r.returncode:
    files=git('-C',work,'diff','--name-only','--diff-filter=U').splitlines()
    if not files: raise RuntimeError(r.stdout)
    current=git('-C',work,'rev-parse','REBASE_HEAD')
    rows=[]
    for f in files:
        p=pathlib.Path(work)/f
        hunks=sum(x.startswith('<<<<<<< ') for x in p.read_text().splitlines()) if p.exists() else 0
        rows.append(dict(file=f,hunks=hunks))
    stops.append(dict(commit=mapping.get(current,current),files=rows))
    print('CONFLICT STOP',json.dumps(stops[-1]))
    # Diagnostic only: choose fork version of whole conflicted files, never a production resolution.
    for f in files:
        run('checkout','--theirs','--',f)
        run('add','--',f)
    r=run('-c','merge.conflictStyle=diff3','rebase','--continue')
out=dict(base=B,target=T,baseSynthetic=base,targetSynthetic=target,originals=originals,
    stops=stops,rebased=git('-C',work,'rev-parse','HEAD'))
pathlib.Path(os.environ['R']+'-rebase.json').write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
PY
git diff --stat local-plugins:sandy/workflows-plus s2-dryrun
git -C "$R-rebase" diff --check
```

### Upstream database migrations: **none between base and target**

Migrations live in **`plugins/workflows/src/data.ts`**, an exported ordered SQL-string array consumed by `src/server.ts` via `sandy.storage.migrate(db, migrations)`; there are no new dated migration files in this interval. The entire `data.ts` blob is identical at both endpoints:

`04621f10dfcd364512ca620479c6fa94f3962371`.

Thus **no new upstream tables, columns, indexes, backfills, or data transformations** to apply in B..T. `src/data.test.ts` changes fixtures/defaults, not schema. Existing pre-base migrations include runs/calls, notification retries/outcomes, replay-safety fields, provider retry attempts, worker cleanup ledger/backfill and cleanup/expiry indexes.

The fork already adds its own migration in **`sandy/workflows-plus/src/data.ts`**:
`ALTER TABLE workflow_workers ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;`
It must remain **after the unchanged upstream migration prefix**. Preserve the existing plus database/plugin identity and migration order; do not reset the DB to a fresh upstream schema. A backup remains required before eventual upgrade, even though this range has no upstream migration.

```sh
git diff "$B..$T" -- plugins/workflows/src/data.ts # empty
git log --format='%H %cI %s' "$B..$T" -- plugins/workflows/src/data.ts # empty
git rev-parse "$B:plugins/workflows/src/data.ts" "$T:plugins/workflows/src/data.ts"
git show "$T:plugins/workflows/src/data.ts" | grep -nE 'migrations|CREATE TABLE|ALTER TABLE|CREATE INDEX'
git diff "$B:plugins/workflows/src/data.ts" fork-root:src/data.ts
```

## 5. Decision and feature landing map

**Recommend a base-aware rebase, not a re-port.** The inferred base is close in actual source, only five upstream workflow commits follow it, the complete ten-commit fork replay has two packaging/docs conflict files, and worker/database implementation did not change upstream in this interval. Re-porting durable session semantics and their tests would create avoidable behavioral risk. Do not use the mechanical fork-side diagnostic resolutions for the real implementation.

Required survivors and landing locations (paths below relative to `sandy/workflows-plus/` unless explicitly outside it):

| Feature | Must survive / landing |
| --- | --- |
| **keep/session/raw/result**, root `95ac94e9` | `src/types.ts`, `src/validation.ts` option contracts; `src/service.ts` spawning, continuation, raw prompt and result handling; `src/data.ts` kept-worker persistence and cleanup exclusions; `src/server.ts` result tool; `src/cli.ts` result command; `src/session.test.ts` and authoring docs. Preserve same-run kept-idle session checks, same-thread continuation, and `{value,session}` return shape. |
| **report:true**, `f3124f81` plus red test `ac746d6e` | `src/types.ts`, `src/validation.ts`, `src/service.ts` on-idle guard, `src/session.test.ts`, authoring reference and `examples/optimize-tests.js`. An ordinary worker turn ending must not complete a reporting flow before an explicit reported result. |
| **ship**, `b82fa8d6` | `examples/ship.js` and `examples/README.md`; preserve raw+report workers and parallel review/release result aggregation. **Outside subtree:** `pi/flow-runner/flows/ship.ts` and `ship.test.ts` carry deterministic diff/log collection and distinct review/release loadouts; preserve/integrate those separately, not in a plugin-only rebase. |
| **cache**, `4ba13bbc/62aa006c` | `src/server.ts` reusable generic configuration/result tool, `src/service.ts` stable instructions and wait/continuation hooks, `src/keep-warm.ts`, `src/keep-warm.test.ts`, `src/session.test.ts`. Keep worker-host signal storage (`90714b13`), context integration (`d68c977c`), and **Codex non-expiry** behavior (`0e03d5c1`); do not accidentally reinstate timed Codex pings. Existing `src/cache.ts` call-result replay rules are distinct from prompt-cache warmth and also remain. |
| **configure recognizes workers by origin before attach**, `src/server.ts:228` | Preserve `sandy.agents.configure` branch `context.origin.pluginId === sandy.pluginId` even when `service.agentConfiguration(thread.id)` is still null. Keep reusable/known-worker branches before origin fallback; result tool remains available during the spawn→ledger-attach race. Do not replace with ledger-only recognition or upstream plugin's literal id. |

### Manual reconciliation beyond Git conflicts

1. **SDK/tooling:** target expects SDK **>=0.6.88** for panel APIs; fork package currently pins dev SDK **0.6.49**. Upgrade compatible engine and dev dependency together, reconcile tsrs/TypeScript and standalone scripts, regenerate `package-lock.json`. Upstream tsrs commit records missing Windows binaries at that time: verify current support or retain a deliberate platform-compatible typecheck path.
2. **Bundled UI dependency fix:** upstream `d42cad4c` changes caller count from `runs.length - 1` to `runs.length`, but also changes shared `PromptStackCountSlot` to have **no “+” prefix**. Plus vendors `components/ui/prompt-stack-disclosure.tsx`, which still defaults `prefix = "+"`. A plugin-subtree-only rebase therefore produces **“+4” instead of “4”**, despite no Git conflict, and its updated banner test will not be satisfied. Port the matching helper semantics/layout from target `packages/shared-ui/src/components/ui/prompt-stack-disclosure.tsx` (adapting standalone imports) and review other bundled helper changes. The matching helper has +16/−8 lines B..T; the other seven bundled component paths checked have no changes in this interval.
3. **Right panel:** retain target `experimental_tab`, `ExperimentalThreadActionTabProps` and `experimental_useAppPanel().openTab` in `src/app.tsx`, with `experimental_panel` test harness changes. Existing action detail tab is not the future always-present Workflows run-list tab; slice 17 still owns that.
4. **Behavior gate:** first land slice 15 characterization tests for every survivor above, especially configure-before-attach, report-only completion, kept-session continuation and cache behavior. Then resolve/rebase in slice 16, run the plugin suite/typecheck and a live run/panel walkthrough; preserve MIT attribution and write `UPSTREAM.md`. Only disable upstream workflows at the planned cutover after parity. Future worker admission/isolation is slice 18, not part of this report.

Useful verification commands for the non-subtree dependencies:

```sh
git diff "$B..$T" -- packages/shared-ui/src/components/ui/prompt-stack-disclosure.tsx
git diff --numstat "$B..$T" -- packages/shared-ui/src/components/ui
git show local-plugins:sandy/workflows-plus/src/server.ts | awk 'NR >= 196 && NR <= 245 {printf "%6d %s\n", NR, $0}'
git show local-plugins:sandy/workflows-plus/components/ui/prompt-stack-disclosure.tsx | tail -20
git show --stat b82fa8d6 -- sandy/workflows-plus pi/flow-runner/flows
```

**Reproduction check:** extracted and executed all six `sh` blocks above, in order, with `set -euo pipefail`, in a second fresh `/tmp` clone. Exit 0; reproduced 63 candidates, 760/16,683 normalized lines, two conflict files/four hunks, and +53/−18 diagnostic-tree delta. Scratch `git diff --check` passed. This validates the report's commands, not runtime behavior.

**Residual risks:** closest tree is inferred, not a recovered upstream parent; normalized metric is explicitly packaging-adjusted; upstream main may advance after this pin; conflict inventory after first stop depends on diagnostic fork-side choices; semantic merge, updated dependency lock, platform tooling, DB backup/upgrade, characterization tests and live behavior remain unvalidated. In particular, a clean textual replay alone does not deliver shared-UI fixes or upgrade the SDK.
