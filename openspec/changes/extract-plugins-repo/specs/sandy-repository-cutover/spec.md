# Sandy repository cutover

## ADDED Requirements

### Requirement: New repository with full history, not a fork
`sandy-sdk/sandy` SHALL be a public repository that is not a fork, holding sandy's `main` and all tags from `nesyeklaf/sandy`.

#### Scenario: Same history
- **WHEN** the push is done
- **THEN** `gh api repos/sandy-sdk/sandy --jq .fork` is `false`, and `git ls-remote` shows the same `main` sha and the same tags on both repositories

### Requirement: Old URLs keep working
`nesyeklaf/sandy` SHALL be kept and never deleted, so the URLs installed versions call stay reachable.

#### Scenario: Scaffolded plugin from before the cutover
- **GIVEN** a plugin whose `components.json` points at `raw.githubusercontent.com/nesyeklaf/sandy/<tag>/packages/plugin-registry/r/{name}.json`
- **WHEN** a registry component is added after the cutover
- **THEN** the request returns the component

### Requirement: Sandy points at the new repository
After the cutover change, sandy's workflow guards, runtime URLs, the plugin registry URL it scaffolds, and its package metadata SHALL name `sandy-sdk/sandy`.

#### Scenario: Scheduled job on the new repository
- **WHEN** the scheduled `ci-health` workflow fires on `sandy-sdk/sandy`
- **THEN** its job runs instead of being skipped

#### Scenario: New scaffold
- **WHEN** `sandy plugin new demo` runs
- **THEN** its `components.json` registry URL names `sandy-sdk/sandy` at a tag that exists there, and fetching one item needs no token

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
