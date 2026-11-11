## Context

- **Existing control.** `generalSettings.disabledSkillSources` (`packages/domain/src/app-settings.ts:68`) turns off whole Sandy-owned sources. It is applied when Sandy injects skills (`apps/server/src/services/skills/skill-catalog.ts:25`) and in the listing (`skill-listing.ts:366`), and it is set by `sandy skill sources <src> on|off` and General → Skill sources. Native provider roots are indexed for the listing but never filtered (`docs/configuration.md:606-610`).
- **Delivery.** At process start, `packages/agent-runtime/src/runtime-provider-process.ts:213-228` sends the bridge request `skills/configure {roots}`.
  - Pi turns the roots into `--skill <path>` (`plugins/provider-pi/src/bridge/rpc-session.ts:304`).
  - Codex sends `skills/extraRoots/set` (`plugins/provider-codex/src/bridge/bridge.ts:2555`).
  - Claude Code wraps the roots in the local plugin `sandy-global-skills` and already passes a Sandy-only SDK `settings` flag layer (`sdk-session.ts:201,217`), with `settingSources ["user","project","local"]` (`sdk-session.ts:265`).
- **Restart.** "Restart" in Sandy means `sdk.threads.stop`: it releases the loaded runtime, and the next message starts a fresh process (`extensions/sandy/pi-lifecycle/server.ts:66-70`, `sandy thread stop`).
- **Native per-skill controls in the installed versions.** These come from reading docs and typings. None has been observed at runtime.
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
4. **Identity: the skill name, not the origin.** Claude Code `skillOverrides` and the Codex config address skills by name, and only Pi takes paths. Keying on the name gives the same meaning for every provider. The listing groups by name and shows each origin (provider, root kind, path, registration id, duplicate kind: same-file, same-content or same-name), so the owner can see what a toggle covers. Claude plugin skills use the name the listing already shows for them.
5. **Delivery: extend `skills/configure` with the policy, and bump `HOST_DAEMON_PROTOCOL_VERSION`.** This reuses the request every new and restored session already receives, instead of adding a second channel.
6. **Per-provider mapping:**
   - Pi: when the mode is not `inherit`, launch with `--no-skills` and one `--skill` per enabled path, resolved from native roots, Pi packages and Sandy injection. Other settings and extensions are untouched.
   - Claude Code: put `skillOverrides: off` per disabled name into the existing flag settings layer, and drop disabled names from Sandy agent definitions' `skills`. Leave `settingSources` unchanged.
   - Codex: pass `-c skills.config=[...]` on app-server launch. Because launch config is per process, the app-server process key includes a hash of the policy.
7. **Enforcement status:** each bridge declares `skillSelection: "enforced" | "not-enforced"`. A bridge declares `enforced` only in the commit that adds its passing real-entry test. The listing and the Skills page show this per provider. The feature is complete only when all three providers are enforced.
8. **Apply on restart:** the mutation result lists the threads with a loaded runtime. The UI and CLI offer the existing stop/restart for them. Nothing is restarted automatically.

## Risks / Trade-offs

- [Codex `-c skills.config` may not exist or not disable discovery] → The probe task runs first. If it fails, Codex stays "not enforced" and the owner question on the fallback stays open.
- [Pi `--no-skills` also stops package skill discovery] → The bridge resolves package skill paths itself and passes enabled ones explicitly. The real-pi test covers a package skill.
- [Pi `enableSkillCommands: false` hides skills from `get_commands`] → The real-pi test sets it to true in a temporary agent dir and also asserts on the launch arguments.
- [Claude `skillOverrides` may not reach subagents] → A credentialed live test checks subagent invocation. Until it passes, Claude stays "not enforced".
- [A name-level toggle turns off every copy of a duplicated name] → The listing shows every affected origin. A per-copy toggle is an open question.
- [Codex app-server pooling: one process serves several sessions] → Key the process on the policy hash, so new sessions get a fresh process and running ones keep theirs until restarted.
- [Not a security boundary] → Documented on the Skills page, in `docs/configuration.md` and in the CLI help.

## Migration Plan

There is no data migration: a missing `skillSelection` reads as `{mode: "inherit"}`. The protocol bump makes enrolled daemons update. Rollback: set `inherit`, or revert. No provider files were written, so there is nothing to undo on the hosts.

## Open Questions

These are drafts for the owner. Each names the proposed defaults until it is answered.
- **Scope:** one server-wide selection (proposed default), or also a per-project override?
- **Per-provider exceptions:** one selection for all three providers (proposed default), or exceptions such as a skill off only for Claude Code?
- **Codex fallback, if the probe fails:** stay "not enforced" (proposed default), or start Codex with a Sandy-owned `CODEX_HOME` overlay that links the owner's config and login?
- **Per-copy toggle:** name-level (proposed default), or also per origin, which only Pi could enforce?
