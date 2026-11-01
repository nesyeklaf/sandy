# Using sandy on multiple devices

There are two separate ways to use more than one device with sandy:

- A browser device is a control surface for one sandy server. It can view projects,
  send prompts, and manage threads, but it does not execute them.
- An execution machine runs a host daemon. One sandy server can dispatch project
  sources and thread environments across several enrolled machines.

You can use either story independently or combine them.

In both stories one computer runs the sandy server. It stores your threads, the
database, and settings, and every browser and execution machine connects to it.
Pick a computer that stays on, such as a desktop, home server, or VM: while the
server machine is asleep or off, nothing can reach sandy and running threads may
stop. Settings → Machines badges it `server` once several machines are
connected, `sandy machine list` shows `server` in its Role column, and the server
machine cannot be removed.

## Open sandy from another browser

The recommended route keeps sandy on loopback and publishes it inside your tailnet
with Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38886
npx sandy-app config set SANDY_APP_URL https://<machine>.<tailnet>.ts.net
```

Start sandy with `npx sandy-app` and open the HTTPS URL. Tailscale ACLs are the access
boundary for this route; do not expose the server through Funnel or the public
internet.

To reach the server directly at a tailnet or WireGuard address, list that
address in `SANDY_SERVER_BIND_HOST`:

```bash
npx sandy-app env set SANDY_SERVER_BIND_HOST "100.101.102.103 10.8.0.1"
```

sandy always listens on `127.0.0.1` and additionally on each listed address. Every
entry must be a concrete tailnet address (`100.64.0.0/10` or
`fd7a:115c:a1e0::/48`) or an address of a WireGuard interface on the server
machine. sandy refuses to start with `0.0.0.0`, `::`, a LAN or public address, a
malformed entry, or a duplicate. The public API is unauthenticated and permits
command execution and file reads, so every tailnet device the ACLs admit and
every WireGuard peer can drive sandy: the Tailscale and WireGuard keys are the
authentication. Host firewall and upstream network rules remain separate from
this setting.

### Use editors installed on the browser device

Local editor integration is optional. It connects the remote sandy page to the
loopback-only helper started by the sandy desktop app or `npx sandy-app` on the
computer running the browser. The helper discovers installed editors and opens
paths without exposing its API to the network.

If that browser should open work-host files in its local editor, first make
sure sandy is running on the browser device. Verify `ssh <work-host>` succeeds
there, then map the server/work-host to that SSH target:

```bash
npx sandy-app client ssh-target set <sandy-server-origin> <ssh-target> --host-id <work-host-id>
```

Copy the work-host ID from `sandy machine list`. `--host-id` may be omitted when
the server has exactly one machine. A browser running on an enrolled execution
machine needs no SSH mapping for that same machine: connected daemons report
their helper ports to the server, and the browser discovers the matching local
helper after you enable integration.

Then open Settings → Files in that browser and enable **Local editor
integration**. The browser may ask once for permission to connect to software
on the computer. sandy does not request that permission during normal remote page
loads; it is only needed for discovering and launching local editors.

If Settings reports that it cannot connect to the helper:

1. Confirm the sandy desktop app or `npx sandy-app` is running on the browser device.
2. Confirm the browser allows local network access for the sandy page.
3. A helper enrolled with this exact server trusts its origin automatically.
   For a separate local sandy helper serving a custom HTTPS or Tailscale browser,
   configure that exact origin with
   `npx sandy-app config set SANDY_APP_URL <origin>` and restart sandy.
4. Return to Settings → Files and choose **Retry**.

Phones and tablets need no helper; editor-launch actions are simply unavailable.

## Use the sandy mobile app

The sandy mobile app is a client for a sandy server; it runs nothing itself. Add a
server by its direct URL: the Tailscale Serve URL, or
`http://<address>:38886` for an address listed in `SANDY_SERVER_BIND_HOST`. The
phone must be on the same tailnet or WireGuard network, and the same caveats as
for a browser apply. What the phone cannot do is listed in
[platform-support.md](platform-support.md#mobile-app).

### Push notifications on a self-hosted server

The built-in Push notifications plugin notifies connected web and desktop
clients over sandy's own live connection, so a self-hosted server makes no
outbound request for it. The sandy mobile app receives no push notifications yet.
Channel settings are in [configuration.md](configuration.md) and the
`push-notifications` plugin skill.

## Point the desktop app at another sandy

The desktop app's Server menu lists "This Mac" and a custom URL. When you
select a remote server, the app stops starting a sandy server on this Mac. It
starts one again only when you select "This Mac".

A remote server has no realtime link for keybindings and theme. The app re-reads
them when it starts, when it becomes active, and every five minutes.

## Add an execution machine

Open Settings → Machines and choose Add a machine. Run the generated one-line
installer on the computer that should
execute work. Choose Windows in the dialog for a PowerShell command; a Windows
machine needs Node.js 22.19 or newer and Git for Windows, and its daemon starts
when you sign in to Windows. It installs and enrolls a host daemon. Open the
server through its Tailscale Serve URL or a `SANDY_SERVER_BIND_HOST` address
before generating the installer; the loopback listener is not reachable from
another machine. When the server URL is a loopback address, the dialog does not
show an installer. It asks you to set up machine access first by choosing the address
machines should use. Once access is ready, the dialog also names the server
machine the new machine will depend on.

The installer always installs the exact host-only `sandy-app` package exposed by
that server at `/install/sandy-app.tgz`: the host daemon, provider/plugin workers,
native host dependencies, and bundled `sandy` CLI, but no web app or server. When
the server provides no package, or the download fails, the install fails with a
clear message; it never uses a `sandy-app` already on PATH and never falls back to
the npm registry. The installer verifies the route's SHA-256 digest and
skips reinstalling an identical artifact. Like `/install.sh`, the package route
is public. npm installs the package into the machine's sandy data directory, not
its system-wide global prefix, so enrollment needs neither `sudo` nor a PATH
change.

Each joined server gets its own daemon instance, data directory
(`~/.sandy-machines/<server-host>`, override with `SANDY_DATA_DIR` when running the
installer), local API port, and launchd/systemd service. The installer persists
the selected port in that data directory. Subsequent runs reuse it; pass
`--host-daemon-port <port>` to the installer to override the selection. One machine can therefore
serve several sandy servers at once, and joining never touches a full local sandy
install's `~/.sandy`. Each instance keeps its own `sandy-app` under that data
directory and self-updates against its own server, so servers running different
sandy versions on one machine remain isolated.

On Linux, the installer uses the current user's systemd manager (or a system
unit when run as root on a non-container systemd host). If the user bus is
unavailable on a systemd host, installation fails before enrolling or creating
a unit; rerun it from a systemd user session. In containers and on machines without systemd
as init, the installer runs a detached daemon instead. Set
`SANDY_INSTALL_SKIP_SERVICE=1` only when a detached daemon is acceptable: no
service starts it after a reboot. The temporary daemon used
for a first join is not supervised. When the installer starts a previously
joined daemon without a service, its launcher restarts it after crashes and
self-updates while the launcher remains running.

