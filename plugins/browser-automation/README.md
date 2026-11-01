# Browser Automation for SANDY

Thread-owned browser scripts, desktop attachment, and local headless Chrome
on enrolled hosts. Requires the public
`sandy.sdk.experimental_desktopBrowsers` API (SDK 0.4.48 or newer).

Browser Automation is optional and disabled by default. Enable it in plugin
settings when you want to use it.

The plugin was scaffolded with `sandy plugin new browser-automation`. It has server, host,
app, CLI, RPC, and a bundled skill. Agents use the CLI through the skill. Screenshot
commands return temporary JPEG file paths and the browser host ID. Local headless
sessions show a live preview inline in the chat that expands into a lightbox; see
[Live preview](#live-preview). Screenshot cards and a screenshot sidebar viewer are not included. Cloud provisioning and arbitrary CDP endpoints are excluded.

## Runtime installation and provenance

sandy never downloads the DevBrowser runtime. You install it on the **selected
browser host** yourself, outside sandy; the plugin only looks for it and verifies
it. `runtime-pin.ts` pins one exact release:

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| package      | `dev-browser@1.0.0-rc.4`                                            |
| repository   | [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) |
| tag / commit | `v1.0.0-rc.4` at `e5d746f1fc17a3301d6e7f865f89c034f15f69fb`         |
| linux-x64    | `fa6cec3f84463e171bd7b307e2e1f0243df59c70c38f96d790dc41b160db921a`  |
| linux-arm64  | `578db7f1e502cf6b9e43ac09e6adc5720f5397fa3e6d6b7b9ba8377708fe040e`  |
| darwin-x64   | `7cfad83f7f9e16dc5acbc94553430bcd1be24adc4304c0f534805969bfa6d2ba`  |
| darwin-arm64 | `f0a7e7d10ab8be0fee1ee8ac2ca33d3efc46b493e5e998b29ea75c79479a2e8d`  |

The digests are the SHA-256 values published in that release's `SHA256SUMS`.
Windows has no upstream artifact and is refused.

The plugin expects this layout under `<plugin host dataDir>/runtime/npm/`:

```
dev-browser@1.0.0-rc.4/
  verified.json
  node_modules/dev-browser/bin/dev-browser-bin
```

`verified.json` records `package`, `version`, `platform`, `sha256`, `binary`
(the relative path above) and `installedAt`. On every start the plugin checks
that the record matches the pin, that the binary is executable, and that its
SHA-256 equals the pinned digest for the host platform. Nothing runs npm or
touches the network. A missing, tampered or mismatched runtime fails the open
with a message that names the expected directory, the version and the digest.

To install it, fetch `dev-browser-<platform>` from the GitHub release for the
tag, confirm its SHA-256 against `SHA256SUMS` and the digest above, place it
at the binary path, make it executable, and write `verified.json`. A runtime
installed by an earlier sandy release in the same layout keeps working.

### No fallback

A platform without a recorded digest fails with an explicit error; the plugin
never falls back to another version, a `PATH` binary, or the older pre-release
integration build. The `smoke` task takes an explicitly provided binary and
labels it `developer-artifact`; that source exists only for fixtures and is
never chosen automatically. The upstream MIT license is preserved in
`DEVBROWSER-LICENSE`.

### Bumping the pin

1. Fetch `https://github.com/SawyerHood/dev-browser/releases/download/v<version>/SHA256SUMS`
   and copy the four digests into `runtimeRelease.artifacts`.
2. Install the new version by hand on a Linux and a macOS host and run the
   `smoke` task against it.

Headless sessions need Chrome/Chromium on that host. The plugin checks
`<plugin host dataDir>/runtime/chrome`, the standard macOS Chrome path, then
`google-chrome`, `google-chrome-stable`, `chromium`, and `chromium-browser` on
PATH. The `runtime/chrome` entry can be a symlink to an installed executable.
Plugin-owned local/headless Chrome always launches with `--no-sandbox`, disabling
Chrome's sandbox so it can run on hosts that restrict unprivileged user namespaces.
Desktop sessions attach to an existing browser and do not change its launch flags.

## CLI and agent workflow

Choose both the backend and its host explicitly. There is no silent fallback or
profile migration. Find desktop instances through SANDY's core desktop-browser
CLI/SDK discovery. The selected instance's generation is resolved on opening.

```sh
sandy browser-automation open --backend local --headless --machine <host-id> --json
sandy browser-automation open --backend desktop --machine <desktop-host-id> --desktop <instance-id> --json
sandy browser-automation list --json
sandy browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.snapshot()' --json
sandy browser-automation run <session-id> --script-file ./check.js --script-host <invoking-host-id> --timeout-ms 30000 --json
sandy browser-automation pages <session-id> --json
sandy browser-automation screenshot <session-id> --page main --json
sandy browser-automation preview <session-id> [--after <sequence>] --json
sandy browser-automation stop <session-id> --json
sandy browser-automation close <session-id> --json
```

Outside a thread, supply `--thread <thread-id>`. Calls from an existing thread
cannot override its ownership. `--script-file` requires `--script-host <host-id>` naming the source host
explicitly and is read through `sandy.sdk.files`, then transferred as script text to the
browser host. Relative paths use the invoking CLI working directory. Browser
file reads/writes still occur on the browser's host; scripts are not run in the
workspace directory.

Desktop sessions create a tab in the SANDY browser's profile, so pages load with
the user's signed-in cookies, including cookies imported from another browser.
Acquiring control opens the side panel and selects its browser tab only when
the owning thread is already focused. New or activated controller pages follow
the same rule. Automation does not switch threads or bring the desktop window
forward. While controlled, a desktop tab never takes keyboard focus from the
composer or other apps; press Take over to type into it. Pass
`--tab <tab-id>` only to take over an existing tab; `close` preserves that tab.
The plugin records every tab opened under the session's control lease, and
`close` disposes the plugin-created tab and those pages. `stop` releases
control and preserves desktop tabs, including plugin-created ones, until close
or cleanup.

Local sessions own a Chrome process and a separate, empty profile. Each session owns a
fresh `DEV_BROWSER_HOME` and socket under the worker's temporary directory.
Pages and cookies persist between runs in that session. `stop`, timeout, or
cancellation terminates that local session; open another session to resume.
`close` disposes its processes and session directory. Tabs taken over with
`--tab` remain open. Sessions close after 30 minutes without `run`, `pages`, or `screenshot` activity.
Each operation renews expiry at its start and completion, up to eight hours from
creation; active scripts do not count as idle. The hard deadline also stops running
work. Desktop control leases and connections cannot be renewed through the current
API, so desktop sessions retain their earlier deadline (at most 30 minutes from
creation). `list` and live preview do not renew expiry. Archiving, deleting, or failing a thread
closes its sessions; normal idle turns preserve them. Externally invoked CLI
runs remain subject to the same per-run timeout and absolute session expiry. Run timeouts default to 30 seconds and are
bounded to 1–120 seconds. Runs are serialized per session.

DevBrowser scripts are trusted code, not a security sandbox. Script output is
bounded to 512 KB before parsing and 160,000 text characters after parsing.
Up to four JPEGs fit within a combined 500 KB budget. Image file paths
must resolve inside that session's capture directory; oversized files and
escaping symlinks fail. CLI `run` and `screenshot` JSON returns `hostId` plus
`images: [{path, mimeType, width, height}]`, without inline image bytes. Paths
are in the browser session's temporary directory on the selected host. Agents
read them directly on that machine, or use `sandy file read <path> --host <host-id>
--json` to fetch a remote image and decode its base64 content to a local temporary
JPEG. The bundled skill includes a copy-pasteable command. Read or copy captures
before closing the session; cleanup removes them. Endpoints and connection
credentials are removed from structured script text and never included in
session records or CLI session results.

The CLI uses the same validated operation handlers as RPC. The
RPC contract in `contracts.ts` exposes `open`, `list`, `run`, `pages`,
`screenshot`, `preview`, `stop`, and `close`.
RPC inputs include `threadId`; session operations also include `sessionId`.
`open.selection` is `{backend:"local",hostId}` or
`{backend:"desktop",hostId,instanceId,tabId?}`. A tab ID takes over that existing tab.
Agents discover the commands through the skill and CLI help.

The host supervises Chrome and the DevBrowser daemon as separate children. Each
child owns a process group. Closing the worker pipe also stops those groups, so
a worker crash does not leave browsers running. Stop sends TERM then KILL after
1.5 seconds. The plugin does not discover or kill processes from PID files.
`stop` and `close` retire the session before cleanup starts, so it accepts no
more commands and an `open` still starting is aborted. They succeed only once
the host has released the browser processes and session directory and the
desktop lease and tabs are released. Otherwise they fail with the reason,
including a host that does not answer within 10 seconds. Concurrent closes
share one outcome, and closing again retries cleanup. A host worker repeats a
session's close outcome until that worker exits, and refuses to reopen a
session it already closed.
Server metadata persists ownership and cleanup needs; restart reconciles active
sessions, retries unfinished cleanup, and revokes their desktop leases. Unreachable desktop cleanup remains
recorded for reconciliation on a later plugin load. Desktop lease loss is
observed using the public SDK subscription; core revokes the CDP endpoint
immediately, and the plugin stops its worker session when notified.

## Live preview

Opening a local headless session returns a `previewDirective` in the CLI
result, `::browser-preview{session="<session-id>"}`. The plugin's agent
instructions tell the agent to paste it once, as a standalone line, in its next
message. SANDY renders that line inline in the chat as a live thumbnail of the
browser with the page title, location, and a Live, Ended, or Unavailable state.
The card collapses, and its expand button opens the same live view in a
lightbox sized to the window; on compact screens the lightbox is the shared
responsive drawer. The lightbox is mounted once per window as an app overlay,
not inside the card, so it stays open and live when the timeline paginates the
card away. Desktop sessions return no directive and never preview: that
browser is already visible in the app's side panel, and its brokered connection
is not reused for previews.

Frames come from a second, read-only CDP connection that the host worker opens
to the session's own Chrome (`preview.ts`). It runs `Page.startScreencast` as
JPEG at about four frames per second, at most 800 pixels on the long edge for
thumbnails. While a lightbox requests `size: "full"` it recasts the same page at
up to 1280 pixels, the headless window's width, and returns to thumbnails ten
seconds after the last full-size request. It casts only while something is
watching: the connection closes after 15 seconds
without a request and reopens on demand. It previews the page that navigated
most recently, preferring any page over `about:blank`, so it follows the named
page a script is driving. Previews never enter the per-session run queue, so
they keep updating while a script runs and never delay one.

The app long-polls the `preview` RPC with the last sequence it rendered and the
`size` it needs, `thumbnail` by default; the
server forwards to the host's `preview` RPC, which answers as soon as a newer
frame exists or after five seconds with `frame: null`. An inline card polls
only while the window is visible and it is expanded and scrolled into view, so
cards left behind in the chat history cost nothing. The lightbox opens from the
card's current frame and then runs its own poller; the card pauses its poller
while its session's lightbox is open. Preview requests are not
session activity: watching a preview does not postpone the 30-minute idle
cleanup. When the session stops, closes, or expires, the card keeps its last
frame dimmed for as long as it stays mounted; a card first viewed after that
shows only its Ended header. A card whose session it can never read, such as a
directive copied into a forked thread, gives up after five failed requests.

`sandy browser-automation preview <session-id> --json` reports the same live frame
as `{session, frame}` where `frame` has `sequence`, `mimeType`, `width`,
`height`, `url`, `title`, and `bytes`, or is `null` when nothing newer than
`--after` arrived. It omits the image bytes; use `screenshot` for a file.

## Validation

From the SANDY checkout, use Turbo:

```sh
pnpm exec turbo run test typecheck build --filter=sandy-plugin-browser-automation
DEV_BROWSER_SMOKE_BINARY=/absolute/path/to/verified/dev-browser \
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke --filter=sandy-plugin-browser-automation
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke:install --filter=sandy-plugin-browser-automation
```

`installer.test.ts` drives the installer against a fake `npm` and a local
release server: exact-version install, provenance rejection, digest and
`SHA256SUMS` mismatches, warm reuse without npm or network, tampered-binary
reinstall, concurrent callers, stale locks, and cancellation cleanup.

`smoke:install` performs a real cold install of the pinned release from
npm and GitHub into a disposable data directory, then a warm resolve with no
npm on `PATH`, then drives real headless Chrome through the installed binary,
including a cross-origin iframe snapshot and a JPEG screenshot. It prints the
binary path, its SHA-256, and timings.

`smoke` takes an explicit binary and creates disposable directories and runs
real Chrome, without starting a SANDY core or using an existing browser profile.
It verifies named pages, navigation, clicking, JPEG bytes, a live preview that
follows a second named page while its script runs and switches to full-size
frames on request, serialization,
independent session cancellation, a synchronous infinite-loop timeout,
reopening, closing a runtime session (further runs are rejected), and
preservation of an attached browser and its page state after that session
closes.
Both smokes link directly to Chrome and exercise the production launch flags
without a wrapper. The attachment smoke also launches its separate browser
fixture with `--no-sandbox` so it works on hosts with restricted user namespaces.

Build with a current SANDY CLI: an older installed CLI can successfully bundle the
sources while stamping old SDK metadata. Inspect `dist/*.meta.json` before any
future installation or distribution. Generated bundles and declarations are
ignored. No plugin installation or live core is needed for these checks.
