Evidence: [recorded checks at 5d8b7af20](verification-5d8b7af20.md) and [continuation handoff](handoff.md). The owner stopped work before a final follow-up SHA and its reruns were collected. The WIP includes two test-fixture corrections and wording changes; their final verification is pending. Ticked boxes record bounded implementation/check coverage, not full provider enforcement. Browser checks covered the bulk menu and toast Stop at 6f24363f9, and 390 px rows and duplicate origins at 5d8b7af20.

## 1. Probes (real entry points, no credentials)

- [x] 1.1 Codex: `plugins/provider-codex/src/bridge/bridge.skill-selection.test.ts` (real, `SANDY_TEST_REAL_CODEX=1`) starts the installed `codex app-server` through the bridge with a temporary `CODEX_HOME`; disable and allow-only report the right `enabled` values in `skills/list` and write no `config.toml`; a failed `skills/list` refuses the start and a user's `enabled = false` survives. Passes at 5d8b7af20.
- [ ] 1.2 Pi: `plugins/provider-pi/src/bridge/skill-selection.test.ts` (real, `SANDY_TEST_REAL_PI_COMMAND`) launches `pi --mode rpc` with the bridge's arguments and native, package, extension and injected fixtures; `get_commands` drops disabled native and package skills. The two extension-skill cases are expected failures (gap). Project skills under `defaultProjectTrust: "always"` are kept and skipped under `ask` ("loads project skills when Pi trusts projects by default"). The recorded rerun at 5d8b7af20 was 15/16 with the environment test failing. The WIP snapshots the environment before restoring the fixture; rerun pending. The two expected failures expose gaps, not enforcement.
- [x] 1.3 Claude: `plugins/provider-claude-code/src/bridge/__tests__/skill-selection.test.ts` (real, `SANDY_TEST_REAL_CLAUDE=1`) starts the SDK without a model turn; `supportedCommands()` lists exactly the enabled native and injected skills under disable and allow-only. Passes at 5d8b7af20 with `skill-plugins.test.ts`.

## 2. Policy, storage and composition

- [x] 2.1 `skillSelectionSchema` and helpers in `packages/domain/src/skill-selection.ts`, storage in `packages/db/src/data/app-settings.ts`, `GET`/`PUT /settings/skill-selection`; verify `packages/domain/test/skill-selection.test.ts` and `apps/server/test/system/skill-selection.test.ts` (default, rejection of mixed shapes, pendingThreadIds)
- [x] 2.2 Server-computed `selectionEnabled` in the listing; the injected catalog is not filtered by the selection, so a policy-only change keeps its hash (`apps/server/test/services/plugins/plugin-agent-contributions.test.ts`); verify `apps/server/test/skills/skill-listing.test.ts`, `apps/server/test/public/public-project-skills.test.ts` and `apps/server/test/services/threads/provider-command-typeahead.test.ts`

## 3. Delivery to new and restored sessions

- [x] 3.1 `selection` in `skills/configure`, protocol 266, a selection change keeps busy and idle runtimes; verify `packages/agent-runtime/src/runtime.lifecycle.test.ts`, `runtime.process-lifecycle.test.ts`, `bridge-protocol-adapter.test.ts`, `packages/host-daemon-contract/test/contract.test.ts`, `apps/host-daemon/src/command-dispatch.test.ts` and `apps/host-daemon/src/runtime-manager.test.ts` "keeps busy and idle runtimes with their loaded threads on a skill selection change". A scripted-bridge probe through `createAgentRuntime` also keeps a loaded thread on its process and starts new threads on a new one; no native or server end-to-end run

## 4. Provider enforcement (each declares enforced only once its probe passes)

- [ ] 4.1 Pi: `--no-skills` plus `--skill` per kept skill; unit tests in `plugins/provider-pi/src/bridge/skill-selection.test.ts` and `src/pi-package-skills.test.ts`. A failed resolution refuses the start ("refuses to start when Pi resolution fails"). Declared `unverified`/`not-enforced` with gap `extension-skills`; enforced needs task 1.2 and an owner decision on the gap
- [x] 4.2 Claude Code: overrides-only filter and per-name injected plugin filtering; unit tests in `__tests__/skill-selection.test.ts` and `skill-plugins.test.ts`. Declared `unverified`/`unverified` with gaps `bundled-skills`, `marketplace-plugin-skills`; enforced needs task 1.3, a subagent proof and an owner decision on the gaps
- [x] 4.3 Codex: `-c skills.config` on launch with the process keyed on the selection; unit tests in `plugins/provider-codex/src/bridge/skill-selection.test.ts`; a failed `skills/list` refuses the start under disable and allow-only (`bridge.skill-selection.test.ts`), and a user's `enabled = false` survives a disable. Declared `unverified`/`unverified` with gap `allow-only-skills-added-after-start`; it stays below enforced until task 6.1, since the real test covers the launch, not a full thread

## 5. Surfaces, apply-on-restart and docs

- [x] 5.1 CLI `sandy skill selection` and SDK `skills.experimental_getSelection`/`experimental_setSelection` over the one route, printing gaps, pending threads and `sandy thread stop`; verify `apps/cli/src/__tests__/command-output/skill.test.ts` and `packages/plugin-sdk/src/__tests__/provider-declaration-v3.test.ts`
- [ ] 5.2 Skills page: row and detail switches, Skill selection menu (all off, only shown on, shown off, every skill on), Off marks on every copy, provider status and gaps, standing timing and read-boundary note, toast with the existing Stop; verify `apps/app/src/views/SkillsView.test.tsx`, `apps/app/src/hooks/realtime-cache-effects.test.ts` and a ui-verifier browser check of the Skills page in the isolated dev app
- [ ] 5.3 `docs/configuration.md` (Skill selection), `docs/api_to_audit.md`, the agent configuration guide and CLI guide surfaces; verify `sandy skill selection --help` and `sandy guide` show the command and the docs state when a change applies and the per-provider gaps. Open: the source `sandy skill selection --help` and `sandy guide` check has not been rerun since 6f24363f9

## 6. Acceptance

- [ ] 6.1 End to end in the source dev app: disable one skill and set allow-only, then start and restore a Pi, a Codex and a Claude Code thread; verify each provider's real listing (`get_commands`, `supportedCommands()`, `skills/list`) leaves out the disabled skill. The change is complete only when all three providers report enforced or the owner accepts each named gap; a provider still below enforced is reported as open, not done
