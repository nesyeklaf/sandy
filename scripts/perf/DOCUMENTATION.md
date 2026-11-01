# Performance Measurement Tooling

Scripted, repeatable captures of sandy's web app against a seeded production build. Each scenario drives a real Chromium over CDP, records a trace and a page-side probe, and reports numbers against one contract. A capture that is throttled, empty or idle where it should be busy is reported `INVALID` and fails the run; it never produces a number.

## Contract

- Frame budget 6.94 ms (144 Hz): frame interval p50, p95 and max, the share of frames over budget, and main-thread time split into script, style, layout, paint and composite.
- No main-thread task over 50 ms during an interaction; the long-task distribution is reported.
- Input to next paint p95 <= 16 ms for typing, scrolling, hover and clicks.
- Perceived wait: user action until the requested content is usable (rows rendered and the composer present, the panel visible, the token on screen).

Scenario results are measurements, not pass/fail against the contract. `PASS` means the capture was valid; the contract numbers are in the headline and in `contract` inside the run JSON.

## Setup

1. Seed an isolated data dir. Never point the tooling at a real data dir.

   ```sh
   pnpm seed:perf -- --reset --events 400000 --data-dir ~/sandy-perf/data
   ```

2. Start a production build on it (or let `--data-dir` do it, see below).

   ```sh
   SANDY_SKIP_ONBOARDING=1 NODE_ENV=production node --conditions=source --import tsx scripts/start-sandy.mjs \
     --data-dir ~/sandy-perf/data --server-port 39886 --host-daemon-port 39887
   ```

3. Streaming only: install the paced provider into that instance and spawn one thread on it. Keep `SANDY_SERVER_URL` pointed at the perf instance, because the `sandy` CLI otherwise talks to whatever sandy the shell environment names.

   ```sh
   export SANDY_SERVER_URL=http://127.0.0.1:39886
   sandy plugin install ./scripts/perf/fixtures/paced-stream-provider --yes
   sandy thread spawn --provider paced-stream-agent --project <project id> --environment <environment id> --prompt "warm up the stream"
   ```

   The fixture is a copy of `examples/plugins/echo-provider` whose answer streams as `PACED_STREAM_CHUNKS` (default 240) markdown chunks every `PACED_STREAM_INTERVAL_MS` (default 25). Its `node_modules` link points at the echo provider's installed dependencies. Reseeding wipes the plugin and thread; repeat step 3.

## Running

```sh
node scripts/perf/run.mjs list
node scripts/perf/run.mjs all --url http://127.0.0.1:39886 --server-match sandy-perf/data --out ~/sandy-perf/results/dev
node scripts/perf/run.mjs composer thread-switch --data-dir ~/sandy-perf/data --runs 3
```

- `--url` attaches to a running instance; `--data-dir` starts a production server on a seeded dir and stops it afterwards.
- `--server-match` is a substring of the server's command line (its data dir). It enables server and daemon CPU sampling in `idle` and `server-latency`.
- `--runs n` repeats each scenario with a fresh browser and profile; the headline reports mean, min and max.
- `--viewport w,h`, `--headed`, `--chrome <path>` (or `SANDY_PERF_CHROME`) adjust the browser.
- `--attribute` adds the JS CPU profile to every capture and stores the top functions and modules as `capture.attribution` (see JS attribution).
- `--thread <id>` picks the thread `scroll-smoothness` scrolls; the default is the heaviest idle sidebar thread.
- The exit code is non-zero if any scenario was invalid or threw.

Artifacts land in `<out>/<scenario>/run-<n>.json` (headline, ledger of checks, capture data).

## Scenarios

