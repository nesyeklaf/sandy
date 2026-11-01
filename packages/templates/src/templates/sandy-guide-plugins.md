---
kind: instruction
title: sandy Guide — Plugins
summary: Command reference for installing, configuring, and running sandy plugins, a summary of the bundled plugins, and the plugin authoring loop.
intent: Provide complete plugin management documentation, route each bundled plugin to its own skill, and route plugin authors to the sandy-plugin-authoring skill.
editingNotes: Keep flags accurate against the CLI implementation (apps/cli/src/commands/plugin.ts, apps/cli/src/commands/marketplace.ts) and the server plugin service; a CLI test asserts every `sandy plugin` and `sandy marketplace` subcommand and flag appears in this chapter. Each bundled plugin gets a two-to-three-line summary here; its manual lives in the plugin's own skill. The full authoring reference is the sandy-plugin-authoring builtin skill.
---
Plugin commands

A sandy plugin is a TypeScript package that extends sandy with server code, an
optional entry that runs on enrolled hosts, UI, agent skills and tools, and
`sandy` CLI subcommands. Plugins are full-trust code.

Builtin plugins (`builtin:<name>`) ship with sandy and install automatically.
Official store plugins ship with the app and install on request; third-party
plugins come from marketplaces, Git, or a local path. Plugin state lives
under `<sandy-data-dir>/plugins/<id>/` (SQLite database, secrets, logs).

  sandy plugin search <query>       Search the store: the bundled official
                                 plugins plus every registered marketplace.
                                 Matches id, name, description, category, or
                                 tag; status shows installed, compatible,
                                 requires newer sandy, or `id in use by <source>`
  sandy plugin install <entry>      Install an official plugin by name (docs,
                                 memory, tasks, github, ...),
                                 <entry-id>@<marketplace>, a Git repository
                                 URL, a local path, builtin:<name>,
                                 git:<url>[@<ref|semver-range>].
                                 Installs ask for confirmation; --yes skips it.
                                 --subdirectory <path> or --plugin <name>
                                 selects one plugin of a multi-plugin
                                 repository; --tag-prefix <prefix> scopes a
                                 git: semver range. Installing a local path
                                 for an id already installed from another
                                 path moves it and keeps its settings.
                                 Installs run one at a time as server jobs
                                 that continue if the CLI or app disconnects;
                                 a repeat request joins the active job.
                                 --no-wait starts the job and prints its id
  sandy plugin install-jobs         List queued, running, and recently finished
                                 installs (--json for the jobs)
  sandy plugin cancel-install <job> Cancel an install: a queued job is dropped;
                                 a running job stops its download or build
                                 and installs nothing, unless it already
                                 started registering, which then finishes
  sandy plugin outdated             Check installed plugins for compatible
                                 updates (--json for raw results), including
                                 newer releases blocked by engine ranges
  sandy plugin update <id> | --all  Apply compatible updates for one plugin or
                                 every tracking plugin. Same confirmation as
                                 install (--yes skips; non-TTY refuses
                                 without --yes)
  sandy plugin list                 Status, services, schedules, handler timings,
                                 and contributed CLI commands. `sandy status`
                                 also names enabled plugins that are
                                 incompatible, failed, or missing
  sandy plugin source <id> [--json] Requested and resolved source, subdirectory,
                                 semver range and resolved tag, engine ranges,
                                 install time, and recent activation history
  sandy plugin enable|disable <id>  Load or unload an installed plugin. A
                                 builtin you never toggled follows sandy's
                                 default; an explicit choice persists across
                                 releases
  sandy plugin safe-mode [on|off]   Show or change safe mode. `on` stops every
                                 plugin you installed (official store plugins
                                 included) without changing its enabled
                                 setting; builtins keep running. `off`
                                 restarts them and exits 1 if any fail.
                                 Installs and updates of stopped plugins are
                                 refused until it is off
  sandy plugin reload [id]          Restart plugins on their current sources.
                                 Exits 1 when one does not come up (the
                                 previous instance is kept or degraded)
  sandy plugin config <id> [set <key> <value> | unset <key>]
                                 Show or change a plugin's declared settings.
                                 Running plugins receive changes live; a
                                 plugin waiting for configuration retries
  sandy plugin logs <id> [-n N] [-f]  Print (or follow) a plugin's log
  sandy plugin run <id> [args...]   Run a plugin command explicitly (also works
                                 when a core command owns its name)
  sandy plugin token <id> [--rotate]  Print the token for a plugin's
                                 token-authenticated HTTP routes; --rotate
                                 replaces it
  sandy plugin remove <id>          Uninstall and delete the plugin's settings,
                                 secrets, and schedules (local path sources
                                 stay on disk; builtin removals are
                                 remembered)
  sandy plugin prune [--dry-run]    Delete cached git: plugin versions no
                                 installed plugin uses (left by earlier sandy
                                 releases, rolled-back updates, or
                                 interrupted operations) and leftover cache
                                 directories, and print what was freed.
                                 Updates and removals already delete what
                                 they replace. Never touches a running
                                 version or a local path source. Also in the
                                 command palette

  sandy marketplace add <source>    Add a marketplace from git:<url>[@<ref>] or
                                 path:<directory>.
                                 Adding a marketplace installs nothing. For a
                                 git: source, --subdirectory <path> reads
                                 marketplace.json from that directory of the
                                 repository instead of its root
  sandy marketplace list            Name, source, entry count, and last refresh
                                 (--json for raw rows)
  sandy marketplace refresh [name]  Re-read one catalog or all of them. Never
                                 installs, updates, or runs plugin code; a
                                 failed refresh keeps the last valid catalog
                                 and exits non-zero
  sandy marketplace remove <name>   Forget a marketplace. Plugins installed from
                                 it keep running as direct installs and keep
                                 updating from their recorded source.
                                 sandy-official cannot be removed

