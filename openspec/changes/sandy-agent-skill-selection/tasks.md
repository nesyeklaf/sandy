## 1. Probes (feasibility unknown; run first, against real entry points, no credentials)

- [ ] 1.1 Add the Codex probe test that starts the installed `codex app-server` with `-c skills.config=[{name="grill-me",enabled=false}]` and a temporary `CODEX_HOME`; verify `pnpm exec turbo run test --filter=@sandy/provider-codex` runs `bridge.skills.test.ts` "a launch override disables a skill without writing config.toml" and record pass or fail in the PR. A failure keeps Codex not enforced; it is not a reason to call skills/config/write
- [ ] 1.2 Add the real-pi test that starts the installed pi 1.5.1 in RPC mode with `--no-skills` and explicit `--skill` paths in a temporary agent dir with `enableSkillCommands: true`; verify `bridge.skill-selection.real.test.ts` shows `get_commands` without `grill-me` and with `review` and the package skill
- [ ] 1.3 Add the real Claude SDK test that starts a query without a model turn with `settings.skillOverrides` off for `grill-me` in a temporary config dir; verify `skill-selection.real.test.ts` shows `supportedCommands()` without `grill-me`

## 2. Policy, storage and composition

- [ ] 2.1 Add `skillSelection` (inherit | disable | allow-only) to `packages/domain/src/app-settings.ts`, with `inherit` filled once at the server boundary and the route rejecting mixed or unknown shapes; verify the `public-skill-selection.test.ts` scenarios "inherit is the default and changes no launch" and "a policy mixing disable and allow-only is rejected" on a migrated database
- [ ] 2.2 Apply the policy after `disabledSkillSources` in `skill-catalog.ts` and `skill-listing.ts`, with per-skill `enabled` and reason, name groups and origins; verify the composition, duplicate-name and all-off scenarios in `public-skill-selection.test.ts`, and that a temporary HOME is byte-identical after each mutation

## 3. Delivery to new and restored sessions

- [ ] 3.1 Add the policy to `skillsConfigureParamsSchema`, send it from `runtime-provider-process.ts` on start and restore, and increment `HOST_DAEMON_PROTOCOL_VERSION`; verify `runtime.lifecycle.test.ts` "skills/configure carries the skill selection on restore" and the new-session case

## 4. Provider enforcement (each declares enforced only once its probe passes)

- [ ] 4.1 Pi bridge: `--no-skills` plus `--skill` per enabled path from native roots, packages and injection; verify `bridge.settings.test.ts` "a disabled native skill is left out of the pi launch", then flip the Pi capability to enforced in the commit where task 1.2 passes
- [ ] 4.2 Claude Code bridge: `skillOverrides` in the flag settings layer and filtered agent-definition `skills`; verify `__tests__/skill-selection.test.ts` "disabled skills become flag-layer skillOverrides". Flip to enforced only when task 1.3 and the credentialed subagent test `skill-selection.live.test.ts` "a subagent cannot invoke a disabled skill" pass in a credentialed CI job
- [ ] 4.3 Codex bridge: `-c skills.config` on app-server launch, with the process keyed on the policy hash; verify `bridge.skills.test.ts` and `app-server-launch.test.ts`. Flip to enforced only if task 1.1 passed, otherwise leave not enforced and keep the fallback question open

## 5. Surfaces, apply-on-restart and docs

- [ ] 5.1 Add CLI `sandy skill disable|enable|only|inherit` and SDK `skills.getSelection`/`skills.setSelection` over the one mutation, returning the loaded threads that still run with the old selection; verify the parity table and "a selection change lists loaded threads and restarts none" in `public-skill-selection.test.ts`
- [ ] 5.2 Skills page: per-skill toggle, all-off and allow-only, origins per name group, per-provider enforced or not enforced, the apply-on-restart note with the existing restart, and the not-a-security-boundary note; verify `SkillsView.test.tsx` "a skill toggle sends the shared selection mutation" and an `ui-verifier` browser check of the Skills page in the dev app
- [ ] 5.3 Update `docs/configuration.md` (skills section) and the surfaces in `docs/cli-guide-and-skill.md`; verify `sandy skill --help` and `sandy guide` show the new commands and that the docs state when a change applies and which providers are enforced

## 6. Acceptance

- [ ] 6.1 End to end in the source dev app: disable one skill and set allow-only, then start and restore a Pi, a Codex and a Claude Code thread; verify each provider's real listing (`get_commands`, `supportedCommands()`, `skills/list`) leaves out the disabled skill. The change is complete only when all three providers report enforced; a provider still not enforced is reported as open, not done
