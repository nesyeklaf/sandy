import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abOrder, compareRounds, median } from "./ab-stats.mjs";
import { AppApi } from "./api.mjs";
import {
  REACT_DEVTOOLS_STUB,
  attributeTrace,
  cpuProfiles,
  frameUrls,
  summarizeAttribution,
} from "./attribution.mjs";
import { PerfBrowser } from "./browser.mjs";
import { querySqlFile, writeTrace } from "./perfetto.mjs";
import { SCROLLER_SELECTORS, scrollerPoint } from "./scroll.mjs";
import {
  SCROLL_GESTURES,
  attachPacing,
  compareSmoothness,
  measureScrollGesture,
  tracePacing,
} from "./smoothness.mjs";
import { loadSourceMaps, sourceResolver } from "./sourcemap.mjs";
import { ATTRIBUTION_CATEGORIES, startTrace, stopTrace } from "./trace.mjs";
import { SELECTORS, openThread, settle, threadReadyExpression } from "./ui.mjs";

export const AB_SCENARIOS = ["switch", "scroll"];

const MEASURE_COLLECTOR =
  "window.__sandymeasures = []; new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.name.startsWith('sandy:')) window.__sandymeasures.push({ name: entry.name, duration: entry.duration, label: entry.detail?.sandy?.label ?? null }) }).observe({ type: 'measure' });";
const MENU_TRIGGER_POINT =
  "(() => { const node = [...document.querySelectorAll(\"button[aria-label='Thread actions']\")].find((candidate) => { const rect = candidate.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !candidate.closest(" +
  JSON.stringify(SELECTORS.sidebarBody) +
  ") }); if (!node) return null; const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()";

export const AB_GROUPS = [
  ["switch", "first"],
  ["switch", "revisit"],
  ["open", "first"],
  ["open", "revisit"],
];
export const LOAD_GROUP = ["load", "first"];
const SCROLL_GROUPS = SCROLL_GESTURES.map((gesture) => [
  gesture.name,
  "scroll",
]);

const BREAKDOWN_FIELDS = [
  "busy_ms",
  "idle_ms",
  "longest_task_ms",
  "script_ms",
  "style_ms",
  "layout_ms",
  "paint_ms",
  "gc_ms",
  "other_ms",
];

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + " answered " + response.status);
  return response.json();
};

export const threadInfo = async (base, id) => {
  const body = await fetchJson(base + "/api/v1/threads/" + id);
  const thread = body.thread ?? body;
  return {
    id,
    projectId: thread.projectId,
    archived: Boolean(thread.archivedAt ?? thread.archived),
  };
};

export const visibleSidebarThreads = (browser) =>
  browser.evaluate(
    "[...document.querySelectorAll(" +
      JSON.stringify(SELECTORS.sidebarThread) +
      ")].filter((node) => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight }).map((node) => node.getAttribute('data-sidebar-thread-id')).filter((id, index, all) => all.indexOf(id) === index)",
  );

export const timedAction = async (browser, kind, readyExpression, act) => {
  await browser.evaluate(
    "window.__sandyperf.arm(" + JSON.stringify(readyExpression) + ", 20000)",
  );
  await act();
  const result = await browser.evaluate("window.__sandyperf.collectArmed()");
  if (
    !result ||
    result.timedOut ||
    result.staleAtArm ||
    !result.sawInput ||
    result.waitMs === null
  )
    return null;
  await browser.evaluate(
    "performance.measure(" +
      JSON.stringify("lab:" + kind) +
      ", { start: " +
      result.startMs +
      ", end: " +
      (result.startMs + result.waitMs) +
      " }), true",
  );
  return result.waitMs;
};

const parseViewport = (viewport) => {
  const [width, height] = viewport.split(",").map(Number);
  return { width, height };
};

