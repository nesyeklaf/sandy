# SANDY guide

Control the SANDY introduction and bundled agent skills in Settings → Installed
plugins → SANDY guide. The plugin and all five settings default to enabled.

- `introduction`: send the SANDY CLI, thread, and link instructions.
- `skills`: make the selected bundled skills available.
- `sandyCli`: include `sandy-cli`.
- `pluginAuthoring`: include `sandy-plugin-authoring`.
- `skillCreator`: include `skill-creator`.

Use `sandy plugin config sandy-guide set <key> true|false` from the CLI, or
`sandy.sdk.plugins.updateSettings({ pluginId: "sandy-guide", values: { ... } })`
through the SDK. Changes apply when agent configuration is next assembled;
they do not erase instructions from an existing conversation.

Disabling the plugin removes its introduction and all three skills. The
settings affect this plugin's copies, not independently installed user or
provider skills. Other plugins keep their own skills. The generated
`plugin-commands` skill continues to describe enabled plugin commands.
