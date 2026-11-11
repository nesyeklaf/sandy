## ADDED Requirements

### Requirement: Selection policy shape and default
Sandy SHALL store one server-wide `skillSelection` as exactly one of `{mode: "inherit"}`, `{mode: "disable", names}` or `{mode: "allow-only", names}`, where `names` are unique skill names, in its own app settings. `inherit` SHALL be the default, and a missing or unparsable stored value SHALL read as `inherit`. `inherit` SHALL keep today's behavior, including the existing `disabledSkillSources` filtering, in listing, injection and every provider launch. `PUT /settings/skill-selection` SHALL reject an unknown mode or extra keys with 400 and SHALL leave the stored policy unchanged.

#### Scenario: Missing setting keeps today's behavior
- **WHEN** a database without `skillSelection` and with `disabledSkillSources: ["sandy-plugins"]` starts a Pi, a Codex and a Claude Code session
- **THEN** `GET /settings/skill-selection` returns `{mode: "inherit"}`, plugin skills are still left out, and `skills/configure` carries `selection: {mode: "inherit"}` with the same roots as before this change

#### Scenario: Disable and allow-only cannot mix
- **WHEN** `PUT /settings/skill-selection` sends `{mode: "disable", names: ["a"], allow: ["b"]}`
- **THEN** the response is 400 and `GET /settings/skill-selection` returns the previous selection

### Requirement: Selection lives only in Sandy
Changing `skillSelection` through any surface SHALL write only Sandy's own settings and SHALL NOT write any file in a provider home, a skill root or a workspace, so the same agent started outside Sandy loads its skills unchanged. Bridges SHALL apply the selection only through per-launch arguments or per-session SDK options, and SHALL NOT use separate provider config homes or overlays.

#### Scenario: Toggle writes nothing outside Sandy
- **WHEN** `skillSelection` is set to `{mode: "disable", names: ["grill-me"]}` with a temporary HOME holding `~/.codex`, `~/.claude`, `~/.pi` and `~/.agents/skills`
- **THEN** every file under the temporary HOME keeps its previous bytes

### Requirement: Composition with sources and new skills
A skill SHALL be enabled exactly when its Sandy-owned source, if it has one, is not in `disabledSkillSources` and the policy enables its name. `inherit` SHALL enable every name, `disable` SHALL enable the names it does not list, and `allow-only` SHALL enable only the names it lists. A skill discovered after the policy was set SHALL therefore stay off under `allow-only` and on under `disable`. The skill listing SHALL report `selectionEnabled` per skill, computed on the server.

#### Scenario: New skill stays off under allow-only
- **WHEN** the policy is `allow-only ["review"]` and `~/.agents/skills/lint-fix/SKILL.md` appears before the next listing
- **THEN** `lint-fix` is listed with `selectionEnabled: false`, and the next session receives the policy that leaves it out

#### Scenario: All skills off
- **WHEN** the policy is `allow-only` with an empty list
- **THEN** every listed skill has `selectionEnabled: false`, and no injected skill root is sent to a new session

#### Scenario: Several skills off
- **WHEN** the policy is `disable ["grill-me", "deslop"]` while five skills are indexed
- **THEN** the listing reports exactly `grill-me` and `deslop` with `selectionEnabled: false`

### Requirement: Duplicate names and origins
The selection SHALL apply to the name, so every origin of a disabled name is off for every provider. The listing SHALL keep one row per distinct content and SHALL list, for each row, the other origins with provider, scope, path, registration id and relation (same-file, same-content, same-name), so the owner can see what a name toggle covers.

#### Scenario: Same name in two native roots
- **WHEN** `grill-me` exists in `~/.agents/skills` and, with other content, in `~/.claude/skills`, and the policy disables `grill-me`
- **THEN** `sandy skill list --json` shows both rows with `selectionEnabled: false`, each naming the other as a `same-name` duplicate

### Requirement: New and restored sessions receive the selection
When Sandy starts or restores a provider session, the server SHALL leave disabled Sandy-injected skills out of the injected roots and SHALL send the policy as `selection` with the `skills/configure` bridge request. The host daemon SHALL reuse a runtime only when both its skill catalog and its canonical selection match the request. A busy runtime SHALL keep running with the selection it has, and an idle one SHALL be replaced on its next turn. `HOST_DAEMON_PROTOCOL_VERSION` SHALL be incremented for the new field.

#### Scenario: Restored session gets the selection
- **WHEN** a thread whose runtime was stopped is resumed after `grill-me` was disabled
- **THEN** the recorded `skills/configure` request carries `{mode: "disable", names: ["grill-me"]}`, and the injected roots do not contain `grill-me`

#### Scenario: Selection change reaches an idle runtime only
- **WHEN** the selection changes while a runtime runs a turn, and the runtime later becomes idle
- **THEN** the busy runtime is not shut down, and the next ensure after it is idle starts a new runtime with the new selection, while a reordered but equal selection reuses it

### Requirement: Per-provider enforcement status
Each provider declaration SHALL state `experimental_skillSelection` as `{session, subagents, gaps}`, where `session` and `subagents` are each `enforced`, `unverified`, `not-enforced` or `not-applicable`, and `gaps` names the skill categories the bridge cannot filter (`bundled-skills`, `marketplace-plugin-skills`, `extension-skills`, `allow-only-skills-added-after-start`). A missing declaration SHALL read as `not-enforced` on both sides with no gaps. A bridge SHALL declare `enforced` only in the commit that adds its passing real-entry test. Sandy SHALL show the status and the gaps on the Skills page and in `sandy skill selection`.