const runSwitches = async (options, browser, plan, samples) => {
  for (const [index, thread] of plan.sequence.entries()) {
    const selector =
      "[data-sidebar-thread-id=" + JSON.stringify(thread.id) + "]";
    await browser.reveal(selector);
    const waitMs = await timedAction(
      browser,
      "switch",
      threadReadyExpression(thread),
      () => browser.click(selector),
    );
    samples.push({
      kind: "switch",
      visit: index < plan.threads.length ? "first" : "revisit",
      label: thread.id,
      waitMs,
    });
    await settle(browser, { quietMs: 300, timeoutMs: 8000 });
  }
  for (let index = 0; index < options.menuCount; index += 1) {
    const point = await browser.evaluate(MENU_TRIGGER_POINT);
    const waitMs =
      point === null
        ? null
        : await timedAction(
            browser,
            "open",
            "Boolean(document.querySelector('[role=menu]'))",
            () => browser.click(point),
          );
    samples.push({
      kind: "open",
      visit: index === 0 ? "first" : "revisit",
      label: "thread actions",
      waitMs,
    });
    await browser.pressKey("Escape");
    await settle(browser, { quietMs: 300, timeoutMs: 5000 });
  }
};

const runScroll = async (browser, plan, samples) => {
  const scroller = SCROLLER_SELECTORS.timeline;
  const point = await scrollerPoint(browser, scroller);
  for (const gesture of SCROLL_GESTURES) {
    const smoothness = await measureScrollGesture(browser, {
      scroller,
      point,
      gesture,
    });
    samples.push({
      kind: gesture.name,
      visit: "scroll",
      label: plan.start.id,
      waitMs:
        smoothness.scrolled && smoothness.moved > 100
          ? smoothness.durationMs
          : null,
      smoothness,
    });
  }
};

const measureFirstLoad = async (browser, plan, samples) => {
  await browser
    .waitForExpression(
      "Boolean(window.__sandyperf.watches().results.startThread?.paintedMs)",
      { timeoutMs: 5000, description: "start thread painted" },
    )
    .catch(() => null);
  const { results } = await browser.evaluate("window.__sandyperf.watches()");
  samples.push({
    kind: "load",
    visit: "first",
    label: plan.start.id,
    waitMs: results.startThread?.paintedMs ?? null,
  });
};

const attachTraceResults = async (options, events, variant, plan, samples) => {
  const tracePath = join(
    options.outDir,
    "round-" + plan.round + "-" + variant + ".trace.json",
  );
  if (options.scrolling)
    attachPacing(
      samples.map((sample) => sample.smoothness),
      tracePacing(events),
    );
  await writeTrace(tracePath, events);
  const rows = querySqlFile(tracePath, "interaction-breakdown.sql");
  if (!options.keepTraces) rmSync(tracePath);
  const measured = samples.filter(
    (sample) => sample.kind !== "load" && sample.waitMs !== null,
  );
  if (options.attribute) {
    await loadSourceMaps(frameUrls(cpuProfiles(events)), {
      directory: options.sourcemaps,
      cache: options.sourceMapCache,
    });
    const attributions = attributeTrace(events, {
      resolve: sourceResolver(options.sourceMapCache),
      components: options.reactComponents,
    });
    if (attributions.length === measured.length)
      measured.forEach((sample, index) => {
        sample.attribution = attributions[index];
      });
  }
  if (rows.length === measured.length) {
    measured.forEach((sample, index) => {
      sample.breakdown = rows[index];
    });
    return null;
  }
  return {
    error:
      "trace has " +
      rows.length +
      " lab windows for " +
      measured.length +
      " samples",
    rows,
  };
};

const runVariant = async (options, variant, plan) => {
  const { width, height } = parseViewport(options.viewport);
  const browser = await PerfBrowser.launch({
    chrome: options.chrome,
    windowSize: options.viewport,
    cpuThrottle: options.cpuThrottle,
  });
  const samples = [];
  try {
    await browser.setViewport({ width, height });
    await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: MEASURE_COLLECTOR,
    });
    if (options.reactComponents)
      await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: REACT_DEVTOOLS_STUB,
      });
    if (options.measureLoad)
      await browser.watchOnLoad({
        startThread: threadReadyExpression(plan.start),
      });
    await openThread(browser, options.urls[variant], plan.start);
    if (options.measureLoad) await measureFirstLoad(browser, plan, samples);
    await settle(browser, { quietMs: 600, timeoutMs: 15_000 });
    const trace = options.tracing
      ? await startTrace(browser.client, {
          extraCategories: options.attribute ? ATTRIBUTION_CATEGORIES : [],
        })
      : null;
    if (options.scrolling) await runScroll(browser, plan, samples);
    else await runSwitches(options, browser, plan, samples);
    const measures = await browser.evaluate("window.__sandymeasures");
    const breakdown =
      trace === null
        ? null
        : await attachTraceResults(
            options,
            await stopTrace(browser.client, trace),
            variant,
            plan,
            samples,
          );
    return { samples, measures, breakdown };
  } finally {
    await browser.close();
  }
};