| Scenario            | What it does                                                        | Headline                                                            |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `cold-start`        | Fresh profile, navigate to a heavy thread                           | time to sidebar and to usable thread, load-time main-thread budget  |
| `idle`              | 15 s with no input on a heavy thread                                | wakeups, main busy share, frames per second, server CPU             |
| `thread-switch`     | Click heavy and light sidebar threads, first visit and revisit      | perceived wait p50/p95, long tasks, click input latency             |
| `sidebar-scroll`    | Wheel flings and touch drags in the thread list, hover rows         | frame budget, scroll and hover input latency                        |
| `timeline-scroll`   | Scroll the heaviest timeline end to start and back, mouse and touch | frame budget, long tasks, scroll input latency                      |
| `scroll-smoothness` | Wheel scroll up for 5 s, then a touch fling up, on a heavy thread   | frame interval p95/p99, longest frame, dropped share, LoAF blocking |
| `streaming`         | Send a prompt to the paced provider and type while it streams       | first token wait, completion time, frame budget, typing latency     |
| `composer`          | Type, paste 400 lines, open the @ popup on a heavy thread           | paste wait, long tasks, typing latency                              |
| `drawers-panels`    | Right panel and tabs, sidebar collapse, phone-width sidebar drawer  | perceived wait per control, frame budget at both sizes              |
| `server-latency`    | HTTP latency of the app's endpoints, cold, warm and in a burst      | first, p50, p95 per endpoint, burst wall time                       |

## App measures

The app records thread switches and overlay opens as `performance.measure` entries, so DevTools, Perfetto and the field-latency plugin read the same spans:

- `sandy:switch` from the input that started the switch until the frame after the timeline is ready, with phases `input`, `render`, `timeline` and `paint` (`sandy:switch:<phase>`). A switch superseded by another one is dropped.
- `sandy:open` from the input that opened a dropdown, popover, select, dialog, alert dialog, sheet, drawer or context menu until the frame after it rendered, with phases `render` and `paint`. The label is the overlay kind (`menu`, `popover`, `select`, `dialog`, `alert-dialog`, `sheet`, `drawer`, `context-menu`).

The spans appear on the "Interactions" and "Thread switch" or "Overlay open" custom tracks in the DevTools Performance panel. Each entry carries `detail.sandy` with the kind, label and phase.

## Server-Timing

Every `/api/v1/*` and `/internal/*` response carries `Server-Timing: total;dur=<ms>, db;dur=<ms>, app;desc="<route pattern>"`. `total` is the server's handling time (time to headers for streaming responses), `db` the time spent in SQLite calls for that request (absent without queries), `app` the matched route pattern. The overhead measured on a local production server (1000 sequential requests, with and without the middleware) is below the noise of the run, about 0.01 to 0.05 ms per request.

Read it in DevTools under Network > Timing > Server Timing, or in the page:

```js
performance
  .getEntriesByType("resource")
  .filter((entry) => entry.serverTiming.length > 0)
  .map((entry) => [
    entry.name,
    entry.serverTiming.map((t) => `${t.name}=${t.duration}`),
  ]);
```

Subtract `total` from the request's `responseEnd - requestStart` to see network and queueing time; compare `db` with `total` to see whether a slow endpoint waits on SQLite or on its own code. Same-origin pages read it directly. A page on another origin (the dev app on its own port) needs `Timing-Allow-Origin`, which the server sets to the allowed CORS origin. Through sandy connect the header is forwarded unchanged.

## Profiling build

A profiling build keeps names readable and adds React's performance tracks (Scheduler and Components) to the Performance panel:

```sh
pnpm exec turbo run build --filter=@sandy/app^...
pnpm --filter @sandy/app run build:profiling
node scripts/perf/profiling-proxy.mjs --upstream http://127.0.0.1:38886 --port 38887
```

`SANDY_APP_PROFILING=1` turns off JS minification, writes source maps and aliases `react-dom/client` to `react-dom/profiling`; the output goes to `apps/app/dist-profiling`. The proxy serves that build and forwards everything else, including WebSockets, to a running server, so the profiling app runs against the same data as the normal one on its own port. Plugins keep their own bundles.

## A/B runs

