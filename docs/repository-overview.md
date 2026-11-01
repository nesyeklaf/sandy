# Repository Overview

This monorepo contains the packaged app plus the runtime services it bundles:

| Package or app                                                      | Role                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`packages/sandy-app`](../packages/sandy-app)                             | Published npm package, `npx sandy-app@latest` launcher, bundled `sandy` CLI entry, and public SDK export. |
| [`apps/desktop`](../apps/desktop)                                   | macOS/Linux/Windows Electron shell that supervises the packaged runtime and loads the sandy web UI.    |
| [`apps/app`](../apps/app)                                           | Web UI for inspecting projects, threads, environments, and running work.                            |
| [`apps/mobile`](../apps/mobile)                                     | iOS and Android client (Expo) for a sandy server over Direct URLs or sandy connect.                       |
| [`apps/server`](../apps/server)                                     | HTTP API, WebSocket notifications, state management, and server-owned product policy.               |
| [`apps/host-daemon`](../apps/host-daemon)                           | Host-local runtime that provisions workspaces and runs provider processes.                          |
| [`apps/cli`](../apps/cli)                                           | Scriptable `sandy` CLI for users and agents.                                                           |
| [`packages/sdk`](../packages/sdk)                                   | TypeScript SDK used by the CLI, package SDK export, and programmatic clients.                       |
| [`packages/agent-runtime`](../packages/agent-runtime)               | Provider runtime adapters and bridges for Codex, Claude Code, Pi, and ACP agents.                   |
| [`packages/config`](../packages/config)                             | Config parsing, defaults, managed package config schema, and environment variable definitions.      |
| [`packages/db`](../packages/db)                                     | SQLite schema, migrations, and data access helpers.                                                 |
| [`packages/server-contract`](../packages/server-contract)           | HTTP and WebSocket contract between clients and the server.                                         |
| [`packages/host-daemon-contract`](../packages/host-daemon-contract) | Command/event contract between the server and host daemons.                                         |

`sandy-app` also exposes a Node scripting SDK:
`import { SandySdk } from "sandy-app"`. See
[`packages/sandy-app`](../packages/sandy-app/README.md#scripting-with-the-sdk).

## Pinned Dependencies

Some dependencies are pinned to an exact version for reasons that are not
visible from `package.json` alone.

| Dependency                     | Where                    | Why                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opentelemetry/api` (`1.9.1`) | `apps/server`            | Better Auth and Drizzle each pull in `@opentelemetry/api`. Without an exact direct pin, pnpm can resolve two copies and TypeScript sees two distinct type identities, which fails the server typecheck. Bump both consumers together, not this pin alone. |
| Pi packages (`0.84.0`)         | `plugins/provider-pi`    | Pi extensions import the host's Pi modules. The packaged bridge keeps this exact package tree on disk so extensions share one compatible runtime. Bump the Pi packages together.                                                                          |
| `execa` (`9.6.1`)              | `packages/process-utils` | Execa 10 broke Windows missing-command classification and batch-file argument handling. Upgrade only after the Windows host package CI job passes.                                                                                                        |