#### Scenario: Unproven provider is shown honestly
- **WHEN** a provider declares `session: "unverified"` with gap `extension-skills` and the policy disables `grill-me`
- **THEN** the Skills page and `sandy skill selection` say that provider leaves the skill out but is not yet proven, and name skills from extensions as not filtered

### Requirement: Pi loads only enabled skills
When the policy is not `inherit`, the Pi bridge SHALL start pi with `--no-skills` and one `--skill` per enabled skill, resolved from Pi's own native roots, Pi packages and Sandy injection, keeping every other setting and extension. Skills that a Pi extension adds through `resources_discover` are merged after `--no-skills` and SHALL be declared as the gap `extension-skills`. Pi session support SHALL stay below `enforced` while that gap exists.

#### Scenario: Real pi does not list a disabled native or package skill
- **WHEN** the installed pi starts in RPC mode with the bridge's launch arguments, a temporary agent dir with native skills, a local Pi package with a skill and an extension skill, and Sandy-injected skills, and the native and package skills `*-off-fixture` are disabled
- **THEN** `get_commands` lists the enabled native, package and injected skills and none of the disabled native or package skills

#### Scenario: Extension skill gap stays visible
- **WHEN** the same launch disables `extension-off-fixture`
- **THEN** the test that expects it hidden runs and is marked as an expected failure, so it turns red once the gap is closed

### Requirement: Claude Code loads only enabled skills
The Claude Code bridge SHALL apply the selection only through `settings.skillOverrides` set to `off` in the SDK flag settings layer it already passes. Under `disable` the listed names are off; under `allow-only` every scanned native skill name (`~/.claude/skills` and `.claude/skills` up to the repository root) that the list does not name is off. Because overrides do not hide plugin skills, the bridge SHALL leave disabled names out of the Sandy plugin it injects. It SHALL NOT use `Options.skills`, which the SDK turns into an auto-approve rule, and SHALL NOT change `settingSources`, user files or plugin files. Skills bundled with Claude Code and skills from Claude Code's own marketplace plugins SHALL be declared as gaps. Subagents SHALL stay `unverified` until a credentialed test proves them.

#### Scenario: Claude override is a flag layer only
- **WHEN** `grill-me` is disabled and a Claude Code session starts
- **THEN** the SDK options carry `settings.skillOverrides["grill-me"] = "off"`, `settingSources` is unchanged, and `~/.claude/settings.json` is unchanged

#### Scenario: Real Claude main session hides native and injected skills
- **WHEN** the installed Claude Agent SDK starts a query through the bridge without a model turn, with a temporary config dir holding native skills and Sandy-injected skills, under `disable` and under `allow-only`
- **THEN** `supportedCommands()` lists exactly the enabled native and injected skills

### Requirement: Codex loads only enabled skills
The Codex bridge SHALL pass `-c skills.config=[...]` on `codex app-server` launch: under `disable` one entry per listed name with `enabled = false`, under `allow-only` one entry with `enabled = false` per path in Codex's own launch-time `skills/list` that the list does not name. The app-server process SHALL be keyed on the selection. The bridge SHALL NOT call `skills/config/write`. Skills that appear after launch under `allow-only` SHALL be declared as the gap `allow-only-skills-added-after-start`.

#### Scenario: Codex disables a skill without writing config
- **WHEN** `codex app-server` starts through the bridge, without credentials, with a temporary `CODEX_HOME` holding skills and the selection disables one of them
- **THEN** `skills/list` reports that skill with `enabled: false` and the others enabled, and no `config.toml` is created or changed

### Requirement: UI, CLI and SDK share one mutation
The Skills page, the CLI command `sandy skill selection [inherit|disable|allow-only|on|off] [names...]` and the SDK method `skills.experimental_setSelection` SHALL all go through `PUT /settings/skill-selection`, and SHALL compute name toggles with the one domain helper `setSkillNamesEnabled`. `skills.experimental_getSelection` and `sandy skill selection` without arguments SHALL read through `GET /settings/skill-selection` and SHALL NOT write anything. The result SHALL carry the stored selection, the provider status and `pendingThreadIds`.

#### Scenario: CLI and SDK store the same selection
- **WHEN** `sandy skill selection off grill-me` runs from `inherit`
- **THEN** the stored selection is `{mode: "disable", names: ["grill-me"]}`, the same value `skills.experimental_setSelection` stores for that input

### Requirement: Skills page controls
The Skills page SHALL offer, without a new modal: a name-level switch on each overview row and on the skill page; a Skill selection menu with all skills off (`allow-only []`), only the shown skills on (`allow-only` of the names left by search and filters), the shown skills off, and every skill on (`inherit`); an Off mark on every row of a disabled name; and a standing note that a change applies to sessions that start afterwards, that a name covers every copy, and that the selection decides what agents load, not what they can read.

#### Scenario: All off and only selected on
- **WHEN** the owner picks Turn all skills off and then switches on `review`
- **THEN** the page stores `{mode: "allow-only", names: []}` and then `{mode: "allow-only", names: ["review"]}`

#### Scenario: Only the shown skills on
- **WHEN** the owner searches `review`, two skills remain, and the owner picks Only the 2 shown skills on
- **THEN** the page stores `allow-only` with exactly those two names

### Requirement: Change applies to new and restarted sessions
After a selection change, the Skills page, the CLI output and the SDK result SHALL name the running threads that keep the old selection until their running work ends (`pendingThreadIds`) and SHALL offer the existing stop (`sandy thread stop`, the toast's Stop action through `sdk.threads.stop`). They SHALL NOT stop or restart any thread themselves.

#### Scenario: No automatic restart
- **WHEN** `grill-me` is disabled while two threads run a turn
- **THEN** both runtimes keep running, the CLI output lists both thread ids, and the Skills page toast offers Stop 2 threads without stopping either
