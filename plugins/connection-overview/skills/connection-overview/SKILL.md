---
name: connection-overview
description: Check which hosts sandy connects to, whether any destination is red, and whether the measurement is healthy, with sandy connections.
---

# Connection overview

The bundled `sandy--connection-overview` plugin records the connections of sandy's server and daemon process trees, including the provider CLIs they start. It observes only.

```sh
sandy connections status --since 1h          # exit 0 healthy, 1 coverage unhealthy, 2 red rows
sandy connections list --since 24h           # outgoing destinations
sandy connections list --red --since 30m --json
sandy connections incoming --since 24h
```

`sandy connections incoming` lists two kinds of incoming rows: sockets accepted by the server and daemon trees (source `server` or the host), and every HTTP request and WebSocket upgrade the server app received, rejected ones included (source `server-http`, one count per request). For `server-http` rows only the socket peer address decides the state; no request header (`Tailscale-User-*`, `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Host`) changes it. An incoming peer is `allowed` only from the tailnet (`tailnet peer`) or a WireGuard interface subnet (`bind interface peer`); LAN and link-local peers are `red` (`external peer`).

`--since` takes a duration (`30m`, `24h`, `7d`) or an ISO time.

States: `allowed` (outgoing: local network, system resolver, or a listed host bound to the socket; incoming: tailnet or WireGuard peer), `inferred` (a provider CLI, git or `sandy-provider-bridge` socket whose IP only matches a fresh resolution of a listed host), `yellow` (shared by listed and unlisted names, or a stale resolution), `red` (anything else), `unverifiable` (incoming over loopback: Tailscale Serve and local processes look the same), `undetermined` (direction unknown), `third-party` (an outgoing socket of a program sandy starts but does not control, such as a provider or agent CLI, git or the browser-automation Chromium, that would otherwise be yellow or red; shown, never counted as red).

An empty red list proves nothing on its own. Check that the measurement is alive first: start a short fetch to an unlisted host from a sandy child process, see it red with `sandy connections list --red --since <control start>`, then evaluate a later window that starts after the control ended with `sandy connections status --since <evaluation start>`, and confirm at least one provider row in it.

The same data is on the **Connections** page in the navigation (outgoing and incoming tables, a banner for what is not measured, both freshness clocks per host). The server sends one push notification the first time a destination turns red; it names no host, and editing `extraAllowedHosts` never sends it again. See the plugin README for the live verification steps.

Allowed hosts beyond the built-in list go into the plugin setting `extraAllowedHosts` (one exact host per line).
