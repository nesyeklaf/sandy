# Core command index

This index lists every command path that the core CLI registers, including aliases: `thread get|view|status` run `thread show`, `thread message|send` run `thread tell`, `thread messages|timeline` run `thread log`, `thread create|new` run `thread spawn`, `terminal read` runs `terminal output`, `plugin uninstall` runs `plugin remove`, and `environment get` runs `environment show`. At the top level `sandy host`, `sandy hosts`, and `sandy machines` run `sandy machine`, `sandy env` runs `sandy environment`, and the plurals `threads`, `projects`, `terminals`, `providers`, `plugins`, and `skills` run their singular command, unless a plugin registers that name. `sandy guide commands <group>` prints a group's commands with every option on one page. Check live help for flags and defaults.

## status

- `sandy status`

## settings

- `sandy settings`
- `sandy settings show`
- `sandy settings ai-services`
- `sandy settings ai-services show`
- `sandy settings ai-services set`
- `sandy settings ai-services test`
- `sandy settings cli-command`
- `sandy settings cli-command show`
- `sandy settings cli-command install`
- `sandy settings cli-command remove`
- `sandy settings general`
- `sandy settings replay-onboarding`
- `sandy settings completed-turns`
- `sandy settings experiment`
- `sandy settings keyboard`
- `sandy settings keyboard hints`
- `sandy settings keyboard list`
- `sandy settings keyboard set`
- `sandy settings keyboard reset`
- `sandy settings ui`
- `sandy settings ui list`
- `sandy settings ui get`
- `sandy settings ui set`
- `sandy settings ui reset`
- `sandy settings usage`
- `sandy settings reload`

`sandy settings usage` accepts `--refresh` to fetch fresh provider usage.

## project

- `sandy project`
- `sandy project source`
- `sandy project source add`
- `sandy project source update`
- `sandy project source delete`
- `sandy project attachment`
- `sandy project attachment upload`
- `sandy project attachment download`
- `sandy project list`
- `sandy project discover`
- `sandy project history`
- `sandy project reorder`
- `sandy project branches`
- `sandy project paths`
- `sandy project commands`
- `sandy project files`
- `sandy project content`
- `sandy project create`
- `sandy project show`
- `sandy project update`
- `sandy project delete`

## prompt-history

- `sandy prompt-history`
- `sandy prompt-history list`

## provider

- `sandy provider`
- `sandy provider list`
- `sandy provider enable`
- `sandy provider disable`
- `sandy provider models`

Use `--selected-model <model-id>` to discover its reasoning choices and include selected-only entries.

## machine

- `sandy machine`
- `sandy machine providers`
- `sandy machine enroll`
- `sandy machine env`
- `sandy machine env list`
- `sandy machine env set`
- `sandy machine env unset`
- `sandy machine create`
- `sandy machine list`
- `sandy machine show`
- `sandy machine reconnect`
- `sandy machine rename`
- `sandy machine remove`
- `sandy machine suspend`
- `sandy machine resume`
- `sandy machine reconcile`
- `sandy machine retry-cleanup`
- `sandy machine retry-update`
- `sandy machine provider-cli`
- `sandy machine provider-cli status`

## server

- `sandy server`
- `sandy server move`
- `sandy server move status`
- `sandy server move cancel`
- `sandy server export`
- `sandy server import`
- `sandy server unlock`
- `sandy server delete-old-copy`
- `sandy server install-machine-service`

## updates

## terminal

- `sandy terminal`
- `sandy terminal list`
- `sandy terminal create`
- `sandy terminal start`
- `sandy terminal show`
- `sandy terminal attach`
- `sandy terminal send`
- `sandy terminal resize`
- `sandy terminal output`
- `sandy terminal read`
- `sandy terminal wait`
- `sandy terminal rename`
- `sandy terminal restart`
- `sandy terminal close`
- `sandy terminal stop`

## thread

