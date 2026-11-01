# Sandy: origin, release, operations

Sandy is a hard fork of [BB](https://getbb.app) by Michael Yong (MIT, see `LICENSE`), taken at BB 0.48.1. It has no upstream: nothing is merged from BB any more, and the services behind getbb.app are cut out. Every change is made here.

It is built and run on a self-hosted server reached over Tailscale. The scripts in `scripts/fork/` build, check and deploy it; `scripts/migrate-from-bb.mjs` moves an existing BB install (data directory, database, plugin ids) to Sandy names.

- Every commit must pass `scripts/fork/check-egress-hosts.sh`, `scripts/fork/check-package-manager-calls.sh` and the smoke run before deploy.

## Release

```sh
scripts/fork/release.sh          # test + build
scripts/fork/release.sh build    # build main only
```

The release builds a clean checkout of `main` and nothing else: a dirty tree, another branch or a detached `HEAD` fails before anything is built. It makes no git network call.

`build` writes to `~/sandy-fork-dist/<short-sha>/` (override with `SANDY_FORK_DIST`):

| Artifact | Use |
| --- | --- |
| `sandy-<version>-x86_64.AppImage` | Linux desktop app |
| `sandy-app-<version>.tgz` | Server and machine daemon package, what `deploy.sh` installs |
| `sandy-android-<sha>.apk` | Android app, arm64, debug-signed |
| `SHA256SUMS` | Checksums of the above |

Build requirements: Node and pnpm from `package.json`, a JDK 17 with `javac` (found under `~/.gradle/jdks` or `/usr/lib/jvm`, or set `JAVA_HOME`), and the Android SDK at `$ANDROID_HOME` (default `~/Android/Sdk`). JDK 21 does not build the APK.

The version number carries on from BB 0.48.1 at the fork point. Tell builds apart by their commit.

## Deploy

```sh
scripts/fork/deploy.sh AI ~/sandy-fork-dist/<sha>/sandy-app-<version>.tgz
```

Never deploy with a hand-written script, `nohup` or `setsid`, least of all from a thread that runs on the server being deployed. `systemctl stop` kills every process in the server unit's cgroup, `setsid` does not leave it, so the script dies with the unit before it installs anything. Only a transient unit (`systemd-run --user --unit=…`, which `deploy.sh` and `remote.sh` use) sits outside that cgroup.

`deploy.sh` copies the tarball and `remote.sh` to the host, compares checksums, and starts `remote.sh deploy` as a transient systemd user unit. The unit keeps running when the ssh session drops, which it does when the restarted server is the one carrying the session. `remote.sh deploy`:

1. finds the single `sandy-host-daemon-*.service` user unit (or `SANDY_UNIT`) and its `SANDY_DATA_DIR`,
2. refuses while any thread other than the one deploying (`SANDY_THREAD_ID`, passed on by `deploy.sh`) runs a turn, because the restart breaks that turn; `--force` overrides,
3. runs the upgrade test below; when it fails, the running version stays,
4. stops the server,
5. backs up `sandy.db`, `config.json` and the npm prefix to `<data-dir>/backup-pre-fork-<timestamp>` and records that path in `~/sandy-fork-last-backup`,
6. installs the tarball into the npm prefix, restoring the old package if npm fails,
7. sets `SANDY_APP_URL` to the tailnet URL and starts the server.

The upgrade test also runs on its own, with the live server untouched:

```sh
ssh AI 'bash ~/sandy-fork-remote.sh upgrade-test /tmp/sandy-app-fork.tgz'
```

It installs the tarball into a temporary npm prefix, copies `sandy.db` (an online SQLite backup), the config and the plugins without their host data, starts that server on spare ports, and passes when `/health` and `/api/threads` answer 200 and every plugin is `running` or `disabled`. This is how a migration over real data gets tested before the deploy, for example soft-deleted plugin rows that no fixture holds. The copy runs plugin services for about 20 seconds, but no host daemon, so no turn starts. `--skip-upgrade-test` skips it on deploy.

Check the result any time with `ssh AI 'bash ~/sandy-fork-remote.sh status'`. It prints the unit state, installed version, `SANDY_APP_URL`, the local and tailnet HTTP status, and the tail of `~/sandy-fork-deploy.log`.

Do not update the server through the sandy UI or npm. The `sandy-app` package on npm is not ours and would replace this build. Machine daemons started with `--auto-update` fetch the package from their server, so they follow the fork.

## Rollback

```sh
ssh AI 'bash ~/sandy-fork-remote.sh rollback'             # package and config only
ssh AI 'bash ~/sandy-fork-remote.sh rollback --with-db'   # also sandy.db
```

A newer sandy migrates `sandy.db` on its first start, and an older sandy does not know those migrations. So a rollback without `--with-db` fails when the deploy brought new migrations. Check with `git diff --stat <old>..<new> -- packages/db/drizzle`. `--with-db` restores the database as it was before the deploy and loses every thread, message and setting written since.

## Network

The server listens on `127.0.0.1:38886` only. Tailscale Serve publishes it inside the tailnet:

```sh
ssh AI 'bash ~/sandy-fork-remote.sh serve'   # sudo tailscale serve --bg --https=38886 http://127.0.0.1:38886
```

- URL: `https://<host>.<tailnet>.ts.net:38886`. On AI, port 443 belongs to nginx-proxy-manager, so Serve uses 38886.
- `serve --bg` persists in tailscaled's state and survives a reboot. The server unit is enabled and the user has lingering on, so it starts without a login. Neither has been tested with an actual reboot yet.
- Never use Funnel. The sandy API has no authentication of its own and can run commands, so the tailnet ACLs are the access boundary.
- `SANDY_SERVER_BIND_HOST` adds direct listeners, but only on tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or WireGuard interface addresses. The server refuses to start on `0.0.0.0`, `::`, LAN or public addresses.

Clients: the desktop app points at the tailnet URL through its custom server URL. The phone needs Tailscale running. A machine daemon is re-enrolled from the tailnet URL under Settings, Machines, Add machine.

## Differences from BB at the fork point

- `SandyNavigate.toThread(threadId, { experimental_messageSeq })` jumps to a message (`#msg=SEQ`) from plugins, with `split` too.
- `app.slots.experimental_threadTocExtension({ id, title, useBands, tab?, onBandClick?, onBandHover? })` adds topic brackets and a popover tab to the thread TOC rail, with drag-marked ranges (`railSelection`). The tab can be the popover's default (`tab.experimental_default`) and gets `activeSeq`, `hoveredBand` and `setHoveredRange` to link its rows with the brackets. Ticks get their seq from the `messageSeq` field of the conversation outline item (projection version 3).
- sandy connect, the machine tunnel, the account gate and the hosted web app (`apps/web`) are removed. Remote access is Tailscale Serve or `SANDY_SERVER_BIND_HOST` only.

## Migrating an existing BB install

```sh
node scripts/migrate-from-bb.mjs            # dry run: prints what would change
node scripts/migrate-from-bb.mjs --apply    # stop the BB server first
```

It moves `~/.bb`, `~/.bb-dev` and `~/.bb-machines` to the `.sandy*` names, renames `bb.db` and the runtime file, rewrites `BB_*` keys in `config.json` and `env.json`, and updates plugin ids, data-dir paths and the machine-auth user inside the database. Thread history is left as written. It copies the database to `backup-pre-sandy-<timestamp>` first. It does not touch the systemd unit: write the new unit, then `systemctl --user disable --now` the old one and `enable --now` the new one.
