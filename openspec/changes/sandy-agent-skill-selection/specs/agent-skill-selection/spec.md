## ADDED Requirements

### Requirement: Selection policy shape and default
General settings SHALL hold `skillSelection` as exactly one of `{mode: "inherit"}`, `{mode: "disable", names}` or `{mode: "allow-only", names}`, where `names` are unique skill names. `inherit` SHALL be the default and SHALL keep today's behavior, including the existing `disabledSkillSources` filtering, in listing, injection and every provider launch. The settings route SHALL reject an unknown mode or extra keys with 400 and SHALL leave the stored policy unchanged.

#### Scenario: Missing setting keeps today's behavior
- **WHEN** a database without `skillSelection` and with `disabledSkillSources: ["sandy-plugins"]` starts a Pi, a Codex and a Claude Code session
- **THEN** `getAppSettings` returns `{mode: "inherit"}`, plugin skills are still left out, and the recorded `skills/configure` roots and launch arguments equal those of the same fixture without this change

#### Scenario: Disable and allow-only cannot mix
- **WHEN** PATCH general settings sends `skillSelection: {mode: "disable", names: ["a"], allow: ["b"]}`
- **THEN** the response is 400 and `getAppSettings` returns the previous `skillSelection`

### Requirement: Selection lives only in Sandy
Changing `skillSelection` through any surface SHALL write only Sandy's own settings and SHALL NOT write any file in a provider home, a skill root or a workspace, so the same agent started outside Sandy loads its skills unchanged.

#### Scenario: Toggle writes nothing outside Sandy
- **WHEN** `skillSelection` is set to `{mode: "disable", names: ["grill-me"]}` with a temporary HOME holding `~/.codex`, `~/.claude`, `~/.pi` and `~/.agents/skills`
- **THEN** every file under the temporary HOME keeps its previous bytes and mtime

### Requirement: Composition with sources and new skills
A skill SHALL be enabled exactly when its Sandy-owned source, if it has one, is not in `disabledSkillSources` and the policy enables its name. `inherit` SHALL enable every name, `disable` SHALL enable the names it does not list, and `allow-only` SHALL enable only the names it lists. A skill discovered after the policy was set SHALL therefore stay off under `allow-only` and on under `disable`.

#### Scenario: Disabled source wins over allow-only
- **WHEN** `disabledSkillSources` holds `sandy-user`, the policy is `allow-only ["review"]`, and `review` exists only in the Sandy user root
- **THEN** `sandy skill list --json` reports `review` disabled with reason `source`

#### Scenario: New skill stays off under allow-only
- **WHEN** the policy is `allow-only ["review"]` and `~/.agents/skills/lint-fix/SKILL.md` appears before the next listing
- **THEN** `lint-fix` is listed as disabled with reason `policy`, and the next session receives it as disabled

#### Scenario: All skills off
- **WHEN** the policy is `allow-only` with an empty list
- **THEN** every listed skill is disabled, and no injected skill root is sent to a new session

#### Scenario: Several skills off
- **WHEN** the policy is `disable ["grill-me", "deslop"]` while five skills are indexed
- **THEN** the listing reports exactly `grill-me` and `deslop` as disabled

### Requirement: Duplicate names and origins
The skill listing SHALL group skills by name and SHALL list, for each group, every origin with provider, root kind, path, registration id and duplicate kind (same-file, same-content, same-name). The selection SHALL apply to the name, so every origin of a disabled name is off for every provider, and the listing SHALL mark each affected origin.

#### Scenario: Same name in two native roots
- **WHEN** `grill-me` exists in `~/.agents/skills` and, with other content, in `~/.claude/skills`, and the policy disables `grill-me`
- **THEN** `sandy skill list --json` shows one `grill-me` group with two same-name origins, both disabled with reason `policy`, and the Pi launch arguments contain neither path

### Requirement: New and restored sessions receive the selection
When Sandy starts or restores a provider session, the server SHALL leave disabled Sandy-injected skills out of the injected roots and SHALL send the policy with the `skills/configure` bridge request. `HOST_DAEMON_PROTOCOL_VERSION` SHALL be incremented for the new field.

#### Scenario: Restored session gets the selection
- **WHEN** a thread whose runtime was stopped is resumed after `grill-me` was disabled
- **THEN** the recorded `skills/configure` request carries `{mode: "disable", names: ["grill-me"]}`, and the injected roots do not contain `grill-me`

#### Scenario: New session gets the selection
- **WHEN** a new Codex thread starts with the policy `allow-only ["review"]`
- **THEN** the recorded `skills/configure` request carries that policy before the first turn

### Requirement: Pi loads only enabled skills
When the policy is not `inherit`, the Pi bridge SHALL start pi with `--no-skills` and one `--skill` per enabled skill path from Pi's native roots, Pi packages and Sandy injection, keeping every other setting and extension. The Pi bridge SHALL declare skill selection as `enforced` only once the real-pi scenario passes in CI, and as `not-enforced` before that.