Installed plugins and their settings also appear under Settings → Installed
plugins.

Plugin CLI commands

A plugin can register one top-level `sandy` subcommand (for example
`sandy github …`); run it like any core command. Core command names win on a
collision, and `sandy plugin list` then shows the `sandy plugin run <id>` form.
Inside agent threads the generated `plugin-commands` skill lists every
available plugin command. Most plugin commands accept `--json` and `--help`.

Bundled plugins

Each bundled plugin documents its commands and behavior in its own skill.

- Prompt Library (builtin, disabled by default): enable with
  `sandy plugin enable sandy--prompt-library`. Open **+ → Prompts…** or press
  **Ctrl+R** to search, preview, star, and insert prompts. Its commands and
  behavior are documented in the `prompt-library` skill.
- Custom instructions (builtin): up to 4,096 characters saved under
  Settings → Custom instructions are added to every agent task on this host.
  `sandy instructions get`, `sandy instructions set <text...>`, and
  `sandy instructions clear`.
- Account Pooler (builtin, off by default): pools Claude and Codex accounts
  behind the sandy server with quota-aware failover. Run
  `sandy plugin enable account-pool`, then `sandy pool account add`,
  `sandy pool status`, and `sandy pool routing`; see the `account-pool` skill.
- Keep Awake (builtin): prevents idle sleep on selected macOS and Windows
  hosts while sandy runs; closing the lid still sleeps.
  `sandy keep-awake status|enable|disable [--json]`, `sandy keep-awake hosts all`,
  or `sandy keep-awake hosts <host-id>...`.
- Concurrency limit (builtin): caps running threads overall and per host.
  `sandy concurrency-limit status|global|host`; see the `concurrency-limit`
  skill.
- Provider retry (builtin): queues an automatic retry after provider
  overloads, server or connection errors, and subscription-window limits.
  `sandy provider-retry status|explain|retry|cancel`; see the `provider-retry`
  skill.
- Thread list (builtin): owns the sidebar's layout preferences, synced to
  every window. `sandy thread-list prefs list|get|set|reset`; see the
  `thread-list` skill.
- Push notifications (builtin): notifies web and desktop clients
  when a thread needs attention.
  `sandy push-notifications status|test|thread`; see the
  `push-notifications` skill.
- Secrets (builtin): `sandy secret request <NAME...> --write-env <path>` collects
  credentials through a secure form into a dotenv file without exposing them
  to the agent; see the `secrets` skill.
- Inline previews (builtin): shows an HTML page inline in a reply, from a
  fenced `inline-vis` code block or a `::inline-vis{file="demo.html"}`
  workspace or thread-storage file; see the `inline-vis` skill.
- MCP server (builtin, disabled by default): `sandy plugin enable sandy--mcp` lets
  an MCP client on this machine or your tailnet control this sandy; a client can
  run any `sandy` command. `sandy mcp status`; see the `mcp` skill.
- Storage & retention (builtin, disabled by default): enable with
  `sandy plugin enable sandy--storage-retention`. Owns thread retention policies
  and machine storage cleanup through its sidebar panel and `sandy storage`
  commands; see the `storage-retention` skill.
