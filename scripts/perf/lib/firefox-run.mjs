import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { median, quantile } from "./ab-stats.mjs";
import { threadInfo, timedAction, visibleSidebarThreads } from "./ab-run.mjs";
import { threadUrl } from "./api.mjs";
import { PerfBrowser, sampleHostBusyShare } from "./browser.mjs";
import { wait } from "./cdp.mjs";
import { FirefoxBrowser } from "./firefox.mjs";
import {
  analyzeSwitches,
  contentMainThread,
  jsFrameUrls,
  summarizeWindows,
} from "./gecko-profile.mjs";
import { ValidityLedger, summarize } from "./metrics.mjs";
import { loadSourceMaps, sourceResolver } from "./sourcemap.mjs";
import { SELECTORS, threadReadyExpression } from "./ui.mjs";

export const LAB_BROWSERS = ["firefox", "chrome"];
export const SWITCH_PHASES = ["input", "render", "timeline", "paint"];
export const SAMPLE_METRICS = [
  "waitMs",
  "appMs",
  ...SWITCH_PHASES,
  "network",
  "server",
];

const PAGE_PROBE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "page-probe.js"),
  "utf8",
);

const MEASURE_COLLECTOR =
  "window.__sandymeasures = []; new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.name.startsWith('sandy:')) window.__sandymeasures.push({ name: entry.name, start: entry.startTime, duration: entry.duration, label: entry.detail?.sandy?.label ?? null }) }).observe({ type: 'measure' });";

const RESET_ACTION =
  "(() => { window.__sandymeasures.length = 0; performance.clearResourceTimings(); return true })()";

export const settleExpression = (quietMs, timeoutMs) =>
  "new Promise((resolve) => { const started = performance.now(); let lastBusy = started; let last = started; const observer = new MutationObserver(() => { lastBusy = performance.now() }); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); const tick = (now) => { if (now - last > 50) lastBusy = now; last = now; if (now - lastBusy >= " +
  quietMs +
  ") { observer.disconnect(); resolve(true); return } if (now - started >= " +
  timeoutMs +
  ") { observer.disconnect(); resolve(false); return } requestAnimationFrame(tick) }; requestAnimationFrame(tick) })";

const requestsExpression = (threadId) =>
  "performance.getEntriesByType('resource').filter((entry) => (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') && entry.name.includes(" +
  JSON.stringify(threadId) +
  ")).map((entry) => { const url = new URL(entry.name); return { path: url.pathname + url.search, start: entry.startTime, duration: entry.duration, server: (entry.serverTiming ?? []).find((timing) => timing.name === 'total')?.duration ?? null } })";

export const labThreadUrl = (baseUrl, thread) =>
  thread.projectId === "proj_personal"
    ? baseUrl.replace(/\/$/, "") + "/threads/" + thread.id
    : threadUrl(baseUrl, thread);

const parseViewport = (viewport) => {
  const [width, height] = viewport.split(",").map(Number);
  return { width, height };
};

const settlePage = (browser, quietMs, timeoutMs) =>
  browser.evaluate(settleExpression(quietMs, timeoutMs));

const launchFirefox = async (options) => {
  const browser = await FirefoxBrowser.launch({
    firefox: options.firefox,
    windowSize: options.viewport,
  });
  await browser.setViewport(parseViewport(options.viewport));
  await browser.addPreloadScript(PAGE_PROBE_SOURCE + "\n" + MEASURE_COLLECTOR);
  return {
    browser,
    version: "Firefox " + (await browser.version()),
    click: (target) =>
      browser.click(target, {
        hoverMs: options.hoverMs,
        pressMs: options.pressMs,
        steps: 1,
      }),
  };
};

const chromeClick = async (browser, target, { hoverMs, pressMs }) => {
  const point =
    typeof target === "string" ? await browser.center(target) : target;
  const mouse = (type, extra = {}) =>
    browser.client.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      ...extra,
    });
  await mouse("mouseMoved");
  await wait(hoverMs);
  await mouse("mousePressed", { button: "left", clickCount: 1 });
  await wait(pressMs);
  await mouse("mouseReleased", { button: "left", clickCount: 1 });
};

const launchChromeDriver = async (options) => {
  const browser = await PerfBrowser.launch({
    chrome: options.chrome,
    windowSize: options.viewport,
  });
  await browser.setViewport(parseViewport(options.viewport));
  await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: MEASURE_COLLECTOR,
  });
  const { product } = await browser.client.send("Browser.getVersion");
  return {
    browser,
    version: product,
    click: (target) => chromeClick(browser, target, options),
  };
};

