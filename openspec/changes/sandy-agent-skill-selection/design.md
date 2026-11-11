## Context

- **Existing control.** `generalSettings.disabledSkillSources` (`packages/domain/src/app-settings.ts:68`) turns off whole Sandy-owned sources. It is applied when Sandy injects skills (`apps/server/src/services/skills/skill-catalog.ts:25`) and in the listing (`skill-listing.ts:366`), and it is set by `sandy skill sources <src> on|off` and General → Skill sources. Native provider roots are indexed for the listing but never filtered (`docs/configuration.md:606-610`).
- **Delivery.** At process start, `packages/agent-runtime/src/runtime-provider-process.ts:213-228` sends the bridge request `skills/configure {roots}`.
  - Pi turns the roots into `--skill <path>` (`plugins/provider-pi/src/bridge/rpc-session.ts:304`).
  - Codex sends `skills/extraRoots/set` (`plugins/provider-codex/src/bridge/bridge.ts:2555`).
  - Claude Code wraps the roots in the local plugin `sandy-global-skills` and already passes a Sandy-only SDK `settings` flag layer (`sdk-session.ts:201,217`), with `settingSources ["user","project","local"]` (`sdk-session.ts:265`).
- **Restart.** "Restart" in Sandy means `sdk.threads.stop`: it releases the loaded runtime, and the next message starts a fresh process (`extensions/sandy/pi-lifecycle/server.ts:66-70`, `sandy thread stop`).
- **Native per-skill controls in the installed versions.** These come from reading docs and typings; the runner later observed the main-session controls of all three against the installed binaries without a model turn (Codex `-c skills.config` → `skills/list enabled:false`; Pi `--no-skills --skill` → `get_commands`; Claude `settings.skillOverrides` → `supportedCommands`). Subagent behavior is not observed.
  - Pi 1.5.1: `--no-skills` turns off discovery, and explicit `--skill` paths still load. Settings `skills` only adds paths. The documented RPC command `get_commands` lists skills with `sourceInfo.path`.
  - Claude Agent SDK 0.3.245 (`sdk.d.ts`):
    - `Settings.skillOverrides {name: "on"|"name-only"|"user-invocable-only"|"off"}`; `off` hides a skill from the model and from `/`.
    - `Options.skills` applies to the main session only and is described as "a context filter, not a sandbox".
    - `AgentDefinition.skills` preloads skills for subagents.
    - `Query.supportedCommands()` and `initializationResult()` return the slash-command list.
  - Codex 0.166.0 app-server schema (generated from the installed binary):
    - `skills/list` returns `enabled` per skill.
    - `skills/config/write` persists to the user's config, so this change must not use it.
    - `ThreadStartParams.config` accepts overrides, and app-server launch already uses `-c key=value`.
    - Strings in the binary point to a `skills` config entry with name, path and enabled, but no run has shown it working.

## Goals / Non-Goals

**Goals:**
- Turn one skill, many skills or all skills off, or enable only listed skills, for every Pi, Codex and Claude Code session that Sandy starts or restores.
- Store the selection only in Sandy and write no provider or skill files, so launches outside Sandy stay unchanged.
- Keep today's behavior by default, including the existing source filtering.
- Enforce the selection at the provider's real loading point, prove each provider against its real entry point, and report a provider honestly as "not enforced" until it is proven.
- Use one mutation for UI, CLI and SDK. Say when a change applies, and reuse the existing restart.

**Non-Goals:**
- Uninstalling skills, or editing `~/.codex/config.toml`, `~/.claude/settings.json`, `~/.pi/agent/settings.json` or any `SKILL.md`.
- A security boundary.
- Providers other than Pi, Codex and Claude Code, beyond the Sandy-injected skills that the server already filters.
- Processes that a Pi extension spawns outside Sandy's launch.
- Restarting threads automatically.

## Decisions

1. **Where the policy lives: a server-owned setting next to `disabledSkillSources`.**
   - Alternative A, a Sandy plugin only: a plugin cannot change the provider plugins' launch arguments. It could hide rows (the agent still loads the skill) or write provider config (breaks launches outside Sandy). Rejected.
   - Alternative B, Sandy-owned provider homes (own `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR` with filtered skill folders): this enforces everything, but it forks login, sessions, settings and plugins, so restored sessions and non-skill configuration drift. Rejected as the default; kept as an open question for Codex only.
   - Recommended: the server holds the policy and filters what it injects itself. Each bridge maps the policy to its provider's per-launch control.
2. **Policy shape: a discriminated union, `inherit | disable(names) | allow-only(names)`.** Separate disable and allow lists that could both be set would make the result depend on precedence rules nobody can see. The union makes the two lists mutually exclusive by construction. Unknown keys and modes are rejected at the route.
3. **Composition:**
   - A skill is enabled when its Sandy-owned source is enabled and the policy enables its name.
   - Native skills have no Sandy source, so only the policy applies to them.
   - Under `inherit`, the result is exactly today's: source filtering applies, and nothing else is filtered.
   - Under `allow-only`, a newly discovered name stays off. Under `disable`, it is on.