const planScroll = async (options) => {
  if (options.start)
    return { start: await threadInfo(options.urls.a, options.start) };
  const [heaviest] = await new AppApi(options.urls.a).rankSidebarThreads(40);
  return { start: heaviest };
};

const planThreads = async (options) => {
  if (options.scrolling) return { ...(await planScroll(options)), threads: [] };
  const { width, height } = parseViewport(options.viewport);
  const browser = await PerfBrowser.launch({
    chrome: options.chrome,
    windowSize: options.viewport,
  });
  try {
    await browser.setViewport({ width, height });
    await browser.navigate(options.urls.a + "/");
    await browser.waitForExpression(
      "document.querySelectorAll(" +
        JSON.stringify(SELECTORS.sidebarThread) +
        ").length > 3",
      {
        timeoutMs: 45_000,
        description: "sidebar threads",
      },
    );
    await settle(browser);
    const ids = await visibleSidebarThreads(browser);
    const infos = [];
    for (const id of ids) {
      const info = await threadInfo(options.urls.a, id).catch(() => null);
      if (info !== null && !info.archived) infos.push(info);
    }
    const start = options.start
      ? await threadInfo(options.urls.a, options.start)
      : infos[0];
    const threads = infos
      .filter((thread) => thread.id !== start.id)
      .slice(0, options.threadCount);
    if (threads.length < 2)
      throw new Error(
        "Need at least two visible idle sidebar threads, found " +
          threads.length,
      );
    return { start, threads };
  } finally {
    await browser.close();
  }
};

const roundLine = (scrolling, samples) => {
  if (!scrolling) {
    const switches = samples.filter(
      (sample) => sample.kind === "switch" && sample.waitMs !== null,
    );
    return (
      "switch median " +
      Math.round(median(switches.map((sample) => sample.waitMs)) ?? NaN) +
      " ms"
    );
  }
  return samples
    .map(
      (sample) =>
        sample.kind +
        " p95 " +
        (sample.smoothness.presented?.p95Ms ?? "-") +
        " ms dropped " +
        (sample.smoothness.presented?.droppedPct ?? "-") +
        "%",
    )
    .join(", ");
};

