# Plugin SDK package name

## ADDED Requirements

### Requirement: SDK published under the organization's scope
Sandy SHALL name its Plugin SDK package `@<org>/plugin-sdk` and SHALL use that name in every import, `package.json`, script, template, CLI message, Plugin Guide page and doc. The `engines.sandyPluginSdk` manifest key SHALL stay unchanged.

#### Scenario: No stale name
- **WHEN** the stale-name ratchet runs in sandy
- **THEN** `@sandy-sdk/plugin-sdk` appears only in the legacy specifier constants, the migrate rewrite, the bundled-types re-export, their tests and history, and any new occurrence fails CI

#### Scenario: New plugins use the new name
- **WHEN** `sandy plugin new demo` scaffolds a plugin
- **THEN** its sources and `package.json` reference `@<org>/plugin-sdk`, and `sandy plugin build` succeeds

### Requirement: Plugins built against old names keep working
Sandy SHALL resolve `@sandy-sdk/plugin-sdk` and `@sandy/plugin-sdk`, including their subpaths, to the same SDK runtime as `@<org>/plugin-sdk` in server, host and app bundles, with no end date.

#### Scenario: Installed plugin after the upgrade
- **GIVEN** a plugin installed and built before the rename, whose bundles import `@sandy-sdk/plugin-sdk` and `@sandy-sdk/plugin-sdk/app`
- **WHEN** sandy with the rename is deployed
- **THEN** the plugin is `running` without a rebuild, and its app surface renders

#### Scenario: Migrate an old plugin
- **WHEN** `sandy plugin migrate` runs on a plugin that imports `@sandy-sdk/plugin-sdk`
- **THEN** its imports and `package.json` use `@<org>/plugin-sdk`, and it builds and typechecks against the bundled types
