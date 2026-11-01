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

Every surface — the desktop app, web app, CLI, and HTTP API — is a first-class
way to drive sandy. Work runs in threads you can follow live, steer at any point,
or hand off to another agent.

> [!NOTE]
> sandy is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving.

<p align="center">
  <img alt="sandy desktop app showing a code review thread, dispatch panel, and task board" src="assets/app-screenshot.png" width="800">
</p>

## Use sandy

### Download the desktop app

The recommended way to start using sandy is the desktop app:

**[Download the latest desktop app](https://github.com/nesyeklaf/sandy/releases/tag/desktop-latest)**

The desktop app supports macOS on Apple Silicon (arm64). The Linux x64 AppImage
and the Windows x64 installer are alpha: expect problems, and please report
them. Intel Mac users should run sandy with `npx` instead. Native Windows needs
[Git for Windows](https://git-scm.com/download/win), which sandy uses for Git and
for environment setup scripts. You can also run sandy inside
[WSL2 (Windows Subsystem for Linux)](https://learn.microsoft.com/windows/wsl/install):
install WSL2 first, then run the `npx` command below from your WSL2 (Linux)
shell.

Early adopters can install
**[sandy Nightly](https://github.com/nesyeklaf/sandy/releases/tag/desktop-nightly)**
alongside the stable desktop app. It has a separate application identity,
yellow icon, and auto-update feed.

### Or run it anywhere with npx

```bash
npx sandy-app@latest
```

Then open `http://localhost:38886`.

To control sandy from outside sandy with the `sandy` CLI, open **Settings → General →
Command line** and choose **Install**. See
[The sandy Command On PATH](./docs/configuration.md#the-sandy-command-on-path).

To run the newest automated build instead:

```bash
npx sandy-app@nightly
```

npm 12 and later block dependency install scripts by default. sandy needs those
scripts to build its native add-ons. If your npm version is 12 or later, allow
the scripts for the install:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher sandy-app@latest
```

Or set the policy once for all global installs:

```bash
npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user
```

sandy uses the provider CLI you already have authenticated.

For install requirements, provider setup, configuration, and package-focused
docs, start with
[`packages/sandy-app`](./packages/sandy-app/README.md).

## Development

Use the development loop when working on sandy itself:

```bash
pnpm dev
```

That starts the Vite app and proxies API and WebSocket traffic to a separate
dev server. The launcher prints the actual ports at startup. Each checkout gets
a data directory under
`~/.sandy-dev/<checkout-instance>/` and deterministic high ports derived from the
checkout path. The checkout instance id is the sanitized path to the checkout,
relative to your home directory, plus a short hash suffix. Separate worktrees
can run alongside each other and the packaged `npx sandy-app@latest` instance.

To test the production bundle and serving path without switching to production
data or ports, use:

```bash
pnpm start:worktree
```

This builds the same optimized frontend and runtime artifacts as `pnpm start`,
then serves the app from the SANDY server on the checkout-specific dev server port.
It keeps the normal checkout-specific dev data directory and host-daemon port.
There is no Vite dev server or hot reload in this mode; rerun the command after
source changes.

For the Electron desktop shell, keep `pnpm dev` running and start the desktop
package in a second terminal:

```bash
pnpm exec turbo run dev --filter=@sandy/desktop
```

The desktop shell connects to this checkout's running dev app. Stop each command
with Ctrl-C in its terminal.

To use the dev app from another machine over Tailscale, start it with the
Tailscale browser origin configured:

```bash
SANDY_APP_URL=https://<machine>.<tailnet>.ts.net pnpm dev
```

Note the printed app port, then publish the loopback Vite listener in another
terminal:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<app-port>
```

Then open `https://<machine>.<tailnet>.ts.net`. Source dev binds both the Vite
app and main server to loopback by default; Vite continues to proxy API and
WebSocket traffic.

For direct access at `http://<tailscale-ip>:<app-port>` instead, run:

```bash
pnpm dev:remote
```

This binds the Vite app to all IPv4 interfaces. The remote browser must also
reach the printed server port for realtime updates, so put the machine's
tailnet or WireGuard address in `SANDY_SERVER_BIND_HOST` (for example in
`.env.local`); the server refuses wildcard, LAN and public addresses. The
server API is unauthenticated and permits command execution and file reads, so
restrict the Vite port to Tailscale traffic with the host firewall when the LAN
is not trusted.

To access the production-style worktree server directly from another machine,
set `SANDY_SERVER_BIND_HOST` to that address and run `pnpm start:worktree`.

To use the component storybook from another machine, run:

```bash
pnpm storybook
```

Ladle binds to all interfaces and configures its HMR WebSocket to use the
browser's current host instead of `localhost`. Do not run `pnpm storybook` on an
untrusted network.

Development behavior is intentionally split:

- the app hot reloads itself
- the server does not hot reload
- the host daemon does not hot reload

When you want the server and host daemon to pick up the latest build output, use:

```bash
pnpm dev:restart
pnpm dev:restart-server
pnpm dev:restart-host-daemon
```

These rebuild first, then restart only the targeted stateful services.

To run a production-mode build from a source checkout:

```bash
pnpm start
```

That builds only the app, server, and host-daemon runtime artifacts, then runs
the launcher directly against those workspace outputs. Use the `sandy-app`
tarball smoke task when validating the published `npx sandy-app@latest` package
layout.

```bash
pnpm sandy --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm sandy:dev --help        # source CLI, targets this checkout's dev instance
pnpm reset:dev            # clear this checkout's dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

## Repository Overview

See [Repository overview](docs/repository-overview.md) for the monorepo package and app map.

## System Overview

See [System overview](docs/system-overview.md) for runtime architecture, data model, and component boundaries.

## Further Reading

- [Vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using sandy on multiple devices](docs/multiple-devices.md)
- [Worktrees and setup scripts](docs/worktrees.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Troubleshooting

### `Could not locate the bindings file`

sandy uses native add-ons, for example `better-sqlite3` and `@parcel/watcher`. npm
downloads or builds those binaries in a package install script. If npm does not
run install scripts, the binaries are absent. sandy then stops at startup with this
error:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

There are two usual causes.

The first cause is npm 12 or later. Since npm 12, npm blocks dependency install
scripts by default and prints
`npm warn install-scripts N packages had install scripts blocked`. Name sandy's
native add-ons in `--allow-scripts` to let this one command run their install
scripts:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher sandy-app@latest
```

For a permanent install with the same setting, use:

```bash
npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher sandy-app
sandy-app
```

To allow them for all global installs on this machine, run
`npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user`.
npm 10 and 11 accept or ignore the flag, so it is safe on every supported Node.

The second cause is `ignore-scripts=true` in your `~/.npmrc`. Set the
`npm_config_ignore_scripts` environment variable to let this one command run its
install scripts:

```bash
npm_config_ignore_scripts=false npx sandy-app@latest
```

For a permanent install with the same setting, use:

```bash
npm_config_ignore_scripts=false npm install -g sandy-app
sandy-app
```

The environment variable applies to that one command only. Keep
`ignore-scripts=true` in your `~/.npmrc` if you want it for security.

The same error has other causes. A Node.js major-version change after the
install causes it. A copy of `node_modules` from a different operating system,
CPU architecture, or libc variant also causes it. To recover, install the
package again, or run `npm rebuild better-sqlite3`.

## Acknowledgements

<a href="https://blacksmith.sh"><img src="assets/blacksmith-ci.png" alt="CI powered by Blacksmith" width="400"></a>