#### Scenario: Pi launch leaves out a disabled native skill
- **WHEN** `~/.pi/agent/skills` holds `grill-me` and `review`, and `grill-me` is disabled
- **THEN** the pi launch arguments contain `--no-skills` and `--skill` for `review`, and contain no path of `grill-me`

#### Scenario: Real pi does not discover a disabled skill
- **WHEN** the installed pi 1.5.1 starts through the Pi bridge in RPC mode, without credentials or network, with a temporary agent dir holding skills `grill-me` and `review`, a package skill `pkg-skill`, `enableSkillCommands: true` and `grill-me` disabled
- **THEN** the RPC `get_commands` result lists skill commands for `review` and `pkg-skill`, none for `grill-me`, and no `sourceInfo.path` inside the `grill-me` folder

### Requirement: Claude Code loads only enabled skills
The Claude Code bridge SHALL write `skillOverrides: off` for each disabled name into the SDK flag settings layer it already passes. It SHALL drop disabled names from the `skills` of Sandy agent definitions, and SHALL NOT change `settingSources`, user files or plugin files. It SHALL declare skill selection as `enforced` only once the main-session and subagent scenarios against the real SDK pass in CI.

#### Scenario: Claude override is a flag layer only
- **WHEN** `grill-me` is disabled and a Claude Code session starts
- **THEN** the SDK options carry `settings.skillOverrides["grill-me"] = "off"`, `settingSources` stays `["user","project","local"]`, and `~/.claude/settings.json` is unchanged

#### Scenario: Real Claude main session hides the skill
- **WHEN** the installed Claude Agent SDK 0.3.245 starts a query through the bridge, without a model turn, with a temporary config dir holding skills `grill-me` and `review` and `grill-me` disabled
- **THEN** `supportedCommands()` contains `review` and does not contain `grill-me`

#### Scenario: Real Claude subagent cannot use the skill
- **WHEN** a credentialed CI job runs a main turn that starts a subagent which asks the Skill tool for `grill-me` while `grill-me` is disabled
- **THEN** the Skill tool call for `grill-me` is refused, and the subagent transcript contains no text from the `grill-me` skill

### Requirement: Codex is enforced only after a probe
The Codex bridge SHALL pass disabled names as a `-c skills.config` override on `codex app-server` launch only after the probe scenario shows that codex 0.166.0 then reports the skill as disabled in `skills/list`. Until the probe passes, the listing and the Skills page SHALL mark Codex as not enforced. The bridge SHALL NOT call `skills/config/write`.

#### Scenario: Codex probe against the real binary
- **WHEN** `codex app-server` starts, without credentials, with `-c skills.config=[{name="grill-me",enabled=false}]` and a temporary `CODEX_HOME` holding `skills/grill-me/SKILL.md`
- **THEN** `skills/list` reports `grill-me` with `enabled: false`, and the temporary `config.toml` is unchanged

#### Scenario: Unproven provider is shown honestly
- **WHEN** a provider bridge declares skill selection as `not-enforced` and the policy disables `grill-me`
- **THEN** `sandy skill list --json` and the Skills page show that provider as not enforced for `grill-me`

### Requirement: UI, CLI and SDK share one mutation
The mutating actions, namely Skills page toggles, the CLI commands `sandy skill disable <name...>`, `sandy skill disable --all`, `sandy skill enable <name...>`, `sandy skill only <name...>` and `sandy skill inherit`, and the SDK method `skills.setSelection`, SHALL all go through the one server mutation behind PATCH general settings. The same input on each surface SHALL store the same `skillSelection` and return the same result. The SDK method `skills.getSelection` and the read views SHALL use one common read model and SHALL NOT write anything.

#### Scenario: One contract table across surfaces
- **WHEN** each row of one table (disable one, disable many, disable all, allow-only, inherit) runs through the route, the CLI and the SDK against a migrated database
- **THEN** all three surfaces store byte-equal `skillSelection` JSON per row and return equal affected-thread lists

#### Scenario: Skills page uses the same mutation
- **WHEN** the owner switches off `grill-me` on the Skills page
- **THEN** the page sends PATCH general settings with `{mode: "disable", names: ["grill-me"]}`

### Requirement: Change applies to new and restarted sessions
After a selection change, the Skills page, the `sandy skill` CLI output and the SDK result SHALL say that the change applies to sessions started or restarted afterwards. They SHALL name the loaded threads that still run with the old selection and offer the existing restart (`sandy thread stop`, Pi Lifecycle's Restart), and they SHALL NOT restart any thread themselves.

#### Scenario: No automatic restart
- **WHEN** `grill-me` is disabled while two threads have a loaded runtime
- **THEN** both runtimes keep running, and the CLI output names both threads and the `sandy thread stop` command