const DRIVERS = { firefox: launchFirefox, chrome: launchChromeDriver };

const checkLiveness = async (browser, ledger, label) => {
  const state = await browser.evaluate(
    "({ visibility: document.visibilityState, width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
  );
  ledger.record(
    label + ": page visible",
    state.visibility === "visible",
    state,
  );
  const raf = await browser.evaluate("window.__sandyperf.rafProbe(500)");
  const fps = Math.round((raf.frames / raf.elapsedMs) * 1000);
  ledger.record(label + ": rAF frames are produced", fps >= 30, { fps });
  const drift = summarize(
    await browser.evaluate("window.__sandyperf.timerDrift(30, 10)"),
  );
  ledger.record(
    label + ": timers are not throttled",
    drift.p95 !== null && drift.p95 < 25,
    drift,
  );
  const hostBusy = await sampleHostBusyShare(500);
  ledger.record(label + ": host CPU is quiet", hostBusy < 0.5, {
    hostBusyShare: Math.round(hostBusy * 1000) / 1000,
  });
  return { ...state, fps };
};

export const appTimings = (measures) => {
  const total = measures
    .filter((measure) => measure.name === "sandy:switch")
    .sort((a, b) => b.duration - a.duration)[0];
  if (!total) return null;
  const phases = Object.fromEntries(
    SWITCH_PHASES.map((phase) => [phase, null]),
  );
  for (const measure of measures) {
    const phase = measure.name.slice("sandy:switch:".length);
    if (
      measure.name.startsWith("sandy:switch:") &&
      phase in phases &&
      measure.start >= total.start - 0.5 &&
      measure.start <= total.start + total.duration + 0.5
    )
      phases[phase] = (phases[phase] ?? 0) + measure.duration;
  }
  return { appMs: total.duration, label: total.label, ...phases };
};

export const requestTimings = (requests) => {
  if (requests.length === 0) return { network: null, server: null };
  const longest = [...requests].sort((a, b) => b.duration - a.duration)[0];
  return { network: longest.duration, server: longest.server };
};

const measureSwitch = async (options, driver, thread) => {
  const { browser } = driver;
  const selector = "[data-sidebar-thread-id=" + JSON.stringify(thread.id) + "]";
  await browser.reveal(selector);
  await settlePage(browser, 150, 3000);
  await browser.evaluate(RESET_ACTION);
  const waitMs = await timedAction(
    browser,
    "switch",
    threadReadyExpression(thread),
    () => driver.click(selector),
  );
  const settled = await settlePage(browser, 300, 8000);
  const measures = await browser.evaluate("window.__sandymeasures.slice()");
  const requests = await browser.evaluate(requestsExpression(thread.id));
  const domNodes = await browser.evaluate(
    "document.getElementsByTagName('*').length",
  );
  return {
    waitMs,
    settled,
    domNodes,
    ...(appTimings(measures) ?? { appMs: null }),
    ...requestTimings(requests),
    requests,
  };
};

const writeGzipProfile = (rawPath) => {
  const raw = readFileSync(rawPath, "utf8");
  writeFileSync(rawPath + ".gz", gzipSync(raw));
  rmSync(rawPath);
  return { path: rawPath + ".gz", profile: JSON.parse(raw) };
};

export const runRound = async (options, browserName, plan, round, profile) => {
  const driver = await DRIVERS[browserName](options);
  const ledger = new ValidityLedger();
  const samples = [];
  let profilePath = null;
  let windows = null;
  try {
    const { browser } = driver;
    await browser.navigate(labThreadUrl(options.url, plan.start));
    await browser.waitForExpression(threadReadyExpression(plan.start), {
      timeoutMs: 45_000,
      description: "start thread " + plan.start.id,
    });
    await settlePage(browser, 600, 15_000);
    const page = await checkLiveness(browser, ledger, "pre-switch");
    if (profile) await browser.startProfiler();
    for (const [index, thread] of plan.sequence.entries()) {
      if (index === plan.threads.length && options.revisitGapMs > 0)
        await wait(options.revisitGapMs);
      const sample = await measureSwitch(options, driver, thread);
      samples.push({
        browser: browserName,
        round,
        profiled: profile,
        visit: index < plan.threads.length ? "first" : "revisit",
        label: thread.id,
        ...sample,
      });
    }
    if (profile) {
      const rawPath = join(
        options.outDir,
        "round-" + round + "-" + browserName + ".profile.json",
      );
      await browser.dumpProfile(rawPath);
      await browser.stopProfiler();
      const written = writeGzipProfile(rawPath);
      profilePath = written.path;
      windows = await analyzeProfile(options, written.profile, samples);
    }
    return {
      browser: browserName,
      version: driver.version,
      round,
      profiled: profile,
      page,
      validity: ledger.checks,
      valid: ledger.valid,
      samples,
      profilePath,
      windows,
    };
  } finally {
    await driver.browser.close();
  }
};

