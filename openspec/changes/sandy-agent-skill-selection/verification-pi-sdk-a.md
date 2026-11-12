# Pi SDK worker: bounded verification

## Result and scope

The owner selected design A: an isolated installed-Pi SDK worker with native RPC and a version-bound native trust adapter. Both former `resources_discover` expected failures are now ordinary passing exclusion tests through the production worker. Native, package, project, injected and extension skills are filtered at `ResourceLoader.skillsOverride`, including reload and session replacement. The old CLI pre-scan filter is removed rather than retained as a fallback.

This is **not full feature acceptance**. Pi remains `session: unverified`, `subagents: not-enforced`; its now-proven extension-category gap is removed. OpenSpec 5.2 and 6.1 stay open. Claude Code and Codex: **Owner: später**, gaps not accepted, still `unverified`. No source-app full-thread or native subagent proof was run.

The implementation follows local documentation commit `5caff5f03c34e9d9bc26334740047ab0c1e675a5`. Tests ran on Node `v26.13.0`, installed Pi `1.5.1`, serially at nice level 10 with `VITEST_MAX_WORKERS=1` and Turbo `--concurrency=1`. Real-Pi requests used disposable fixture homes and local fixtures; none made a live model turn. No production configuration was changed.

## Observed checks

- Final affected Pi run: **106 passed, 5 skipped, 0 failed** (`final-reviewed-pi.json`). It covers selection, compatibility, managed package discovery, interruption/recovery, settlement, extension UI and Windows launcher tests. All 22 installed-worker selection cases and all 7 Linux compatibility cases pass. The skipped cases are one actual Windows SDK-worker/npm-shim test and four actual Windows launcher tests; passing simulated-Windows cases are not native Windows proof.
- Real command lists and effective system prompts omit disabled/unlisted extension skills while preserving enabled metadata and non-skill resources. Removing the worker override makes both extension exclusions fail (`mutation-extension-red.json`); the production source was restored. The original pre-fix extension failure is retained in `red-extension.json`.
- Native and worker trust comparisons cover extension yes/no/undecided, defaults and saved trust. Reload, changed cwd, session replacement, captured-selection versus subsequent-selection and full `PiRpcSession` readiness/close checks pass. Native Pi still lists the excluded fixture after the Sandy worker closes.
- Runtime/bridge payload compatibility: **24 passed** (`wire-adapter.json`); targeted daemon-contract cases: **3 passed, 50 unrelated cases filtered out** (`wire-contract.json`). This worker introduces no server/daemon fields, defaults or meaning changes; protocol **266** is retained. These are bounded compatibility tests, not proof against an enrolled production daemon.
- Affected provider typecheck and lint pass (`final-reviewed-typecheck-lint.log`, exit 0); both provider tasks executed, upstream generation/types were cached. The local provider artifact build passes (`provider-bundle-build.log`, exit 0). Nothing was installed or deployed.
- Additional minified/keepNames worker experiment: the exported worker string was extracted from an esbuild Node ESM bundle using the build's require-banner approach, substituted temporarily into the same production worker module, and both real extension exclusions passed (`minified-worker-pi-fixed.json`: 2 passed, 20 filtered out). The original source was restored. This checks the shared predicate serialization under that build shape, not installed plugin behavior or arbitrary future instrumentation.
- Source CLI prerequisite: `pnpm exec turbo run build --filter=@sandy/sdk --concurrency=1` passes (`sdk-build.log`). Fresh `env -u SANDY_CLI` source entry checks for `skill selection --help` and `guide agent-configuration` both exit 0 (`source-cli-help-fixed.log`, `source-cli-guide-fixed.log`). These read-only render/help checks do not mutate a running server setting. Earlier CLI failures from missing SDK dist are not a feature result.
- Strict OpenSpec validation and `git diff --check` pass after documentation updates (`openspec-validation.json`, `diff-check.log`).

## Opus review: acted, considered, dismissed

Exactly one authorized read-only Opus reviewer read the owner intent, design and diff. It reported no blockers but several behavior hypotheses; it could not execute checks and was stopped after reporting. Its reading alone is not behavioral evidence. The following disposition uses local reproductions, not an additional review round.