- `sandy thread`
- `sandy thread wait`
- `sandy thread spawn`
- `sandy thread create`
- `sandy thread new`
- `sandy thread fork`
- `sandy thread list`
- `sandy thread show`
- `sandy thread get`
- `sandy thread view`
- `sandy thread status`
- `sandy thread log`
- `sandy thread messages`
- `sandy thread timeline`
- `sandy thread output`
- `sandy thread open`
- `sandy thread pane`
- `sandy thread section`
- `sandy thread section list`
- `sandy thread section create`
- `sandy thread section rename`
- `sandy thread section delete`
- `sandy thread search`
- `sandy thread history`
- `sandy thread read`
- `sandy thread unread`
- `sandy thread reorder-pinned`
- `sandy thread count`
- `sandy thread queue`
- `sandy thread queue list`
- `sandy thread queue create`
- `sandy thread queue update`
- `sandy thread queue send`
- `sandy thread queue delete`
- `sandy thread queue reorder`
- `sandy thread queue group`
- `sandy thread tabs`
- `sandy thread tabs show`
- `sandy thread tabs set`
- `sandy thread update`
- `sandy thread archive`
- `sandy thread unarchive`
- `sandy thread restore-environment`
- `sandy thread pin`
- `sandy thread unpin`
- `sandy thread regenerate-title`
- `sandy thread delete`
- `sandy thread edit-message`
- `sandy thread tell`
- `sandy thread message`
- `sandy thread send`
- `sandy thread retry`
- `sandy thread stop`
- `sandy thread move-directory`
- `sandy thread compact`
- `sandy thread context`
- `sandy thread commands`
- `sandy thread options`
- `sandy thread clear`
- `sandy thread cancel-plan`
- `sandy thread clear-goal`
- `sandy thread interactions`
- `sandy thread interactions list`
- `sandy thread interactions show`
- `sandy thread interactions approve`
- `sandy thread interactions grant`
- `sandy thread interactions answer`
- `sandy thread interactions respond`
- `sandy thread interactions deny`

## environment

- `sandy environment`
- `sandy environment providers`
- `sandy environment list`
- `sandy environment delete`
- `sandy environment cleanup`
- `sandy environment show`
- `sandy environment get`
- `sandy environment paths`
- `sandy environment update`
- `sandy environment commit`
- `sandy environment archive-threads`

## file

- `sandy file`
- `sandy file read`
- `sandy file write`
- `sandy file list`
- `sandy file paths`
- `sandy file mkdir`
- `sandy file move`
- `sandy file remove`

## theme

- `sandy theme`
- `sandy theme list`
- `sandy theme set`
- `sandy theme new`
- `sandy theme check`
- `sandy theme dir`
- `sandy theme favicon`
- `sandy theme favicon set`
- `sandy theme favicon reset`
- `sandy theme show`
- `sandy theme reset`

## plugin

- `sandy plugin`
- `sandy plugin search`
- `sandy plugin list`
- `sandy plugin source`
- `sandy plugin install`
- `sandy plugin install-jobs`
- `sandy plugin cancel-install`
- `sandy plugin outdated`
- `sandy plugin update`
- `sandy plugin update-jobs`
- `sandy plugin new`
- `sandy plugin types`
- `sandy plugin migrate`
- `sandy plugin build`
- `sandy plugin dev`
- `sandy plugin reload`
- `sandy plugin rpc`
- `sandy plugin rpc list`
- `sandy plugin rpc inspect`
- `sandy plugin rpc call`
- `sandy plugin enable`
- `sandy plugin disable`
- `sandy plugin safe-mode`
- `sandy plugin prune`
- `sandy plugin config`
- `sandy plugin token`
- `sandy plugin run`
- `sandy plugin logs`
- `sandy plugin remove`
- `sandy plugin uninstall`

## marketplace

- `sandy marketplace`
- `sandy marketplace add`
- `sandy marketplace list`
- `sandy marketplace refresh`
- `sandy marketplace remove`

## skill

- `sandy skill`
- `sandy skill list`
- `sandy skill show`
- `sandy skill files`
- `sandy skill update`
- `sandy skill delete`
- `sandy skill sources`
- `sandy skill cli-skills-status`
- `sandy skill install-cli-skills`

## guide

- `sandy guide`

## diagnostics

- `sandy diagnostics`
- `sandy diagnostics cli-errors`

## voice

- `sandy voice`
- `sandy voice transcribe`

## browser

- `sandy browser`
- `sandy browser instances`
- `sandy browser tabs`
- `sandy browser create`
- `sandy browser acquire`
- `sandy browser connection`
- `sandy browser release`
- `sandy browser reveal`
- `sandy browser close`
- `sandy browser capture`
- `sandy browser watch`
- `sandy browser import-sources`
- `sandy browser import-cookies`
