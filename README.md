<p align="center">
  <img alt="Sandy" src="assets/sandy-logo.svg" width="144">
</p>

<h1 align="center">Sandy</h1>

<p align="center">
  An agentic IDE for running many coding agents at once, on your own machine.<br>
  Hard fork of <a href="https://getbb.app">BB</a>, built and run self-hosted.
</p>

<p align="center">
  <a href="./FORK.md">Origin and operations</a> ·
  <a href="./docs/DESIGN.md">Design</a> ·
  <a href="./docs/VISION.md">Vision</a> ·
  <a href="./docs/configuration.md">Configuration</a> ·
  <a href="./extensions/README.md">Extensions</a>
</p>

---

Sandy runs the provider CLIs you already have (Claude Code, Codex, pi and others) as threads you can follow live, steer at any point, or hand off to another agent. Every surface is a first-class way to drive it: the web and desktop app, the `sandy` CLI, the HTTP API and the plugin SDK. It can control, customize and automate itself, which is the groundwork for your own software factory.

> [!NOTE]
> Sandy is in active development. The core is stable, workflows and surfaces still change.

## Where Sandy comes from

Sandy is a **hard fork of [BB](https://getbb.app) by Michael Yong**, taken at BB 0.48.1 and published under the same MIT license (see [LICENSE](./LICENSE)). The BB code, its architecture and its plugin system are the foundation of everything here, and this project would not exist without that work.

After the fork point Sandy has no upstream: nothing is merged from BB any more, the BB-hosted services (connect, accounts, hosted web app) are removed, and every change is made in this repository. The product, package and command names, the data directories and the plugin ids were renamed to Sandy. `scripts/migrate-from-bb.mjs` moves an existing BB install over. [FORK.md](./FORK.md) records the fork point, what differs from BB, and how Sandy is built, released and deployed.

Several plugins in [`extensions/`](./extensions/README.md) are forks of plugins from the BB ecosystem; their origin is recorded in the `UPSTREAM.md` files.

## Run Sandy

Sandy is built from this repository. There are no hosted downloads and no `sandy-app` package on npm yet.

```bash
pnpm install
scripts/fork/release.sh build     # writes ~/sandy-fork-dist/<sha>/
```

The build produces `sandy-app-<version>.tgz` (server and machine daemon), a Linux AppImage and an Android APK. Install the server package:

```bash
npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher ~/sandy-fork-dist/<sha>/sandy-app-<version>.tgz
sandy-app
```

Then open `http://localhost:38886`. To deploy to a remote server, see [Deploy in FORK.md](./FORK.md#deploy); it is a transient systemd unit with a tested upgrade path and rollback. To use the `sandy` command outside Sandy, open **Settings → General → Command line** and choose **Install**, see [The sandy command on PATH](./docs/configuration.md#the-sandy-command-on-path).

Sandy needs Node and pnpm as pinned in `package.json`. The Android build needs a JDK 17 and the Android SDK. Native Windows needs [Git for Windows](https://git-scm.com/download/win), or use WSL2.

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
can run alongside each other and the installed `sandy-app` instance.

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
tarball smoke task when validating the packed `sandy-app` package
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

Sandy uses native add-ons (`better-sqlite3`, `node-pty`, `@parcel/watcher`). If npm does not run their install scripts, the binaries are missing and Sandy stops at startup with:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

- **npm 12 or later** blocks install scripts by default. Name the add-ons in `--allow-scripts=better-sqlite3,node-pty,@parcel/watcher` when you install the tarball, or set it once with `npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user`. npm 10 and 11 accept or ignore the flag.
- **`ignore-scripts=true` in `~/.npmrc`**: install with `npm_config_ignore_scripts=false` set for that one command.
- **A Node major-version change**, or a `node_modules` copied from another OS, CPU or libc: install the package again, or run `npm rebuild better-sqlite3`.

## License

MIT. Copyright (c) 2026 Michael Yong (BB) and nesyeklaf (Sandy). See [LICENSE](./LICENSE).