export const runAb = async ({
  urls,
  scenario = "switch",
  start: startId = null,
  threadCount = 4,
  menuCount = 3,
  rounds = 8,
  cpuThrottle = 1,
  viewport = "1600,1000",
  trace = false,
  keepTraces = false,
  measureLoad = false,
  attribute = false,
  reactComponents = false,
  sourcemaps = null,
  chrome,
  outDir,
  log = console.log,
}) => {
  if (!AB_SCENARIOS.includes(scenario))
    throw new Error("Unknown scenario '" + scenario + "'");
  const scrolling = scenario === "scroll";
  const attributing = attribute || reactComponents;
  const options = {
    urls: { a: urls.a.replace(/\/$/, ""), b: urls.b.replace(/\/$/, "") },
    scrolling,
    start: startId,
    threadCount,
    menuCount,
    cpuThrottle,
    viewport,
    tracing: trace || attributing || scrolling,
    keepTraces,
    measureLoad: measureLoad && !scrolling,
    attribute: attributing,
    reactComponents,
    sourcemaps,
    sourceMapCache: new Map(),
    chrome,
    outDir,
  };
  mkdirSync(outDir, { recursive: true });
  const { start, threads } = await planThreads(options);
  const sequence = [...threads, ...threads];
  log(
    scrolling
      ? "scrolling " + start.id
      : "start " +
          start.id +
          ", switching between " +
          threads.map((thread) => thread.id).join(" "),
  );
  const runs = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const variant of abOrder(round)) {
      const result = await runVariant(options, variant, {
        round,
        start,
        threads,
        sequence,
      });
      runs.push({ round, variant, ...result });
      log(
        "round " +
          (round + 1) +
          "/" +
          rounds +
          " " +
          variant +
          ": " +
          roundLine(scrolling, result.samples) +
          ", " +
          result.samples.filter((sample) => sample.waitMs === null).length +
          " invalid",
      );
    }
  }

  const variantSamples = (variant) =>
    runs.filter((run) => run.variant === variant).flatMap((run) => run.samples);
  const actionGroups = scrolling ? SCROLL_GROUPS : AB_GROUPS;
  const groups = options.measureLoad
    ? [LOAD_GROUP, ...actionGroups]
    : actionGroups;
  const pick = (variant, kind, visit) =>
    variantSamples(variant)
      .filter(
        (sample) =>
          sample.kind === kind &&
          sample.visit === visit &&
          sample.waitMs !== null,
      )
      .map((sample) => sample.waitMs);
  const attempts = (variant, kind, visit) =>
    variantSamples(variant).filter(
      (sample) => sample.kind === kind && sample.visit === visit,
    ).length;
  const validWaits = (run, kind, visit) =>
    (run?.samples ?? [])
      .filter(
        (sample) =>
          sample.kind === kind &&
          sample.visit === visit &&
          sample.waitMs !== null,
      )
      .map((sample) => sample.waitMs);
  const roundWaits = (kind, visit) =>
    [...new Set(runs.map((run) => run.round))].map((round) => {
      const runOf = (variant) =>
        runs.find((run) => run.round === round && run.variant === variant);
      return {
        a: validWaits(runOf("a"), kind, visit),
        b: validWaits(runOf("b"), kind, visit),
      };
    });
  const comparisons = groups.map(([kind, visit]) => ({
    kind,
    visit,
    samples: {
      a: pick("a", kind, visit).length,
      b: pick("b", kind, visit).length,
    },
    attempts: {
      a: attempts("a", kind, visit),
      b: attempts("b", kind, visit),
    },
    ...compareRounds(roundWaits(kind, visit)),
  }));
  const smoothnessOf = (variant, kind) =>
    variantSamples(variant)
      .filter((sample) => sample.kind === kind && sample.waitMs !== null)
      .map((sample) => sample.smoothness);
  const smoothness = scrolling
    ? SCROLL_GESTURES.map((gesture) => ({
        gesture: gesture.name,
        metrics: compareSmoothness(
          smoothnessOf("a", gesture.name),
          smoothnessOf("b", gesture.name),
        ),
      }))
    : [];
  const breakdowns = groups
    .flatMap(([kind, visit]) =>
      ["a", "b"].map((variant) => {
        const rows = variantSamples(variant).filter(
          (sample) =>
            sample.kind === kind && sample.visit === visit && sample.breakdown,
        );
        return {
          kind,
          visit,
          variant,
          samples: rows.length,
          ...Object.fromEntries(
            BREAKDOWN_FIELDS.map((field) => [
              field,
              median(rows.map((sample) => sample.breakdown[field])),
            ]),
          ),
        };
      }),
    )
    .filter((row) => row.samples > 0);
  const attributions = options.attribute
    ? [...new Set(actionGroups.map(([kind]) => kind))].flatMap((kind) =>
        ["a", "b"].map((variant) => ({
          kind,
          variant,
          ...summarizeAttribution(
            variantSamples(variant)
              .filter((sample) => sample.kind === kind && sample.attribution)
              .map((sample) => sample.attribution),
          ),
        })),
      )
    : [];
  const spans = ["a", "b"].map((variant) => {
    const measures = runs
      .filter((run) => run.variant === variant)
      .flatMap((run) => run.measures);
    const names = [...new Set(measures.map((measure) => measure.name))].sort();
    return {
      variant,
      spans: names.map((name) => ({
        name,
        count: measures.filter((m) => m.name === name).length,
        medianMs: median(
          measures.filter((m) => m.name === name).map((m) => m.duration),
        ),
      })),
    };
  });
  const report = {
    startedAt: new Date().toISOString(),
    urls: options.urls,
    rounds,
    cpuThrottle,
    viewport,
    start: start.id,
    threads: threads.map((thread) => thread.id),
    scenario,
    comparisons,
    smoothness,
    breakdowns,
    attributions,
    spans,
    runs,
  };
  writeFileSync(join(outDir, "ab.json"), JSON.stringify(report, null, 2));
  return report;
};