`ab.mjs` compares two running servers on the same data, for example the live app and a candidate build behind `profiling-proxy.mjs` or a second server:

```sh
node scripts/perf/ab.mjs --a http://127.0.0.1:38886 --b http://127.0.0.1:38887 --start <thread id> --rounds 8 --cpu-throttle 4 --trace
```

- Each round runs both variants in a fresh browser, in the order AB BA BA AB, so warm caches and background load hit both alike.
- It opens `--start` and records its first load until the thread is painted as `load first`, then switches through `--threads` visible sidebar threads twice (first visit, revisit) and opens the thread actions menu `--menus` times. The wait runs from the input event until the frame after the content is usable, measured by the page probe, so it works on builds without the app measures.
- The report gives the median wait per variant and a bootstrap 95% interval of the difference. The waits of one round share a browser, so the bootstrap resamples whole rounds (paired, the same rounds for a and b) instead of single waits, and needs at least 5 rounds with valid waits per variant: with 3 or 4, all draws of an identical build can land on one side of zero. "b faster" or "b slower" only when the whole interval is on one side of zero; otherwise "no difference".
- `--cpu-throttle 4` slows the page like an old laptop. `run.mjs` takes the same flag.
- `--trace` records a Chrome trace per run, marks each wait as a `lab:switch` or `lab:open` measure and splits the main thread inside it into script, style, layout, paint, GC, other and idle time with `sql/interaction-breakdown.sql`. Traces are about 100 MB each and are deleted after the query unless `--keep-traces`.

`trace-sql.mjs <trace.json>` runs the same breakdown, or another file in `sql/` (`--sql`), on any trace, for example one saved from the DevTools Performance panel. `--windows` picks the slices to split: `sandy:*` (default) for the app's spans and their phases, `sandy:switch` for switches only.

`--scenario scroll` replaces the switches and menu opens with the gestures of `scroll-smoothness` on `--start` (default: the heaviest idle thread) and compares the per-run frame pacing numbers with the same bootstrap interval. Lower is better, so the verdict reads "b smoother" or "b rougher". It always records a trace, because presented frames come from it.

Both need the Perfetto trace processor: `curl -LO https://get.perfetto.dev/trace_processor && chmod +x trace_processor`, then set `SANDY_PERF_TRACE_PROCESSOR` to its path, or put `trace_processor_shell` on the PATH.

## JS attribution

`--attribute` (`ab.mjs`, `run.mjs`) adds `disabled-by-default-v8.cpu_profiler` and `v8.execute` to the trace and attributes the sampled JS self time of the renderer main thread (`CrRendererMain`; workers such as the field benchmark do not block a wait) inside each `lab:*` window: top functions with their source location, and top modules. Each sample covers the gap to the next sample, capped at 10 ms, and a window is charged only the part of that interval inside it, so a sample that starts just before a window counts and one that runs past its end is cut. `(program)` is time V8 spent outside JS (often style, layout and paint); native calls such as `getBoundingClientRect` show up by name.

- Locations go through the chunk's source map: `--sourcemaps <dir>` first, then `<chunk url>.map` from the server. A build without maps (the live app), and code a map leaves unmapped or that sits before the first mapped column of a line, reports `chunk:line:col` and minified names; the profiling build reports `src/...:line` and `node_modules/<package>`.
- `ab.mjs --react-components` also injects a disabled React DevTools hook stub, which makes React's profiling build emit its Components track as `console.timeStamp` events. The report lists components by self render time (children subtracted). Only the profiling build emits them, and React's own `logComponentRender` then costs a large share of the wait (about 190 ms of an 800 ms switch), so compare component times with each other, not wall times with a normal build.
- `ab.mjs` prints the mean per kind and stores each wait's attribution in `ab.json`; `run.mjs` stores it per capture.
- `trace-sql.mjs <trace> --sql js-attribution.sql --windows 'sandy:switch'` ranks functions per window in Perfetto, for traces recorded elsewhere. Perfetto keeps no source location for Chrome JSON profiles, so it ranks by function name only.