const analyzeProfile = async (options, profile, samples) => {
  const main = contentMainThread(profile);
  if (main === null) return { error: "no content thread with sandy:switch spans" };
  await loadSourceMaps(jsFrameUrls(main), {
    directory: options.sourcemaps,
    cache: options.sourceMapCache,
  });
  const analysis = analyzeSwitches(profile, {
    resolve: sourceResolver(options.sourceMapCache),
    limit: 25,
  });
  const measured = samples.filter((sample) => sample.waitMs !== null);
  if (analysis.windows.length !== measured.length)
    return {
      error:
        "profile has " +
        analysis.windows.length +
        " lab windows for " +
        measured.length +
        " samples",
    };
  return analysis.windows.map((window, index) => ({
    visit: measured[index].visit,
    label: measured[index].label,
    ...window,
  }));
};

export const planThreads = async (options) => {
  const driver = await launchFirefox(options);
  try {
    const { browser } = driver;
    await browser.navigate(options.url + "/");
    await browser.waitForExpression(
      "document.querySelectorAll(" +
        JSON.stringify(SELECTORS.sidebarThread) +
        ").length > 3",
      { timeoutMs: 45_000, description: "sidebar threads" },
    );
    await settlePage(browser, 600, 15_000);
    const ids = await visibleSidebarThreads(browser);
    const infos = [];
    for (const id of ids) {
      const info = await threadInfo(options.url, id).catch(() => null);
      if (info !== null && !info.archived) infos.push(info);
    }
    const start = options.start
      ? await threadInfo(options.url, options.start)
      : infos[0];
    const threads = infos
      .filter((thread) => thread.id !== start.id)
      .slice(0, options.threadCount);
    if (threads.length < 2)
      throw new Error(
        "Need at least two visible idle sidebar threads, found " +
          threads.length,
      );
    return { start, threads, sequence: [...threads, ...threads] };
  } finally {
    await driver.browser.close();
  }
};

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

export const summarizeSamples = (samples) => {
  const groups = [];
  for (const browser of LAB_BROWSERS)
    for (const visit of ["first", "revisit"]) {
      const group = samples.filter(
        (sample) => sample.browser === browser && sample.visit === visit,
      );
      if (group.length === 0) continue;
      const metrics = Object.fromEntries(
        SAMPLE_METRICS.map((metric) => {
          const values = group
            .map((sample) => sample[metric])
            .filter((value) => typeof value === "number");
          return [
            metric,
            {
              n: values.length,
              p50: round1(median(values)),
              p75: round1(quantile(values, 0.75)),
            },
          ];
        }),
      );
      groups.push({ browser, visit, samples: group.length, metrics });
    }
  return groups;
};

export const summarizeProfiles = (rounds) => {
  const windows = rounds.flatMap((round) =>
    Array.isArray(round.windows) ? round.windows : [],
  );
  const pick = (visit, select) =>
    summarizeWindows(
      windows
        .filter((window) => window.visit === visit)
        .map(select)
        .filter((entry) => entry !== null && entry !== undefined),
      25,
    );
  const phase = (name) => (window) =>
    window.phases.find((entry) => entry.phase === name) ?? null;
  return Object.fromEntries(
    ["first", "revisit"].map((visit) => [
      visit,
      {
        lab: pick(visit, (window) => window.lab),
        app: pick(visit, (window) => window.app),
        render: pick(visit, phase("render")),
        paint: pick(visit, phase("paint")),
      },
    ]),
  );
};