- Automations (builtin): recurring or one-shot agent prompts and stored
  server scripts. `sandy automation create|list|show|update|pause|resume|run|runs|delete`;
  see the `automations` skill.
- Workflows (builtin, off by default): durable JavaScript orchestration of
  worker threads. Run `sandy plugin enable workflows`, then
  `sandy workflows validate|run|status|history|list|stop`; see the `workflows`
  skill.
- Memory (official, `sandy plugin install memory`): durable cross-provider
  agent memory. `sandy memory catalog|search|get|add|update|forget|history`;
  see the `memory` skill.
- Docs (official, `sandy plugin install docs`): document vaults with a
  pull/edit/push loop and reviewable proposals.
  `sandy docs vaults|list|read|pull|status|push|propose`; see the `docs` skill.
- Tasks (official, `sandy plugin install tasks`): a task tracker with agent
  delegation. `sandy tasks show|list|comment|update|attach`, and
  `sandy tasks --help` for the rest; see the `tasks` skill.

Multi-plugin repositories

One repository can hold several plugins, each an ordinary plugin directory
with its own package.json. An optional `.sandy/plugins.json` collection manifest
indexes them:

  {
    "schemaVersion": 1,
    "name": "acme-plugins",
    "plugins": [
      { "name": "sidebar", "source": "./plugins/sidebar" },
      { "name": "status", "source": "./apps/status" }
    ]
  }

Every source is a repository-relative directory starting with "./"; absolute
paths, "..", the repository root, duplicate names, and unknown fields are
rejected. The file is an index only: identity, branding, entry points, and
engine ranges stay in each plugin's manifest.

  sandy plugin install git:github.com/acme/repo@main --plugin sidebar
  sandy plugin install git:github.com/acme/repo@main --subdirectory plugins/sidebar
  sandy plugin install path:/work/repo --plugin sidebar

--subdirectory works without a collection manifest; --plugin resolves a name
from .sandy/plugins.json. When a repository with a collection manifest is not a
plugin itself and neither flag is given, the install fails and lists the
entry names. sandy records the subdirectory, so outdated, update, and remove
work per plugin.

Marketplaces

`sandy-official` lists the plugins bundled with the app. It reads a local catalog
and never uses the network; install its entries by bare name or qualified name
(`sandy plugin install docs` or `sandy plugin install docs@sandy-official`). An app
update also updates the bundled copy.

sandy makes no network request to list a marketplace: only `path:` and `git:`
marketplaces are supported, and sandy reads them from disk or a git checkout. An
invalid manifest keeps the last valid catalog. Builtins show "Built in".
`sandy plugin search --json` returns the `installedByDefault` and long-form
`overview` fields.

Anyone can host a third-party marketplace:

  sandy marketplace add git:github.com/acme/sandy-marketplace@main
  sandy marketplace add git:github.com/acme/agent-plugins@main --subdirectory sandy
  sandy marketplace add path:/work/acme-marketplace

--subdirectory follows the same path rules as `sandy plugin install
--subdirectory`; sandy reads marketplace.json and relative icons from that
directory on every refresh. `source.git.subdir` in a catalog entry stays
relative to the repository root.

The manifest `name` is the marketplace identity; duplicates and the reserved
`sandy-official` and `sandy-community` names are refused. Install an entry of a
specific marketplace with <entry-id>@<marketplace>:

  sandy plugin install thread-hover-cards@acme-plugins

A bare id resolves across every marketplace: one match installs, several
matches fail and list the id@marketplace choices. Other source forms bypass
catalog resolution. Before installing from a third-party marketplace, sandy shows
the marketplace, the entry's author, and the true source, including the exact
release tag and commit a range lands on. `--yes` skips the prompt, not the
resolution, and the install is refused if the listing or resolved commit
changes after confirmation. Settings → Plugin marketplaces manages the same
list. To publish a marketplace, see the sandy-plugin-authoring skill.

Updates and pinning

sandy checks tracking sources every six hours. With the `pluginUpdates`
experiment on (`sandy settings experiment pluginUpdates true`, on for early
adopters), Settings → Updates checks again when it opens, lists each compatible
update with an Update button and Update all, shows candidates blocked by
engines.sandy or engines.sandyPluginSdk with the reason, and the sidebar updates
badge counts plugin updates. Updates are never applied automatically: `sandy plugin outdated` checks on
demand and `sandy plugin update` applies compatible candidates. Reinstalling an
installed managed plugin is refused; use `sandy plugin update`. A failed
activation restores the previous version and leaves the failure visible.

