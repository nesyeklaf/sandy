# Sandy as a private repository

## ADDED Requirements

### Requirement: Nothing sandy scaffolds or runs needs anonymous access to its repository
Sandy SHALL NOT reference `raw.githubusercontent.com/sandy-sdk/sandy` or release downloads of `sandy-sdk/sandy` in code, templates or plugin `components.json` files that run or are fetched without the owner's GitHub credentials.

#### Scenario: Scaffolded plugin adds a registry component without a token
- **GIVEN** a host without any GitHub token
- **WHEN** `sandy plugin new demo` runs and a component is added from the `@sandy` registry
- **THEN** the component resolves from the installed SDK version, and no request goes to github.com

#### Scenario: No anonymous repository URL left
- **WHEN** `git grep -n -E "raw.githubusercontent.com/sandy-sdk/sandy|sandy-sdk/sandy/releases"` runs outside docs and history
- **THEN** it finds nothing

### Requirement: Sandy's code is not published publicly
While the repository is private, no sandy workflow SHALL publish sandy's code or builds to a public registry.

#### Scenario: Release run
- **WHEN** `publish-sandy-app.yml` runs for a release or a nightly
- **THEN** no job publishes to registry.npmjs.org

### Requirement: Workflows follow the repository's new name
Workflow guards SHALL use the transferred repository's name, so no job is skipped because of the transfer.

#### Scenario: Scheduled job after the transfer
- **GIVEN** the repository is `sandy-sdk/sandy`
- **WHEN** the scheduled `ci-health` workflow fires
- **THEN** its job runs instead of being skipped

### Requirement: CI within a fixed GitHub budget
Sandy's Linux jobs SHALL run on boat runners. GitHub-hosted Windows and macOS jobs SHALL run on pushes to `main`, release tags, nightly and manual dispatch, and on pull requests only when labelled `ci:full` or when platform files change.

#### Scenario: Ordinary pull request
- **WHEN** a pull request changes only `apps/server`
- **THEN** its Linux jobs run on boat labels and no GitHub-hosted Windows or macOS job runs