## Firefox lab

`firefox-lab.mjs` measures thread switches in headless Firefox, where field switches are slow and revisits are no faster than first visits:

```sh
node scripts/perf/firefox-lab.mjs --url http://127.0.0.1:38886 --compare-chrome --profile --sourcemaps <dir>
```

- It drives Firefox over WebDriver BiDi (`lib/firefox.mjs`), started with `--headless --remote-debugging-port` on a throwaway profile. `--firefox`, `SANDY_PERF_FIREFOX` or `~/sandy-perf/firefox/firefox/firefox` picks the binary; Firefox 159 and later also need `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, which the driver sets. Content runs in a tab the driver opens, because BiDi refuses viewports and preload scripts on the privileged first tab.
- Each round opens `--start` in a fresh browser at the field viewport (2396x1318), then switches through `--threads` visible sidebar threads twice, first visit then revisit. A click is a real pointer: it rests `--hover-ms` on the link, which starts the sidebar's hover prefetch as a mouse does, then presses for `--press-ms`. `--revisit-gap-ms` idles between the two passes, because field revisits come minutes after the first visit, not seconds.
- Per switch it reports the wait (pointerdown until the frame after the thread is usable, as in `ab.mjs`), the app's `sandy:switch` total and its input, render, timeline and paint phases, and the slowest request for the thread's data as `network` with its `Server-Timing` total as `server`. These are the field-latency plugin's phases, so lab and field compare directly. The report gives n, p50 and p75 per browser and visit.
- `--compare-chrome` runs every round in headless Chrome as well, with the same input and viewport, alternating which browser goes first.
- `--profile` adds `--profile-rounds` Firefox rounds under the Gecko profiler (features `js`, `cpu`, `nomarkerstacks`; threads GeckoMain, Renderer, Compositor, StyleThread). Their timings are reported apart, because the profiler slows the page. `lib/gecko-profile.mjs` finds the content process main thread that recorded the `sandy:switch` spans and attributes every `lab:switch` window and its render and paint phases: time per Gecko category and subcategory, self time per innermost JS function (time in native code below it counts for the function; `jsMs` is the part in the JavaScript category), and the CPU time of the same process's Stylo threads. Samples weigh up to 10 ms, as in Chrome attribution. The profiles are kept as `.json.gz` and open in profiler.firefox.com.
- Function locations go through source maps like the Chrome attribution. The live app ships without maps, but a build of the same commit maps it: `cd apps/app && npx vite build --outDir <dir> --emptyOutDir --sourcemap hidden`, then `--sourcemaps <dir>/assets`. Check that the chunk names match the served ones. Plugin bundles stay unmapped.
- The validity checks are the ones below that apply without a trace: the page is visible, rAF produces frames, timers do not drift and the host CPU is quiet before each round. An invalid round is listed and left out of the summary.
- Everything goes to `--out` as `firefox-lab.json`.

Headless Firefox renders offscreen, without a window, the desktop compositor or the GPU path a user's browser takes. Main-thread work (input, render, JS, style, layout) compares with the field; paint and composite time does not.

## Scroll smoothness

`scroll-smoothness` (and `ab.mjs --scenario scroll`) opens a thread at the bottom, scrolls the timeline up with a 6000 px wheel gesture at 1200 px/s, then flings it up with a 400 px touch drag in 80 ms. CDP's synthesized touch scroll gesture does not move the timeline in headless Chrome, so the fling is dispatched as raw touch events and the compositor's fling animation carries it on.

For each gesture the page records scroll events and rAF timestamps. The window runs from the first to the last scroll event and is marked as a `lab:scroll:<gesture>` measure, which the trace analysis, the Perfetto breakdown and `--attribute` reuse. Per window it reports:

- `presented`: frames presented in the window (`PipelineReporter` from the trace) and `raf`, the same numbers from the page's rAF timestamps as a main-thread cross-check.
- Frame interval p50, p95, p99 and longest. Lab Chrome runs with an uncapped frame rate, so the p50 is the refresh interval it reached (about 7 to 8 ms on this machine), not a display's vsync.
- `missedFrames` and `droppedPct`: the window split into 144 Hz slots (6.94 ms), and the slots without a presented frame. `chromeDroppedFrames` is Chrome's own count of frames in a dropped state.
- `loaf`: long animation frames overlapping the window, their blocking time and the scripts inside them by function and source position.

Headless Chrome on this machine missed about 20% of 144 Hz slots during the wheel scroll with both the live and the profiling build, so read these numbers as an A/B, not against the target.

## Throttle calibration

`calibrate.mjs` turns a device's benchmark score into a `--cpu-throttle` factor:

```sh
node scripts/perf/calibrate.mjs --device-score 30
node scripts/perf/calibrate.mjs --field --since 14d
```

- It runs `sandyBenchmarkIndex` (`lib/calibration.mjs`), the exact function the field-latency plugin runs in the user's browser, 5 times (`--runs`) in a dedicated worker in headless Chrome and takes the median as the lab score. The factor is lab score / device score.
- CDP CPU throttling does not slow dedicated workers (a worker scores the same at 4x), so the check runs the benchmark on the throttled main thread. It passes when the median lands within 10% of the device score, and corrects the rate up to `--refine` times (default 2) when it misses.
- `--field` reads the median `benchmarkIndex` over the `devices` rows of `sandy field-latency report --json` (field-latency 0.3.0 or later; `device` is only an alias of the newest row and is read only when `devices` is missing). When no device in the window has a benchmark, the command says so and exits 2.
- A device faster than the lab machine needs no throttle; the command says so and exits 0.

## Regression check

`regression.mjs` answers "did this change make sandy slower than its base?" without a running server:

```sh
node scripts/perf/regression.mjs --base origin/main --head HEAD
```

- It checks out `--base` (default: the merge-base of `origin/main` and the head) and `--head` (default `HEAD`) as detached worktrees under `--out`, installs with pnpm, builds the app, server, host daemon and bundled plugins with Turbo (`TURBO_CACHE_DIR` is honoured), seeds one fixture with the base's `seed-perf-db.ts` (1200 threads, 400000 events, seed 1) and starts each ref on its own copy of it.
- It then runs the A/B above with `--rounds 8 --cpu-throttle 4`, base as a and head as b, opening the heaviest idle thread first. Each browser's first load of that thread adds a `load first` metric next to the switches and menu opens.
- `budgets.json` sets, per metric, `budgetMs` and `budgetPct` (the slowdown the head may add) and `ceilingMs` (the head median it should stay under at `cpuThrottle`). A metric fails when the whole 95% interval of head - base is above zero and the median slowdown exceeds both `budgetMs` and `budgetPct`, or when the head completed more than 20% fewer of its actions than the base. The check fails closed: it is INCONCLUSIVE when no round ran, when a metric with a budget was not measured, or when it has fewer than 5 rounds with valid samples on either side (a probe that broke both variants alike). Too few samples on a metric without a budget, a missing budget and a broken ceiling only warn.
- It prints and writes `summary.md` (a Markdown table starting with `<!-- sandy-perf-regression -->`, also appended to `GITHUB_STEP_SUMMARY`), `regression.json` with the verdict and every row, `ab.json` with the raw samples, and the install, build, seed and server logs under `logs/`. Exit code 0 is PASS, 1 FAIL, 2 INCONCLUSIVE or a broken run; a FAIL wins over INCONCLUSIVE.
- The worktrees and data are removed afterwards unless `--keep-worktrees`. A run takes about 10 minutes, mostly the browser rounds; `--rounds` trades time for a narrower interval.
- `.github/workflows/perf-regression.yml` runs it on pull requests that touch the app, server, packages, plugins or this tooling, comparing the PR merge commit with its first parent, and on manual dispatch with any base and head. The report is the job summary and the `perf-regression` artifact.

Budgets are deliberately wider than the A/A noise: an A/A run of the same commit on both sides must pass, and a head that blocks the main thread for 250 ms when a thread's timeline becomes ready must fail. Work off the critical path, such as 60 ms in the first render of a switch while the timeline still loads, does not lengthen the wait and does not fail. Raise a budget only with an A/A run that shows the noise is wider; lower it with an A/A run that shows it is narrower.

## Validity checks

Every capture records a ledger of checks before it reports numbers, so a broken capture cannot read as a fast one:

- Before each capture: the page is visible, requestAnimationFrame produces frames (page not throttled), timers do not drift (not throttled), and the host CPU is quiet.
- The trace has window markers and a renderer main thread, covers the action, recorded tasks, presented frames and measurable renderer work (idle captures invert the last two).
- After the capture the page is still visible and focused, and the traced renderer is the one that loaded the app URL.
- The interaction landed: scrollers moved, content became usable, the popup appeared. A ready expression that was already true when armed (`staleAtArm`) or that timed out invalidates the wait.

## Layout

- `run.mjs`: CLI, scenario selection, ledger, exit code.
- `lib/cdp.mjs`, `lib/browser.mjs`: CDP client and `PerfBrowser` (navigation, input, viewport, capture).
- `lib/page-probe.js`: page-side recorder (long tasks, LoAF, event timing, armed ready expressions, scroll and rAF recording).
- `lib/trace.mjs`, `lib/metrics.mjs`: trace parsing into the script/style/layout/paint/composite split, percentiles.
- `lib/contract.mjs`: the contract applied to a capture; `lib/ui.mjs`, `lib/scroll.mjs`, `lib/api.mjs`: selectors, gestures and the thread ranking by event count.
- `lib/app-server.mjs`, `lib/proc.mjs`: starting a server on a seeded dir, process CPU sampling.
- `profiling-proxy.mjs`: serves the profiling build in front of a running server.
- `ab.mjs`, `lib/ab-run.mjs`, `lib/ab-stats.mjs`: interleaved A/B runs and their statistics. `ab.mjs` is the CLI; `runAb` and `printAbReport` in `lib/ab-run.mjs` run and print them for `ab.mjs` and `regression.mjs`.
- `lib/attribution.mjs`, `lib/sourcemap.mjs`: CPU profile and React component attribution per window, source map decoding.
- `firefox-lab.mjs`, `lib/firefox-run.mjs`: Firefox switch rounds, optionally against Chrome; `lib/firefox.mjs` is the WebDriver BiDi driver and Gecko profiler control, `lib/gecko-profile.mjs` the Gecko profile attribution.
- `lib/smoothness.mjs`: scroll gestures and frame pacing, shared by `scroll-smoothness` and `ab.mjs --scenario scroll`.
- `calibrate.mjs`, `lib/calibration.mjs`: throttle calibration.
- `regression.mjs`, `lib/regression-verdict.mjs`, `budgets.json`: base against head with budgets.
- `trace-sql.mjs`, `lib/perfetto.mjs`, `sql/`: Perfetto SQL on saved traces.
- Tests for the pure helpers: `node --test scripts/perf/lib/*.test.mjs`.
- `scenarios/`: one file per scenario, registered in `scenarios/index.mjs`. A scenario exports `{ name, description, run(context) }` and returns `{ headline, data }`.
- `fixtures/paced-stream-provider/`: the streaming provider plugin.

## Adding a scenario

Rank threads with `context.api.rankSidebarThreads`, open them with `openThread`, wrap the interaction in `browser.capture({ action })`, arm a ready expression with `window.__sandyperf.arm` before each action that should produce content, and record a ledger check for every precondition. Do not add a wait that a missing element could satisfy silently.