const fmt = (value) =>
  value === null || value === undefined ? "-" : String(Math.round(value));
const decimal = (value) =>
  value === null || value === undefined ? "-" : value.toFixed(1);
const shorten = (text, width) =>
  text.length > width ? "…" + text.slice(text.length - width + 1) : text;

const printSmoothness = (report, throttleNote, log) => {
  for (const { gesture, metrics } of report.smoothness) {
    log(
      "\n" +
        gesture +
        ", median per run (95% CI of b - a), lower is smoother" +
        throttleNote,
    );
    for (const row of metrics)
      log(
        row.metric.padEnd(22) +
          " a " +
          decimal(row.a).padStart(7) +
          "  b " +
          decimal(row.b).padStart(7) +
          "  delta " +
          decimal(row.delta).padStart(7) +
          " [" +
          decimal(row.low) +
          ", " +
          decimal(row.high) +
          "]  " +
          (row.verdict ?? "too few samples"),
      );
  }
};

const printComparisons = (report, throttleNote, log) => {
  log("\nwait until usable, median ms (95% CI of b - a)" + throttleNote);
  for (const row of report.comparisons)
    log(
      (row.kind + " " + row.visit).padEnd(16) +
        " a " +
        fmt(row.a).padStart(5) +
        "  b " +
        fmt(row.b).padStart(5) +
        "  delta " +
        fmt(row.delta).padStart(5) +
        " [" +
        fmt(row.low) +
        ", " +
        fmt(row.high) +
        "]  " +
        (row.verdict ?? "too few samples"),
    );
};

const printBreakdowns = (report, log) => {
  if (report.breakdowns.length === 0) return;
  log("\nmain thread inside the wait, median ms (Perfetto)");
  log(
    "".padEnd(20) +
      BREAKDOWN_FIELDS.map((field) =>
        field.replace("_task", "").replace("_ms", "").padStart(8),
      ).join(""),
  );
  for (const row of report.breakdowns)
    log(
      (row.kind + " " + row.visit + " " + row.variant).padEnd(20) +
        BREAKDOWN_FIELDS.map((field) => fmt(row[field]).padStart(8)).join(""),
    );
};

const printAttributions = (report, log) => {
  for (const summary of report.attributions.filter(
    (entry) => entry.waits > 0,
  )) {
    log(
      "\nJS self time per " +
        summary.kind +
        " wait, " +
        summary.variant +
        ", mean ms over " +
        summary.waits +
        " waits (" +
        fmt(summary.sampledMs) +
        " ms sampled)",
    );
    for (const entry of summary.functions.slice(0, 8))
      log(
        entry.selfMs.toFixed(1).padStart(8) +
          "  " +
          shorten(entry.name, 32).padEnd(32) +
          " " +
          shorten(entry.location, 60),
      );
    log("  modules:");
    for (const entry of summary.modules.slice(0, 6))
      log(
        entry.selfMs.toFixed(1).padStart(8) + "  " + shorten(entry.module, 80),
      );
    if (summary.components !== null && summary.components.length === 0)
      log(
        "  React components: none recorded, the server does not run a React profiling build",
      );
    else if (summary.components !== null) {
      log("  React components (self render time):");
      for (const entry of summary.components.slice(0, 6))
        log(
          entry.selfMs.toFixed(1).padStart(8) +
            "  " +
            shorten(entry.component, 40).padEnd(40) +
            " " +
            entry.renders +
            " renders",
        );
    }
  }
};

export const printAbReport = (report, log = console.log) => {
  const throttleNote =
    report.cpuThrottle > 1 ? ", CPU " + report.cpuThrottle + "x slower" : "";
  printSmoothness(report, throttleNote, log);
  if (report.scenario !== "scroll") printComparisons(report, throttleNote, log);
  printBreakdowns(report, log);
  printAttributions(report, log);
  for (const { variant, spans: list } of report.spans)
    if (list.length > 0)
      log(
        variant +
          " app spans: " +
          list
            .map(
              (span) =>
                span.name + " " + fmt(span.medianMs) + " (" + span.count + ")",
            )
            .join(", "),
      );
};
