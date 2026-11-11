## Why

Agents that Sandy starts (Pi, Codex, Claude Code) load every skill they find. Many skills overlap, which costs context and leads the model to the wrong instructions. Today Sandy can only switch off whole Sandy-owned sources (`disabledSkillSources`: `sandy-plugins`, `sandy-user`, `sandy-project`, `shared`). Skills in an agent's native roots, such as `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills`, `$CODEX_HOME/skills`, Pi packages and Claude plugins, always load, and `docs/configuration.md` says so. The owner wants to turn single skills, many skills or all skills off, or to enable only the wanted ones. This should apply only to agents Sandy starts, and only Sandy's own settings should change.

## What Changes

- New Sandy setting `skillSelection`. It holds exactly one of `{mode: "inherit"}` (the default, today's behavior), `{mode: "disable", names}` or `{mode: "allow-only", names}`. It is applied after the existing `disabledSkillSources`.
- The skill listing reports, per skill name, whether it is enabled and why. It groups duplicates by name and lists every origin, and it shows per provider whether Sandy can enforce the selection.
- The server leaves disabled Sandy-injected skills out of the injected roots. It sends the selection with the existing `skills/configure` bridge request to new and restored sessions, and `HOST_DAEMON_PROTOCOL_VERSION` goes up.
- Each provider bridge maps the selection to that provider's own per-launch control. None of the three is proven yet:
  - Pi 1.5.1: `--no-skills` plus one `--skill` per enabled skill path.
  - Claude Agent SDK 0.3.245: `skillOverrides: off` in the SDK flag settings layer the bridge already passes.
  - Codex 0.166.0: a `-c skills.config` override on `codex app-server` launch.

  A provider shows as enforced only after a test passes against its real entry point. Until then it shows as "not enforced". That is an honest intermediate status, not a finished feature.
- One mutation behind the Skills page, new CLI commands (`sandy skill disable|enable|only|inherit`) and the SDK (`skills.getSelection`, `skills.setSelection`).
- A change applies to sessions started or restarted afterwards. Sandy names the loaded threads that still run with the old selection and points to the existing restart (`sandy thread stop`, Pi Lifecycle's Restart). It never restarts on its own.
- Not changed: provider configuration files, skill files and installed skills. Agents that the owner starts outside Sandy load exactly what they load today.

## Capabilities

### New Capabilities

- `agent-skill-selection`: a Sandy-only, per-skill-name selection policy for the agents Sandy starts. It covers storage and default, composition with skill sources, duplicates, delivery to new and restored sessions, per-provider enforcement with real-entry proof, the apply-on-restart message, and parity across UI, CLI and SDK.

### Modified Capabilities

None. Source-level `disabledSkillSources` keeps its behavior.

## Impact

- Settings and server: `packages/domain/src/app-settings.ts`, `apps/server/src/services/skills/` (`skill-catalog.ts`, `skill-listing.ts`, `injected-skills.ts`), `apps/server/src/routes/system.ts`.
- Wire: `packages/provider-bridge-protocol/src/requests.ts` (`skillsConfigureParamsSchema`), `packages/agent-runtime/src/runtime-provider-process.ts`, `packages/host-daemon-contract/src/protocol.ts` (protocol version bump).
- Bridges:
  - `plugins/provider-pi/src/bridge/` (`bridge.ts`, `rpc-session.ts`, `pi-package-skills.ts`, `native-roots.ts`)
  - `plugins/provider-claude-code/src/bridge/` (`sdk-session.ts`, `skill-plugins.ts`)
  - `plugins/provider-codex/src/bridge/` (`bridge.ts` app-server launch, `session-params.ts`)
- Surfaces: `apps/app/src/views/SkillsView.tsx`, `apps/cli/src/commands/skill.ts`, the SDK skills client, `docs/configuration.md`, and the CLI guide surfaces listed in `docs/cli-guide-and-skill.md`.
- No new dependencies. Not a security boundary: a model can still read a skill file by path, and skill text already in a conversation stays there.
