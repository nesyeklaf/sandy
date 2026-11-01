import { compareMedians, quantile } from "./ab-stats.mjs";
import { labWindows } from "./attribution.mjs";
import { FRAME_BUDGET_MS, framesFrom } from "./trace.mjs";

export const SCROLL_WINDOW_PREFIX = "lab:scroll:";

export const SCROLL_GESTURES = [
  { name: "scroll-up", source: "mouse", distance: -6000, speed: 1200 },
  { name: "fling-up", source: "touch", drag: 400, durationMs: 80 },
];

const round = (value, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export const frameStats = (
  times,
  { start, end, budgetMs = FRAME_BUDGET_MS },
) => {
  const inside = times
    .filter((time) => time >= start && time <= end)
    .sort((a, b) => a - b);
  const intervals = inside.slice(1).map((time, index) => time - inside[index]);
  const windowMs = end - start;
  const slots = Math.max(1, Math.ceil(windowMs / budgetMs));
  const hit = new Set(
    inside.map((time) =>
      Math.min(slots - 1, Math.floor((time - start) / budgetMs)),
    ),
  ).size;
  return {
    windowMs: round(windowMs, 1),
    frames: inside.length,
    p50Ms: round(quantile(intervals, 0.5)),
    p95Ms: round(quantile(intervals, 0.95)),
    p99Ms: round(quantile(intervals, 0.99)),
    longestMs: round(intervals.length === 0 ? null : Math.max(...intervals)),
    slots,
    missedFrames: slots - hit,
    droppedPct: round(((slots - hit) / slots) * 100, 1),
  };
};

const scriptKey = (script) =>
  (script.fn || script.invoker || "(anonymous)") +
  " " +
  (script.source ? script.source + ":" + (script.char ?? -1) : "(no source)");

export const loafSummary = (loafs, limit = 5) => {
  const scripts = new Map();
  for (const loaf of loafs)
    for (const script of loaf.scripts) {
      const key = scriptKey(script);
      const entry = scripts.get(key) ?? {
        fn: script.fn || script.invoker || "(anonymous)",
        invoker: script.invoker,
        type: script.type,
        source: script.source || null,
        char: script.char ?? null,
        count: 0,
        durationMs: 0,
        forcedStyleAndLayoutMs: 0,
      };
      entry.count += 1;
      entry.durationMs += script.duration;
      entry.forcedStyleAndLayoutMs += script.forcedStyleAndLayout;
      scripts.set(key, entry);
    }
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  return {
    count: loafs.length,
    totalMs: round(sum(loafs.map((loaf) => loaf.duration)), 1),
    blockingMs: round(sum(loafs.map((loaf) => loaf.blocking)), 1),
    longestMs: round(
      loafs.length === 0 ? 0 : Math.max(...loafs.map((loaf) => loaf.duration)),
      1,
    ),
    scripts: [...scripts.values()]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        durationMs: round(entry.durationMs, 1),
        forcedStyleAndLayoutMs: round(entry.forcedStyleAndLayoutMs, 1),
      })),
  };
};

export const measureScrollGesture = async (
  browser,
  { scroller, point, gesture, quietMs = 300 },
) => {
  await browser.evaluate(
    "window.__sandyperf.recordScroll(" + JSON.stringify(scroller) + ")",
  );
  if (gesture.source === "touch")
    await browser.touchFling({
      ...point,
      distance: gesture.drag,
      durationMs: gesture.durationMs,
    });
  else
    await browser.scrollGesture({
      ...point,
      distance: gesture.distance,
      speed: gesture.speed,
      source: gesture.source,
    });
  const recording = await browser.evaluate(
    "window.__sandyperf.stopScroll(" + quietMs + ")",
  );
  const moved = Math.round(Math.abs(recording.endTop - recording.startTop));
  if (recording.firstScrollAt === null || recording.scrollCount < 2)
    return { name: gesture.name, moved, scrolled: false };
  const window = {
    start: recording.firstScrollAt,
    end: recording.lastScrollAt,
  };
  await browser.evaluate(
    "performance.measure(" +
      JSON.stringify(SCROLL_WINDOW_PREFIX + gesture.name) +
      ", " +
      JSON.stringify(window) +
      "), true",
  );
  return {
    name: gesture.name,
    moved,
    scrolled: true,
    scrollEvents: recording.scrollCount,
    inputToScrollMs: round(recording.firstScrollAt - recording.requestedAt, 1),
    durationMs: round(window.end - window.start, 1),
    raf: frameStats(recording.rafTimes, window),
    loaf: loafSummary(recording.loafs),
    presented: null,
  };
};

export const tracePacing = (events) =>
  labWindows(events, SCROLL_WINDOW_PREFIX).map((window) => {
    const { presented, dropped } = framesFrom(
      events,
      window.pid,
      window.start,
      window.end,
    );
    return {
      name: window.name.slice(SCROLL_WINDOW_PREFIX.length),
      ...frameStats(
        presented.map((frame) => frame.end / 1000),
        { start: window.start / 1000, end: window.end / 1000 },
      ),
      chromeDroppedFrames: dropped,
    };
  });

export const attachPacing = (results, pacing) => {
  const scrolled = results.filter((result) => result.scrolled);
  if (scrolled.length !== pacing.length) return false;
  scrolled.forEach((result, index) => {
    result.presented = pacing[index];
  });
  return true;
};

export const SMOOTHNESS_METRICS = [
  ["presented p95", (result) => result.presented?.p95Ms],
  ["presented p99", (result) => result.presented?.p99Ms],
  ["presented longest", (result) => result.presented?.longestMs],
  ["presented dropped %", (result) => result.presented?.droppedPct],
  ["rAF p95", (result) => result.raf?.p95Ms],
  ["rAF dropped %", (result) => result.raf?.droppedPct],
  ["LoAF blocking", (result) => result.loaf?.blockingMs],
];

export const compareSmoothness = (a, b) =>
  SMOOTHNESS_METRICS.map(([metric, read]) => {
    const values = (results) =>
      results.map(read).filter((value) => typeof value === "number");
    const comparison = compareMedians(values(a), values(b));
    return {
      metric,
      samples: { a: values(a).length, b: values(b).length },
      ...comparison,
      verdict:
        comparison.verdict === undefined
          ? undefined
          : comparison.verdict
              .replace("faster", "smoother")
              .replace("slower", "rougher"),
    };
  });
