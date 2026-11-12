## Why

Agents that Sandy starts (Pi, Codex, Claude Code) load every skill they find. Many skills overlap, which costs context and leads the model to the wrong instructions. Today Sandy can only switch off whole Sandy-owned sources (`disabledSkillSources`: `sandy-plugins`, `sandy-user`, `sandy-project`, `shared`). Skills in an agent's native roots, such as `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills`, `$CODEX_HOME/skills`, Pi packages and Claude plugins, always load, and `docs/configuration.md` says so. The owner wants to turn single skills, many skills or all skills off, or to enable only the wanted ones. This should apply only to agents Sandy starts, and only Sandy's own settings should change.

## What Changes

- New Sandy setting `skillSelection`, one per server. It holds exactly one of `{mode: "inherit"}` (the default, today's behavior), `{mode: "disable", names}` or `{mode: "allow-only", names}`. It is applied after the existing `disabledSkillSources`.
- The skill listing reports `selectionEnabled` per skill, computed on the server by name, and each row names its other origins. Per provider, Sandy shows how far the selection reaches (`enforced`, `unverified`, `not-enforced`, `not-applicable`, for sessions and subagents) and which skill categories it cannot filter.
- The server sends the injected roots its skill sources enable, independent of the selection, and sends the selection with the existing `skills/configure` bridge request to new and restored sessions; each bridge leaves disabled names out of native and injected skills. `HOST_DAEMON_PROTOCOL_VERSION` goes up.
- Each provider bridge maps the selection to that provider's own per-launch control:
  - Pi: [design A](design.md#pi-sdk-bridge-selected-design-a), an isolated installed-SDK worker using `ResourceLoader.skillsOverride` and native Pi RPC/trust. Extension contributions are filtered at their loading point; incompatible filtered starts are refused. The current adapter is tested against Pi 1.5.1; full-thread and subagent acceptance remain open.
  - Claude Agent SDK 0.3.245: `skillOverrides: off` in the SDK flag settings layer the bridge already passes, plus dropping disabled names from the injected Sandy plugin. Gaps: skills bundled with Claude Code and from its own marketplace plugins; subagents unproven.
  - Codex 0.166.0: a `-c skills.config` override on `codex app-server` launch. Gap: under allow-only, skills added after launch.

  A provider shows as enforced only after a test passes against its real entry point. Until then it shows as "unverified" or "not enforced", with its gaps named. That is an honest intermediate status, not a finished feature.
- One route (`GET`/`PUT /settings/skill-selection`) behind the Skills page (row and detail switches, a Skill selection menu for all off, only the shown skills on, shown skills off and every skill on), the CLI (`sandy skill selection [inherit|disable|allow-only|on|off] [names...]`) and the SDK (`skills.experimental_getSelection`, `skills.experimental_setSelection`).
- A change applies to sessions started afterwards; loaded threads keep the old selection until stopped or their idle session is retired. Sandy names the threads running a turn (`pendingThreadIds`) and offers the existing stop (`sandy thread stop`, the Skills page toast). It never stops or restarts on its own.
- The selection does not rewrite provider configuration, skill files or installed skills. The Pi worker retains native Pi startup migrations, which can update Pi's own legacy layout just as ordinary Pi does. Agents that the owner starts outside Sandy load exactly what they load today.

## Capabilities

### New Capabilities

- `agent-skill-selection`: a Sandy-only, per-skill-name selection policy for the agents Sandy starts. It covers storage and default, composition with skill sources, duplicates, delivery to new and restored sessions, per-provider enforcement with real-entry proof, the apply-on-restart message, and parity across UI, CLI and SDK.

### Modified Capabilities

None. Source-level `disabledSkillSources` keeps its behavior.

## Impact

- Settings and server: `packages/domain/src/skill-selection.ts`, `packages/db/src/data/app-settings.ts`, `apps/server/src/services/skills/` (`skill-catalog.ts`, `skill-listing.ts`, `injected-skills.ts`), `apps/server/src/routes/system.ts`.
- Wire: `packages/provider-bridge-protocol/src/requests.ts` (`skillsConfigureParamsSchema`), `packages/agent-runtime/src/runtime-provider-process.ts`, `packages/host-daemon-contract/src/protocol.ts` (protocol version bump).
- Bridges:
  - `plugins/provider-pi/src/bridge/` (`bridge.ts`, `rpc-session.ts`, `pi-package-skills.ts`, `native-roots.ts`)
  - `plugins/provider-claude-code/src/bridge/` (`sdk-session.ts`, `skill-plugins.ts`)
  - `plugins/provider-codex/src/bridge/` (`bridge.ts` app-server launch, `session-params.ts`)
- Surfaces: `apps/app/src/components/tools/SkillsCollection.tsx` and `SkillsLibrary.tsx`, `apps/cli/src/commands/skill.ts`, the SDK skills client, `docs/configuration.md`, and the CLI guide surfaces listed in `docs/cli-guide-and-skill.md`.
- No new dependencies. Not a security boundary: a model can still read a skill file by path, and skill text already in a conversation stays there.
