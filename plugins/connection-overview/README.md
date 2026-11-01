# Connection overview

A bundled plugin that records every network connection sandy's own processes open or accept, and classifies each destination. It observes only and never blocks.

- The host worker reads `/proc/net/{tcp,tcp6,udp,udp6}` for the daemon's process tree once a second and maps sockets to processes through `/proc/<pid>/fd`. The server samples its own tree the same way. No root is needed.
- In the server process, `node:diagnostics_channel` (`undici:client:connected`, `http.client.request.start`) binds a hostname to the exact socket a `fetch` or `http` request opened, including plugin backends.
- Local networks are loopback, RFC 1918, link-local, the Tailscale ranges (100.64.0.0/10, fd7a:115c:a1e0::/48) and the subnets of every WireGuard interface (`DEVTYPE=wireguard` in `/sys/class/net/<if>/uevent`), re-read every 2 minutes.
- Classification, first match wins: outgoing sockets to local networks and the system resolver are allowed; a socket with a hostname is allowed when the host is listed, red otherwise; a provider CLI, git or provider bridge socket without a hostname is inferred when its IP matches a fresh resolution of a listed host only; a shared or stale match is yellow; anything else is red. An outgoing socket of a third-party program that sandy starts (provider and agent CLIs such as claude, codex, opencode and hermes, git, gh, ssh, and the browser-automation Chromium) that would be yellow or red is `third-party` instead: it is listed but does not count as red, because only what sandy itself sends is judged. sandy's own server, daemon and plugin processes and any other program stay judged. A daemon node process running `sandy-provider-bridge-worker.mjs` is shown as `sandy-provider-bridge`: it is sandy's own code talking to the model provider (titles, commit messages, usage), so it may be inferred but is never `third-party`. Incoming peers follow the incoming rule below, whatever the process.
- Incoming HTTP requests and WebSocket upgrades of the server are read from a bounded ring (8192 entries) that the server app fills before its host check, through `sandy.server.internal_DO_NOT_USE_requestPeers`. Each entry holds the socket peer, method, status and time only. Incoming rule, for these requests and for sockets accepted by the server and daemon trees: loopback is "origin unverifiable", Tailscale ranges and WireGuard interface subnets are allowed, anything else is red, RFC 1918 and link-local included. An overwritten stretch of the ring is recorded as a gap.
- The list is the model providers' hosts plus four exact GitHub hosts. Add more with the `extraAllowedHosts` setting; it lives in the server's database, never in git.
- Storage is one aggregate row per destination (at most 100,000, kept 7 days) and a gap table. Hitting the cap marks coverage incomplete.

`sandy connections status` exits 0 when every connected source is fresh (collector sampled within 5 s, transport replied within 30 s, no unreadable pid) and no gap over 10 s falls in the window; 1 when coverage is unhealthy; 2 when red rows exist.

Not measured: hosts that are not Linux, remote and sandbox environments, unreadable pids, connections shorter than about a second, unconnected UDP, sandy CLI processes outside the server and daemon trees, and the clients themselves.

## Overview page and alert

The plugin adds a **Connections** page to the navigation (`/plugins/sandy--connection-overview/connections`, icon Network). It reads one RPC, `overview.get` (window 1h, 24h or 7d), and the server invalidates it after every pull, so new rows appear without a reload. A coverage banner sits above the tables: it says "Not measured" when no source is connected or the read failed, "Measurement incomplete" when a collector or transport clock is stale, a host is unsupported, pids are unreadable, a gap lies in the window, the key cap was reached or the shown read is older than a minute (also without any further invalidation), and only otherwise "Measured: no red destination" (or the red count), always followed by what is not measured. It never says "all clear". Outgoing and incoming rows are listed in separate tables with every state, `third-party` included, red first. The Sources table shows the collector and the transport clock for each host.

Alert: after each pull the server starts an alert sweep outside the pull loop (at most one at a time, so a slow send never delays collection). The sweep claims every destination key that turned red since the last sweep and sends one `notifications.send` to the `push-notifications` plugin for all of them, with the fixed text "Connection overview" / "A connection to an unapproved destination was seen" (or "N connections to unapproved destinations were seen"). It never carries a host or IP. The keys are written to the `alert_claims` table before the send, so a crash between claim and send loses that alert but never repeats it. When `push-notifications` answers 404 or 503 (not installed or still starting, so nothing was delivered) the claims are released and the next sweep tries again; any other failure is logged and not retried. On start and on every allowlist edit, stored rows are reclassified with the current rules, so red rows recorded from third-party programs before they were listed become `third-party`. Editing `extraAllowedHosts` reclassifies rows but cannot send again, because claims are never removed. `third-party`, yellow, inferred, undetermined and unverifiable rows never alert. Without `push-notifications` installed the send fails and is logged; the row stays red on the page and in `sandy connections status`.

## Live verification recipe

Run on a Linux host against a started sandy (dev or installed), not in CI. Never write company hostnames into the result.

1. Access check: `tailscale serve status` shows the sandy port under Serve and no Funnel entry; `ss -ltnp` shows the sandy server listening on loopback or the tailnet address only, nothing on 0.0.0.0.
2. Control window: note the start time T0, make a sandy child process fetch an unlisted host (for example `node -e 'fetch("https://example.com")'` started from a sandy thread), wait 30 s, then `sandy connections list --red --since <T0> --json` must show that host red and the Connections page must show it in Outgoing. Exactly one notification arrives. Fetching it again, or adding it to `extraAllowedHosts` and removing it again, sends nothing more. If the control host is not red, the measurement is not proven and the evaluation window below proves nothing.
3. Evaluation window: start T1 after the control ended and let normal use run (24 h for the full run). Then:
   - `sandy connections status --since <T1>` must exit 0 (1 means coverage was unhealthy, 2 means red rows).
   - `sandy connections list --since 24h --json` and `sandy connections incoming --since 24h --json` are the evidence files.
   - Spot check: while a provider CLI runs, `ss -tnp` lists its peers; each must appear as a row (allowed, inferred or third-party). Yellow provider rows mean the answer is inconclusive, not clean.
4. Summary, without company hostnames: what was measured (sources, window, rows by state), what was inferred (inferred rows) and what was not measured (the list in `status`, plus any gap).

## Real /proc fixture

`src/fixtures/proc-host-daemon.json` is a sanitized snapshot of a real host daemon's process tree: zombie children, `node-MainThread` plugin hosts and provider bridge workers holding sockets to a provider. `src/sampler.fixture.test.ts` replays it through the sampler and the classifier, so process naming is tested on the shapes a host produces, not only on invented ones. Refresh it on a Linux host while a provider bridge worker holds an outgoing connection:

```sh
node scripts/capture-proc-fixture.mjs <host-daemon-pid> src/fixtures/proc-host-daemon.json
```

The script keeps pids, process names, states and socket tables. It drops every argument except Node flags and script file names, maps LAN, tailnet and public addresses to documentation ranges, and zeroes kernel pointers. Read the diff before committing it.