export const runFirefoxLab = async (options) => {
  mkdirSync(options.outDir, { recursive: true });
  const settings = { ...options, sourceMapCache: new Map() };
  const plan = await planThreads(settings);
  const browsers = settings.compareChrome ? LAB_BROWSERS : ["firefox"];
  const rounds = [];
  for (let round = 1; round <= settings.rounds; round += 1) {
    const order = round % 2 === 1 ? browsers : [...browsers].reverse();
    for (const browser of order) {
      const result = await runRound(settings, browser, plan, round, false);
      rounds.push(result);
      settings.onRound?.(result);
    }
  }
  for (let index = 1; index <= settings.profileRounds; index += 1) {
    const result = await runRound(
      settings,
      "firefox",
      plan,
      settings.rounds + index,
      true,
    );
    rounds.push(result);
    settings.onRound?.(result);
  }
  const measuredRounds = rounds.filter((round) => !round.profiled);
  const report = {
    url: settings.url,
    viewport: settings.viewport,
    hoverMs: settings.hoverMs,
    pressMs: settings.pressMs,
    revisitGapMs: settings.revisitGapMs,
    versions: Object.fromEntries(
      rounds.map((round) => [round.browser, round.version]),
    ),
    plan: {
      start: plan.start.id,
      threads: plan.threads.map((thread) => thread.id),
    },
    invalidRounds: rounds
      .filter((round) => !round.valid)
      .map((round) => ({
        browser: round.browser,
        round: round.round,
        failures: round.validity.filter((check) => !check.passed),
      })),
    summary: summarizeSamples(
      measuredRounds
        .filter((round) => round.valid)
        .flatMap((round) => round.samples),
    ),
    profiledSummary: summarizeSamples(
      rounds
        .filter((round) => round.profiled)
        .flatMap((round) => round.samples),
    ),
    profile: settings.profileRounds > 0 ? summarizeProfiles(rounds) : null,
    rounds,
  };
  writeFileSync(
    join(settings.outDir, "firefox-lab.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
};

const fmt = (value) =>
  value === null || value === undefined ? "-" : String(Math.round(value));

const metricLine = (group) =>
  group.browser.padEnd(8) +
  group.visit.padEnd(8) +
  SAMPLE_METRICS.map((metric) => {
    const { p50, p75 } = group.metrics[metric];
    return (fmt(p50) + "/" + fmt(p75)).padStart(metric === "waitMs" ? 10 : 9);
  }).join("");

const printSummary = (title, groups, log) => {
  if (groups.length === 0) return;
  log("\n" + title + " (p50/p75 ms)");
  log(
    "".padEnd(16) +
      SAMPLE_METRICS.map((metric) =>
        metric.padStart(metric === "waitMs" ? 10 : 9),
      ).join(""),
  );
  for (const group of groups) log(metricLine(group));
};

const printWindow = (title, summary, log) => {
  if (!summary) return;
  log(
    "\n" +
      title +
      ": " +
      summary.windows +
      " windows, " +
      fmt(summary.durationMs) +
      " ms, main CPU " +
      fmt(summary.mainCpuMs) +
      " ms, Stylo threads " +
      fmt(summary.styloMs) +
      " ms",
  );
  for (const category of summary.categories.slice(0, 8))
    log(
      "  " +
        category.category.padEnd(12) +
        fmt(category.ms).padStart(6) +
        "  " +
        category.subcategories
          .slice(0, 4)
          .map((entry) => entry.name + " " + fmt(entry.ms))
          .join(", "),
    );
  log("  top functions (self ms, JS ms):");
  for (const fn of summary.functions.slice(0, 15))
    log(
      "    " +
        fmt(fn.ms).padStart(5) +
        fmt(fn.jsMs).padStart(5) +
        "  " +
        fn.name +
        "  " +
        fn.location,
    );
};

export const printFirefoxLabReport = (report, log = console.log) => {
  log("Versions: " + JSON.stringify(report.versions));
  log(
    "Plan: start " +
      report.plan.start +
      ", threads " +
      report.plan.threads.join(" ") +
      ", viewport " +
      report.viewport +
      ", hover " +
      report.hoverMs +
      " ms, press " +
      report.pressMs +
      " ms, revisit gap " +
      report.revisitGapMs +
      " ms",
  );
  for (const invalid of report.invalidRounds)
    log(
      "Invalid round " +
        invalid.round +
        " " +
        invalid.browser +
        ": " +
        invalid.failures.map((check) => check.name).join("; "),
    );
  printSummary("Unprofiled rounds", report.summary, log);
  printSummary("Profiled rounds", report.profiledSummary, log);
  if (report.profile === null) return;
  for (const visit of ["first", "revisit"]) {
    printWindow(
      "Firefox " + visit + " render phase",
      report.profile[visit].render,
      log,
    );
    printWindow(
      "Firefox " + visit + " paint phase",
      report.profile[visit].paint,
      log,
    );
  }
};