**Acted:**

- Offline environment normalization: native `PI_OFFLINE=true/yes` semantics and `PI_SKIP_VERSION_CHECK` were missing. Both regressions failed before and pass after normalization; the background-refresh guard uses the same result (`review-offline-{red,green}.json`). The test observes child environment state; it is not a packet-capture proof of zero network activity.
- Native migrations: legacy `commands/` prompts were missing in the worker but present in native RPC. Both now migrate/load identically (`review-migration-{red,green}.json`). Selection itself does not rewrite provider configuration; the worker retains native Pi startup migrations, which can write Pi's own legacy layout exactly as native Pi does. Only disposable fixture paths were exercised.
- Argument errors: unknown options and invalid fork/provider combinations were accepted. Native/worker comparisons now reject them (`review-args-{red,green}.json`, `review-args-expanded-{red,green}.json`). This is not exhaustive equivalence for every Pi CLI command.
- Launcher/runtime: the worker could use a PATH-shadowing Node instead of the configured runtime. It now reuses native launch resolution, preserves configured Node/Bun runtime arguments and CLI arguments, recognizes the managed install's pinned runtime, and bounds its engine probe. Unknown wrappers refuse filtered starts or retain native `inherit`. The runtime regression was red then green (`review-runtime-manifest-{red,green}.json`); removing CLI argument forwarding also makes the real prompt-template comparison fail (`mutation-cli-args-red.json`). Actual Bun and Windows execution remain untested on this Linux host.
- Manifest fallback: non-string versions wrongly threw under `inherit`. Incompatible/unreadable manifest/runtime resolution now uses native `inherit` or refuses filtering (`review-runtime-manifest-{red,green}.json`).
- Synchronous spawn cleanup: an actual invalid environment value, without a spawn mock, left temporary files. Launch failure now removes scratch files (`review-spawn-{red,green}.json`); normal worker exit/bootstrap cleanup also passes.
- Coverage: expanded native-versus-worker cases above replace the fresh-fixture-only parity claim. The final affected run includes them.

**Considered:** serializing the shared pure selection predicate with `Function.prototype.toString` remains sensitive to future helper imports/instrumentation. Retaining one policy owner avoids a second handwritten predicate; the real-worker and minified-worker counterchecks provide current evidence. This is a maintenance limitation, not a claim that arbitrary bundlers are safe. The native bootstrap adapter is deliberately private and restricted to Pi 1.5.1; upgrading it needs new conformance checks.

**Dismissed:** the proposed missing-session-cwd behavior difference did not reproduce: both native RPC and the worker already reject the missing cwd via Pi's runtime. The passing real regression remains; its historical filename `review-cwd-red.json` is misleading and does not represent a red run. No duplicate cwd validator was added.

## Evidence quality and remaining limits

Raw evidence is local at `/home/feysen/.sandy-local/data/thread-storage/thr_m8k92wkhv2/pi-sdk-a/`, not checked into Git. `evidence-index.json` derives counts and passed case names from the saved Vitest reports. Logs and adjacent exit files record builds/help commands; `review-report.json` and `review-findings.json` retain the original reader report. This document is the portable summary.

The first separate minified bundle extraction failed because it omitted the Node ESM require banner. A following passing test run still used the original worker and is **not** minification proof (`minified-worker-pi.json`). Only the fresh extraction and `minified-worker-pi-fixed.json` count. Initial lifecycle fixture mistakes and the extension fixture's `.mjs` discovery mistake are likewise not enforcement evidence; corrected `.ts` fixtures and final passing runs supersede them.

App/CLI test results from [the prior bounded run](verification-46e4b6e0f.md) remain historical; no new UI code, browser, dev server, screenreader or device check was added here. A green local bundle is not installed behavior. Full source-app disable/allow-only start and restore journeys, native subagents, real Windows/Bun execution and SDK versions beyond the version-bound adapter are untested.

No push, PR, merge, release, install, deploy or live model turn was performed. Both pre-existing untracked Holon drafts remain untouched, unstaged and unused as gates. No background server, watcher or delegated reviewer remains running.