The installed launchd/systemd service enables `--auto-update`. If session open
reports a newer server protocol, the daemon downloads the server artifact,
verifies its SHA-256 digest, updates its private install, then exits so the
service manager restarts it. Failed attempts fall back to normal reconnect behavior with a persisted
exponential retry backoff from 5 seconds to 5 minutes. Settings → Machines and
`sandy machine retry-update <id-or-name>` can bypass the current backoff. A daemon
never downgrades itself to an older server protocol. To opt out, remove
`--auto-update` from
`~/Library/LaunchAgents/app.sandy.host-daemon.<server>.plist` or
`~/.config/systemd/user/sandy-host-daemon-<server>.service`, then reload the
service.

After it connects:

1. To create a project from that machine, choose New project, select the
   machine, and browse to its folder. To map an existing project there instead,
   add its path or clone source in project settings.
2. Select the machine when creating a thread, or use `sandy thread spawn --machine
<id-or-name> ...`.
3. Inspect enrolled machines with `sandy machine list`.

Machine names are conveniences and may be duplicated; CLI targeting by name
requires an unambiguous match. IDs are always accepted. Removing a machine from
Settings stops sandy from dispatching new work to it; remove a lost machine from
your tailnet or WireGuard peers as well.

Browser access and execution remain independent: opening sandy on a laptop does
not enroll that laptop, and enrolling it as a machine does not expose the sandy UI.
