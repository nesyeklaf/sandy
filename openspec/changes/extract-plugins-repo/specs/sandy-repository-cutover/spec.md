# Sandy repository cutover

## ADDED Requirements

### Requirement: New repository with full history, not a fork
`sandyhq/sandy` SHALL be a public repository that is not a fork, holding sandy's `main`, all tags, and the branches of the closed pull requests #37, #29, #23 and #2 from `nesyeklaf/sandy`.

#### Scenario: Same history
- **WHEN** the push is done
- **THEN** `gh api repos/sandyhq/sandy --jq .fork` is `false`, and `git ls-remote` shows the same `main` sha, tags and four branch shas on both repositories

### Requirement: Old URLs keep working
`nesyeklaf/sandy` SHALL be kept and never deleted, so the URLs installed versions call stay reachable.

#### Scenario: Scaffolded plugin from before the cutover
- **GIVEN** a plugin whose `components.json` points at `raw.githubusercontent.com/nesyeklaf/sandy/<tag>/packages/plugin-registry/r/{name}.json`
- **WHEN** a registry component is added after the cutover
- **THEN** the request returns the component

### Requirement: Sandy points at the new repository
After the cutover change, sandy's workflow guards, runtime URLs, the plugin registry URL it scaffolds, and its package metadata SHALL name `sandyhq/sandy`.

#### Scenario: Scheduled job on the new repository
- **WHEN** the scheduled `ci-health` workflow fires on `sandyhq/sandy`
- **THEN** its job runs instead of being skipped

#### Scenario: New scaffold
- **WHEN** `sandy plugin new demo` runs
- **THEN** its `components.json` registry URL names `sandyhq/sandy` at a tag that exists there, and fetching one item needs no token

#### Scenario: Old repository goes quiet
- **WHEN** Actions are disabled on `nesyeklaf/sandy`
- **THEN** no workflow runs there afterwards

### Requirement: boat only for the owner's own content
Sandy's jobs SHALL run on GitHub-hosted runners unless the owner `nesyeklaf` pushed, dispatched or re-ran them from the repository itself, which the `runs-on` routing checks together with boat's allow-list for the owner. Jobs on `pull_request_target`, publish jobs, and Windows and macOS jobs SHALL always run on GitHub-hosted runners.

#### Scenario: Outside pull request
- **WHEN** someone other than the owner opens a pull request from a fork
- **THEN** no job of it runs on a boat label

#### Scenario: Re-run by someone else
- **GIVEN** a workflow run the owner started on boat
- **WHEN** another user re-runs it
- **THEN** the re-run's jobs run on GitHub-hosted runners

#### Scenario: Routing check
- **WHEN** `scripts/check-runs-on.mjs` runs
- **THEN** every `runs-on` is a GitHub-hosted label or the routing expression, and no workflow combines `pull_request_target` with a boat label

### Requirement: SDK renamed to @sandyhq/plugin-sdk
The cutover change SHALL rename the Plugin SDK package and every import of it in sandy from `@sandy-sdk/plugin-sdk` to `@sandyhq/plugin-sdk`. Sandy SHALL keep loading plugins built against `@sandy-sdk/plugin-sdk` or `@sandy/plugin-sdk`. CI SHALL fail on any new `@sandy-sdk/plugin-sdk` reference outside an allow-list.

#### Scenario: Old-name plugin keeps loading
- **GIVEN** a plugin whose server, host and app bundles import `@sandy-sdk/plugin-sdk`
- **WHEN** sandy after the rename loads it
- **THEN** it runs as before, and its manifest's `engines.sandyPluginSdk` check is unchanged

#### Scenario: New plugins use the new name
- **WHEN** `sandy plugin new demo` runs, or `sandy plugin migrate` runs on an old plugin
- **THEN** its sources and `package.json` name only `@sandyhq/plugin-sdk`

#### Scenario: Stale name blocked
- **WHEN** a change adds `@sandy-sdk/plugin-sdk` to a file outside the allow-list
- **THEN** `scripts/check-plugin-sdk-scope.mjs` fails CI