4. **Identity: the skill name, not the origin.** Claude Code `skillOverrides` and the Codex config address skills by name, and only Pi takes paths. Keying on the name gives the same meaning for every provider. The listing keeps one row per distinct content; each row names its other origins (provider, scope, path, registration id, relation: same-file, same-content or same-name), and every row of a name shows the same state, so the owner can see what a toggle covers. Claude plugin skills use the name the listing already shows for them.
5. **Delivery: extend `skills/configure` with `selection`, and bump `HOST_DAEMON_PROTOCOL_VERSION` (265 → 266).** This reuses the request every new and restored session already receives, instead of adding a second channel. A selection change never replaces a runtime: new sessions in it start with the new selection, loaded threads keep theirs until stopped. Only the existing catalog-change path replaces an idle runtime, which a disabled Sandy-injected skill also triggers. Loaded idle threads are not in `pendingThreadIds`: the server has no per-thread loaded state, and adding it needs a new daemon report (deviation from the original spec, reported to the parent).
6. **Per-provider mapping (as built):**
   - Pi: when the mode is not `inherit`, launch with `--no-skills` and one `--skill` per kept skill from Pi's own resolution of native roots, Pi packages and Sandy injection. The bridge finds Pi's package through the managed-install layout (`<agentDir>/install/current-version`). Other settings and extensions are untouched. Gap: skills an extension adds through `resources_discover` are merged after `--no-skills`; the only native filter (`ResourceLoader.skillsOverride`) exists in the SDK, not in CLI or RPC.
   - Claude Code: only `settings.skillOverrides` set to `off` in the existing flag settings layer (`disable`: the listed names; `allow-only`: every scanned native name not listed). Overrides do not hide plugin skills, so the bridge drops disabled names from the Sandy plugin it injects. `Options.skills` is not used: the SDK turns it into the allow rule `Skill(x)` and it does not filter the listing. `settingSources` unchanged. Gaps: skills bundled with Claude Code and skills from Claude Code's own marketplace plugins; subagents unproven.
   - Codex: `-c skills.config=[...]` on app-server launch (`disable`: per name; `allow-only`: per path from Codex's launch-time `skills/list` that the list leaves out); the app-server process key includes the selection. Gap: under `allow-only`, skills added after launch.
7. **Enforcement status:** each bridge declares `experimental_skillSelection: {session, subagents, gaps}` with `enforced | unverified | not-enforced | not-applicable` per side. A bridge declares `enforced` only in the commit that adds its passing real-entry test; today all three declare `unverified` sessions. The Skills page and `sandy skill selection` show status and gaps. The feature is complete only when all three providers are enforced, or the owner accepts a named gap.
8. **Surfaces:** `GET`/`PUT /settings/skill-selection`, SDK `skills.experimental_getSelection`/`experimental_setSelection`, CLI `sandy skill selection [inherit|disable|allow-only|on|off] [names...]`, all computing name toggles with `setSkillNamesEnabled`. The Skills page has a name-level switch per row and on the skill page, a Skill selection menu (all off, only the shown skills on, shown skills off, every skill on), an Off mark on every row of a disabled name, and a standing note on timing and the read boundary.
9. **Apply on restart:** the mutation result lists `pendingThreadIds` (threads with running work). The CLI prints them with `sandy thread stop`; the Skills page toast offers Stop through `sdk.threads.stop`. Nothing is restarted automatically.

## Risks / Trade-offs

- [Pi extension skills bypass `--no-skills`] → Declared gap `extension-skills`, kept visible by an expected-failure real test. Proposal for the owner (not an approved scope reduction): (B) keep it as a documented gap with Pi below enforced, and (C) ask upstream for a skill filter over CLI or RPC. (A), stripping skills from the prompt in `before_agent_start`, is fragile and needs the owner's OK.
- [Claude bundled and marketplace plugin skills are not reachable by overrides] → Declared gaps. `disableBundledSkills` would also remove bundled workflows; owner decision.
- [Claude `skillOverrides` may not reach subagents] → Subagents stay `unverified`; a live probe was inconclusive.
- [A name-level toggle turns off every copy of a duplicated name] → The listing shows every origin, and the switch label names the other copies. A per-copy toggle is an open question.
- [Codex app-server pooling: one process serves several sessions] → The process is keyed on the selection, so new sessions get a fresh process and running ones keep theirs.
- [Not a security boundary] → Stated on the Skills page, in `docs/configuration.md` and in the agent configuration guide.

## Migration Plan

There is no data migration: a missing `skillSelection` reads as `{mode: "inherit"}`. The protocol bump makes enrolled daemons update. Rollback: set `inherit`, or revert. No provider files were written, so there is nothing to undo on the hosts.

## Open Questions

The owner authorized the defaults: one server-wide selection, no per-project or per-provider overrides, no Codex config-home fallback, name-level only. Still open:
- **Pi extension skills:** B+C (documented gap plus upstream ask), or A on the owner's OK.
- **Claude bundled and marketplace plugin skills:** keep as gaps, or turn on `disableBundledSkills` under `allow-only`.
- **Claude subagents:** a credentialed proof run, or accept `unverified`.
