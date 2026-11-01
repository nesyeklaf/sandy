---
name: field-latency
description: Read how long menus, popovers, dialogs, thread switches and scrolling take in the owner's own browser, from the Field Latency plugin's samples, per sandy release. Use for "how fast does it feel", field or RUM numbers, scroll smoothness, the device benchmark, or to compare a perf fix or a release before and after in real use.
---

# Field latency

The Field Latency plugin measures in every open sandy browser tab and stores the samples on the server.

- `sandy field-latency report [--since 24h] [--kind open|switch|slow|scroll] [--by-release] [--json]` gives percentiles per interaction, slowest p75 first, a scroll table and a device line (benchmark, cores, memory).
- `sandy field-latency report --by-release [--since 30d]` groups by sandy release: first seen, release key, n, p75 of switch first, switch revisit and open, and p25 of scroll smoothness, then compares the two most recently first-seen releases with deltas. Releases without a version or script hash (samples from before 0.3.0) show as `unknown` and are left out of the comparison. Use a long `--since` (30d), a release only shows up when it has samples in the window.
- `sandy field-latency recent [--limit 20] [--json]` lists the latest samples.
- `sandy field-latency clear --yes` deletes every sample, for example before measuring a new deployment.

## Lab browsers

- Headless or webdriver-driven browsers (the sandy lab under `scripts/perf`) are not field data: the collector runs there, but sends nothing and skips the device benchmark, the server drops records whose user agent contains `HeadlessChrome`, and the report leaves out such rows stored before 0.3.1.

## What a sample means

- open: from pointerdown on a button to the first painted frame that shows a new menu, listbox, dialog or popover (readyMs). mountMs is when its DOM appeared, settledMs when its opening animation finished.
- switch: from pointerdown on a thread link to the painted frame in which the URL, at least one timeline row of that thread and the composer are present (the same ready condition as scripts/perf in sandy). visit is first or revisit within this page load. A switch that is not ready after 15 s counts as a timeout.
- slow: any other interaction whose Event Timing duration reached 100 ms, labeled with the event name and its target.
- eventMs, inputDelayMs, processingMs, presentationMs come from the Event Timing API (Chromium; Firefox gives event durations only). frameMs, blockingMs, styleLayoutMs and scripts come from Long Animation Frames (Chromium only) during the interaction.

- tracedMs and phases come from sandy's own trace spans (`performance.measure` entries named `sandy:switch`, `sandy:open` and `sandy:<kind>:<phase>`), on hosts that ship them. A switch splits into input (click until the route changed), render (until the thread screen committed), timeline (until its rows were there) and paint; an open into render and paint. phases in the report are medians per phase, so they need not add up to traced p50. Keyboard and link switches and keyboard-opened overlays, which have no pointerdown, appear only through these spans, labeled "keyboard or link switch" and "keyboard <overlay>".
- The client record carries deviceMemoryGb and effectiveType next to cores and viewport, to tell an old laptop from a fast desktop.

Clicks while the tab is hidden, clicks on the thread that is already open and clicks that open nothing produce no sample.

## Scroll smoothness (kind scroll)

- A scroll session is a user-initiated scroll: a `scroll` event (any container, captured on the document) that follows a wheel, touch, pointer-down or scroll-key event within 500 ms. Scrolling nobody asked for, such as a timeline following streamed output, starts no session. A session ends 300 ms after its last scroll event, when the tab is hidden (discarded), after 20 s or 4096 frames (truncated), and sessions under 12 frames are dropped.
- Only while a session runs, a requestAnimationFrame loop writes frame timestamps into one preallocated buffer. Outside sessions nothing runs, apart from one 60-frame calibration about 3 s after load (retried while the tab is hidden).
- refreshMs is the display refresh interval: the lower quartile of the rAF intervals in that idle calibration, lowered to the session's own lower quartile (which includes its idle tail) when that is more than 10 % smaller. 6.9 ms means 144 Hz.
- Per session: durationMs, frames (intervals), dropped (intervals longer than 1.5 x refreshMs), p95FrameMs, maxFrameMs, smoothnessPct = presented / expected frames = frames x refreshMs / duration, capped at 100. A 60 fps scroll on a 144 Hz display therefore scores about 41 %. The label is the scroll container: the name of its first `data-*` attribute that contains scroll, viewport or timeline (without `data-`), else its id, aria-label or role, else the tag name; `page` for the document.
- Long animation frames that overlap the session fill frameMs, blockingMs, styleLayoutMs and scripts, as for other samples.
- In the scroll table smooth% p25 is the level that 75 % of sessions reach or beat, so higher is better; the frame columns are ms, lower is better.

## Releases

- Every client record carries sandyVersion (the content of `<meta name="sandy-version">`, if sandy sets it) and appScript (the hash in the main module script `index-<hash>.js`). The release key is `<sandyVersion>+<appScript>`, or whichever exists, else `unknown`. The server stores it per sample, so first-seen dates cover all stored data, not only the report window.

## Server and network phases

- For sandy:switch and sandy:open traces, fetch and XHR requests to the same origin that started inside the span and finished by its end are matched with Resource Timing. Overlapping requests form one step; the request that finishes last gates it, and steps that follow each other add up (a waterfall).
- On the gating requests: server is the Server-Timing `total` duration (else the largest metric), never more than the wait; network is the wait (responseStart - requestStart) minus server. Without a Server-Timing header only network appears. Both go into phases next to input, render, timeline and paint, so they show in "phases p50".

## Device benchmark

- Once a day per browser (localStorage key `sandy-field-latency:benchmark`), about 5 s after load, when the tab is visible and idle, a dedicated worker from a Blob URL runs `sandyBenchmarkIndex` three times (about 300 ms each) and the client record stores the median as benchmarkIndex (iterations per second, higher is faster), next to cores (navigator.hardwareConcurrency). It is the same function that the lab's calibrate script runs.
- The report shows it in its header. `sandy field-latency report --json` returns an object: `{ since, device, devices, groups }` (with `--by-release`: `{ since, device, devices, releases, compare }`). Read the index at `.device.benchmarkIndex`; `.device` is the most recently seen device that has one, `.devices[]` has one entry per user agent and core count, with cores, deviceMemoryGb, devicePixelRatio, userAgent and lastSeen. Before 0.3.0 the JSON was the bare `groups` array.
