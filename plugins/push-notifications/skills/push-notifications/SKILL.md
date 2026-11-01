---
name: push-notifications
description: "Toggle web and desktop notification channels, set per-thread notification levels, send a notification from the CLI or another plugin, or test delivery for SANDY push notifications."
---

# Push notifications

The plugin notifies when a thread asks a question, finishes a turn, or stops on
an error, and anyone can send their own through the same channels. Web and desktop clients receive system notifications only while a sandy
tab or app window stays open, and each browser grants permission separately in
the plugin settings.

```sh
sandy push-notifications status [--json]
sandy push-notifications test <web|desktop> [--json]
sandy push-notifications send --title <text> [--body <text>] [--thread <thread>] [--json]
sandy push-notifications thread <thread> [--level inherit|all|input-only|muted]
sandy plugin config push-notifications set <webEnabled|desktopEnabled> <true|false>
sandy plugin config push-notifications set defaultLevel <all|input-only|muted>
sandy plugin config push-notifications set childLevel <inherit|all|input-only|muted>
```

- The two channel switches default to `true` and apply immediately to this
  server. `sandy plugin disable push-notifications` stops all delivery.
- `test` broadcasts to every connected, permitted client of that type and
  fails when the channel is disabled. Success confirms the broadcast, not that
  the OS showed a banner; system notification settings can still suppress it.
- `send` delivers to every enabled channel, like a thread notification, and
  prints the channels it reached: `web` and `desktop` when they are on. The title is cut to 80
  characters and the body to 180. With `--thread`, a click opens that thread;
  without it, a click opens sandy. It fails with `not_delivered` when no channel
  received it and `thread_not_found` for an unknown or deleted thread. Thread
  notification levels don't apply.
- `thread` prints a thread's resolved notification level and its source;
  `--level` sets the thread's own level. A thread uses its own level, else
  `childLevel` if it has a parent (default `input-only`; `inherit` follows
  `defaultLevel`), else `defaultLevel` (default `all`). Every ancestor's own
  level also caps its child threads. `all` notifies on finished turns too,
  `input-only` keeps questions, approvals, and errors only, and `muted` sends
  nothing.

A plugin sends the same notification from its server code with:

```ts
const { channels } = await sandy.sdk.plugins.callRpc({
  pluginId: "push-notifications",
  method: "notifications.send",
  input: { title: "Deploy failed", body: "api-prod rolled back", threadId },
  outputSchema: z.object({
    ok: z.literal(true),
    channels: z.array(z.enum(["web", "desktop"])),
  }),
});
```

`body` and `threadId` are optional. An empty `channels` means nothing was
delivered. `sandy plugin rpc inspect push-notifications notifications.send`
prints the published input and output schemas.

Every command takes `--help`. A failure with `--json` prints
`{ "ok": false, "error": { "code", "message" } }` on stdout and the readable
text on stderr.

The SDK's plugin settings API changes the same settings. `sdk.plugins.callRpc`
also takes `notifications.test` (`{ channel }`), `threadNotifications.list`
(`{ threadIds }`, up to 200), and `threadNotifications.set`
(`{ threadId, level }`). Permission requests still require a click in the
target client.

Inspect `status` before changing a channel, and change only the requested
channel.
