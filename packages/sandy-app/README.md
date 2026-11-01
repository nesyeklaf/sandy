<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="sandy" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# sandy

[![npm version](https://img.shields.io/npm/v/sandy-app.svg)](https://www.npmjs.com/package/sandy-app)

sandy is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

This package provides the `npx sandy-app` launcher, bundled `sandy` CLI entry, and
Node SDK export. Every surface — the web app, CLI, and HTTP API — is a
first-class way to drive sandy. Work runs in threads you can follow live, steer at
any point, or hand off to another agent.

> Note: sandy is in active development. Workflows and surfaces are still evolving.

## Quick Start

sandy runs from npm and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js 22.19, 24, or 26.
- Git.
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), Cursor via ACP, [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), or another ACP-compatible agent.

If you already use one of these providers, sandy will pick up your existing
credentials. If you use multiple providers, you can mix and match per task.

### Supported host environments

- macOS
- Linux

<details>
<summary>Windows via Ubuntu on WSL2</summary>

Run all `sandy` commands inside WSL2, install Node.js, Git, and your provider CLIs
inside that WSL2 distro, and use Linux-style paths such as `/home/me/repo` or
`/mnt/c/Users/me/repo`.

Inside WSL2, use Linux paths rather than drive-letter or UNC paths. Repos
inside the WSL filesystem are recommended;
`/mnt/c/...` is intentionally supported so you can keep an existing Windows
checkout, but it is slower and less reliable for file watching.

</details>

### Install and run

```bash
npx sandy-app@latest
```

Then open: `http://localhost:38886`

To opt into the automated nightly channel:

```bash
npx sandy-app@nightly
```

Nightly versions are built from `main` and may be unstable. The `nightly`
dist-tag moves independently of the stable `latest` tag.

npm 12 and later block dependency install scripts by default. sandy needs those
scripts to build its native add-ons (`better-sqlite3`, `node-pty`,
`@parcel/watcher`). Without them sandy stops at startup with
`Could not locate the bindings file`. If your npm version is 12 or later, allow
the scripts for the install:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher sandy-app@latest
```

Or set the policy once for all global installs:

```bash
npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user
```

`npx sandy-app@latest` downloads the published `sandy-app` package, starts the server and
local host daemon, and serves the web app. It stores sandy-managed state under
`~/.sandy/` by default. If either managed child process exits unexpectedly, the
launcher restarts that child without stopping the other one. Press `Ctrl+C` in
the terminal to stop both processes and exit with status `0`.

If another live sandy owns the runtime record for the same data directory and a
healthy server answers on the configured local address, startup exits with
status `1` without starting either child process. The existing instance keeps
running. A runtime record without a healthy server does not prevent startup.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the data directory, keeping the five newest files per service. Output that
bypasses the logger, such as startup errors and crashes, goes directly to
`logs/server-stdio.log` and `logs/host-daemon-stdio.log`. These files append
across restarts; when one is over 10 MB as a service starts, it is renamed to
`-stdio.1.log`, replacing the previous one. The launcher prints status and log
locations without forwarding service output to the terminal, so a stalled
terminal cannot block service logging. To follow everything with the default
data directory:

```bash
tail -F ~/.sandy/logs/*.log
```

Launcher status output is plain when stdout is redirected, including in CI.
Set `FORCE_COLOR=1` to request color or `NO_COLOR=1` to disable it; `NO_COLOR`
takes precedence. In-place progress updates require a stdout TTY.

The same output capture applies to `sandy-server` and `sandy-host-daemon`.

To stop a sandy that runs in another terminal or in the background:

```bash
npx sandy-app stop
```

`stop` reads `sandy-app-runtime.json` from the data directory, confirms that the
recorded process really is that launcher, then stops it. Pass `--data-dir` when
the sandy you want to stop does not use the default `~/.sandy/`.

### The `sandy` command

To control sandy from outside sandy, open **Settings → General → Command line** and
choose **Install** next to **sandy CLI**. Threads in sandy already have `sandy`; this
is for your own terminals, scripts, and agents running outside sandy, such as
Claude Code or Codex. sandy links a launcher from `~/.sandy/bin/sandy` into a folder on
your PATH (`~/.local/bin` on Linux; `/opt/homebrew/bin`, `/usr/local/bin`, or
`~/.local/bin` on macOS). On Windows it adds `~/.sandy/bin` to your user PATH;
open a new terminal afterwards. **Remove** takes it off again. sandy leaves any
other `sandy` you already have in place.

From a terminal, before `sandy` is on your PATH:

```bash
npx --package sandy-app sandy settings cli-command install
```

### Updating from the app

After the server moves to another machine, the old data directory keeps
`server-moved.json`. `sandy-app` there starts no server: it runs this computer's
host daemon against the new server address in `config.json`, restarting it when
it exits, and answers the old server port. API requests get `410 server_moved`
with the new address; browser pages redirect to it for a direct address or link
to it for sandy connect. While a move back to this computer is in progress
(`server-import.json`), it frees that port for the incoming server. When
`server-moved.json` goes away, after that move completes or `sandy server unlock`,
it starts the server and co-located daemon again. `sandy-server` exits with status
`3` instead of starting, except for the incoming server of a move back.

From the app, add or open a project, start a thread, and choose the provider
you want that thread to use.

## CLI

The package also exposes the `sandy` CLI for an already-running sandy server:

```bash
npx --package sandy-app sandy --help
```

The CLI uses the same `SANDY_SERVER_URL` and sandy config resolution as the SDK. When
unset, it targets the default local packaged server at
`http://127.0.0.1:38886`.

## Scripting with the SDK

The package also exposes a Node SDK for scripts that drive an already-running
sandy server:

```ts
import { SandySdk } from "sandy-app";

const sandy = new SandySdk();
const thread = await sandy.threads.spawn({
  projectId: "proj_personal",
  environment: { type: "host", workspace: { type: "personal" } },
  prompt: "Summarize my active sandy work.",
});
await sandy.threads.wait({ threadId: String(thread.id), status: "idle" });
console.log(await sandy.threads.output({ threadId: String(thread.id) }));
```

`new SandySdk()` uses the same `SANDY_SERVER_URL` and sandy config resolution as the
CLI. Pass `new SandySdk({ baseUrl: "http://host:38886" })` for remote or test
targets (see the remote-access note below). Scripts launched by sandy already receive `SANDY_SERVER_URL` and
`SANDY_THREAD_ID` in their environment.

## Provider Credentials

sandy uses whichever providers you have configured. Common providers:

| Provider       | Setup                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`        | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                                                                                           |
| `claude-code`  | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                                                                                            |
| `cursor`       | Install [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent`) and authenticate per Cursor's docs.                                                                                                                       |
| `pi`           | Install [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) with `npm install -g @earendil-works/pi-coding-agent` (0.84.0 or newer) and authenticate per its docs; SANDY can run the install from Settings. |
| `opencode`     | Install [opencode](https://opencode.ai/) and authenticate per its docs.                                                                                                                                                         |
| `grok`         | Install [Grok Build](https://docs.x.ai/build/overview) and authenticate with `grok login` or `XAI_API_KEY`.                                                                                                                     |
| `hermes-agent` | Install [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation), configure credentials with `hermes model`, then verify ACP with `hermes acp --check`.                                          |

SANDY indexes the documented native skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. It includes user roots,
project roots, and compatibility roots such as `.agents/skills`. These skills
appear in the selected provider's `/` command menu. The Skills page and
`sandy skill list` show native skills for Claude Code, Codex, and Cursor. SANDY also
reads configured Pi, omp, Grok, and Hermes skill directories, plus enabled
provider plugin skills.

SANDY reads Pi's global `~/.pi/agent` files and each workspace's `.pi` files.
This includes settings, credentials, models, packages, extensions, skills,
prompts, themes, and context files. Pi extensions can add models and tools.
SANDY loads project resources only after Pi's saved or global trust policy approves
the workspace. An unresolved `ask` decision stays untrusted because SANDY has no Pi
trust prompt.
You can still use the Pi CLI and `/login` to create this configuration.

Custom ACP agents are configured through the ACP providers plugin's
`customAgents` setting: `sandy plugin config provider-acp set customAgents
'[...]'`. See the configuration docs for the optional `modelCli` and
`reasoningCli` or `nativeReasoning` reasoning settings. The optional
`nativeSkillRoots` field adds provider-native skills to the composer. Its
`user` paths resolve from the target host home directory. Its `project` paths
resolve from the selected workspace.
Top-level `sharedSkillRoots` uses the same `user` and `project` path format.
SANDY lists these sources as read-only skills. SANDY injects them into Codex, Claude,
Pi, and ACP threads. This permits one physical skill collection for SANDY and a
standalone provider CLI.

## Configuration

Use `sandy-app config` for persistent non-secret package settings under
`~/.sandy/config.json`:

```bash
npx sandy-app config set SANDY_APP_URL https://<machine>.<tailnet>.ts.net
npx sandy-app config list
npx sandy-app config refresh
```

For remote access, publish the default loopback listener with Tailscale Serve,
or list the server's tailnet or WireGuard addresses with `--server-bind-host`
(`SANDY_SERVER_BIND_HOST`); sandy always keeps `127.0.0.1` and refuses wildcard, LAN
and public addresses. See the multiple-devices guide.

Use `sandy-app client ssh-target` to configure local editor opens for remote
sandy servers under `~/.sandy/client.json`. The target is the value that works after
`ssh`, such as `devbox` or `user@devbox`:

```bash
npx sandy-app client ssh-target set https://sandy.example.test devbox --host-id host_abc
npx sandy-app client ssh-target list
```

Use `sandy-app env` for provider credentials under `~/.sandy/env.json`:

```bash
npx sandy-app env set OPENAI_API_KEY <key>
npx sandy-app env list
npx sandy-app env unset OPENAI_API_KEY
```

`env list` redacts all values. Config and env writes ask a running local sandy
server to reload; if sandy is stopped, the values apply on the next start.

For all config keys, precedence, startup flags, and source-development `.env`
behavior, see the
[configuration docs](https://github.com/nesyeklaf/sandy/blob/main/docs/configuration.md).

## Further Reading

- [Main README](https://github.com/nesyeklaf/sandy#readme)
- [Platform support](https://github.com/nesyeklaf/sandy/blob/main/docs/platform-support.md)
- [Configuration](https://github.com/nesyeklaf/sandy/blob/main/docs/configuration.md)
- [Using sandy on multiple devices](https://github.com/nesyeklaf/sandy/blob/main/docs/multiple-devices.md)
- [Worktree setup and teardown scripts](https://github.com/nesyeklaf/sandy/blob/main/docs/worktrees.md)
