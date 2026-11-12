# Plugin source replacement

## ADDED Requirements

### Requirement: Replace an installed plugin's source and keep its state
Sandy SHALL let the owner give an installed plugin a new source of any supported kind (path or git) through a `replaceSource` install request. The plugin's settings, secrets, schedules, data directory and enabled state SHALL be kept.

#### Scenario: Path to git
- **GIVEN** plugin `thread-namer` is installed from a path source with settings, a secret and a schedule
- **WHEN** `sandy plugin install git:<repo>@^0.1 --subdirectory sandy/thread-namer --tag-prefix thread-namer-v --replace-source --yes` runs
- **THEN** `sandy plugin source thread-namer` shows the git source and resolved tag, the settings, secret and schedule are unchanged, and the plugin is running

#### Scenario: Git back to path
- **GIVEN** a plugin installed through `--replace-source` from git
- **WHEN** `--replace-source path:<dir>` runs
- **THEN** it runs from the path with the same state

### Requirement: Replacement is all or nothing
Sandy SHALL stage, validate and build the new source before switching. If any step fails, the old source SHALL stay active and unchanged.

#### Scenario: Build failure keeps the old source
- **GIVEN** the new source's server bundle fails to build
- **WHEN** the replacement runs
- **THEN** the command exits non-zero with the build error, and `sandy plugin source <id>` still shows the old source with the plugin running

#### Scenario: Engine mismatch refused
- **GIVEN** the new source's `engines.sandy` excludes the running sandy version
- **WHEN** the replacement runs
- **THEN** it is refused with the engine reason, and nothing changes

### Requirement: Replacement keeps the plugin id
Sandy SHALL refuse a replacement whose manifest id differs from the installed id, and a replacement of bundled or builtin plugins.

#### Scenario: Id mismatch
- **WHEN** `--replace-source` points at a source whose manifest id is `other` for installed id `value`
- **THEN** it is refused with both ids named, and nothing changes

#### Scenario: Builtin refused
- **WHEN** `--replace-source` targets a `builtin:` or `sandy--` plugin
- **THEN** it is refused

### Requirement: One implementation on every surface
The server install route and job, the SDK client, the `sandy plugin install --replace-source` CLI flag and Settings → Installed plugins → Change source SHALL all use one implementation, which the existing path-to-path move SHALL also use. One contract test table SHALL run against every surface. The plugins chapter of the sandy guide SHALL document the flag instead of "remove and reinstall".

#### Scenario: Same result on CLI and SDK
- **WHEN** the contract table runs the same path → git replacement through the CLI and through the SDK client
- **THEN** both produce the same source, history entry and retained state

#### Scenario: Confirmation like install
- **WHEN** `--replace-source` runs without `--yes` in a non-TTY
- **THEN** it refuses, as install does