Git tags and commits, path sources, and bundled official plugins are pinned.
Omitted Git refs (the default branch), Git branches, and Git semver ranges track compatible
updates. Change a pinned git: source with `sandy plugin remove` (which
deletes settings, secrets, and schedules) and a fresh install. Edit a local
path plugin in place and `sandy plugin reload <id>`, or move it with
`sandy plugin install path:<new dir>`; both keep its configuration.

Managed git: installs refuse engines.sandy and engines.sandyPluginSdk
mismatches, manifest and artifact identity mismatches, and ids reserved by
bundled plugins. Git and path installs build the plugin on install (git
sources need `git`; sandy ships its own npm), and a build failure fails the
install.

Git semver ranges

A git source can track releases over the repository's tags:

  sandy plugin install git:github.com/acme/repo@^1.2.0
  sandy plugin install git:github.com/acme/repo@semver:^1.2.0
  sandy plugin install git:github.com/acme/repo@^1.2.0 --tag-prefix notes/

sandy keeps tags named [<tag-prefix>]vX.Y.Z and installs the highest one the
range allows. Prereleases are excluded unless the range names one. Without
--tag-prefix tags are repository-wide (v1.2.3); with it they version one
plugin (notes/v1.2.3).

sandy records the selected tag and its commit. If that tag later points at
another commit, sandy refuses it and names both commits; remove and reinstall
the plugin to accept the new commit.

A bare spec that reads as a range (`^1.2.0`, `1.x`, `>=1 <2`) resolves over
tags only when no branch or tag has that literal name; when one does, the
install fails and asks you to choose `@semver:<range>` or `@ref:<name>`. Bare
version tags such as `v1` and `v1.2.3` are always the literal tag.

Authoring a plugin

  sandy plugin new <name>           Scaffold ./sandy-plugin-<name> (backend, sidebar
                                 page, `sandy <name>` command, skill) and install
                                 its npm dependencies; no server required
  sandy plugin install .            Register the directory in place
  sandy plugin dev [path]           Watch sources, rebuild, and reload the
                                 installed plugin on every save
  sandy plugin build [path]         Compile the plugin into dist/; no server
                                 required
  sandy plugin types [path] [--check]  Sync the plugin's SDK and shimmed-package
                                 type pins to this sandy; --check only reports
  sandy plugin migrate [path] [--yes]  Move a plugin that vendors types/ to the
                                 @sandy-sdk/plugin-sdk npm package

The full authoring reference (manifest, every API surface, build and release,
testing, and marketplace publishing) is the built-in `sandy-plugin-authoring`
skill; in a checkout it lives under plugins/sandy-guide/skills/sandy-plugin-authoring/.
`plugins/` holds every bundled plugin and `examples/plugins/` holds reference
plugins.

## Inspect plugin RPC

`sandy plugin rpc list [plugin-id] [--method <exact-name>] [--json]` lists discoverable methods from running plugins, optionally restricted to one plugin. `sandy plugin rpc inspect <plugin-id> [method] [--json]` dumps registration and method descriptions plus input/output JSON Schemas. Copy the relevant schema into your consumer and call the existing plugin RPC endpoint. Discovery is opt-in advertising, not access control; method names may carry versions such as `provider-usage.v1.listResources`.

`sandy plugin rpc call <plugin-id> <method> [--input-file <json-path>] [--json]` invokes a method using server-side schema validation. Omitting the input file sends JSON null. Input files avoid putting sensitive values in command arguments. Handler refusals print their code and message and exit non-zero: `forbidden` (403), `not_found` (404), `conflict` (409), or `invalid` (422).

### Background updates

`sandy plugin update <id> --yes` starts a server job and waits by polling, so the activation stability check does not hold one HTTP request open. Add `--no-wait` to return immediately. Use `sandy plugin update-jobs [job-id] --json` for progress and results, including automatic rollback. Queued/running updates continue after the CLI or app disconnects. Finished jobs remain for ten minutes; jobs do not survive server restarts. Running updates cannot be cancelled midway through activation.

SDK: `plugins.applyUpdate({ pluginId })` waits; `plugins.experimental_startUpdate({ pluginId })` returns the job. Inspect with `plugins.experimental_updateJobs.list()` or `.get({ jobId })`. Raw HTTP callers opt in with `Prefer: respond-async`; legacy callers still receive the completed result.
