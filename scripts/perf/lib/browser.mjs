import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  createPageTarget,
  evaluateValue,
  launchChrome,
  reservePort,
  resolveChrome,
  wait,
} from "./cdp.mjs";
import { attributeCpu, cpuProfiles, frameUrls } from "./attribution.mjs";
import { summarize } from "./metrics.mjs";
import { loadSourceMaps, sourceResolver } from "./sourcemap.mjs";
import {
  ATTRIBUTION_CATEGORIES,
  analyzeTrace,
  startTrace,
  stopTrace,
} from "./trace.mjs";

const SOURCE_MAP_CACHE = new Map();

const PAGE_PROBE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "page-probe.js"),
  "utf8",
);

const cpuTimes = () => cpus().map((cpu) => cpu.times);

export const sampleHostBusyShare = async (durationMs = 1000) => {
  const before = cpuTimes();
  await wait(durationMs);
  const after = cpuTimes();
  let busy = 0;
  let total = 0;
  for (let index = 0; index < before.length; index += 1) {
    const idle = after[index].idle - before[index].idle;
    const all = Object.keys(after[index]).reduce(
      (sum, key) => sum + after[index][key] - before[index][key],
      0,
    );
    busy += all - idle;
    total += all;
  }
  return total === 0 ? 0 : busy / total;
};

export class PerfBrowser {
  constructor({
    client,
    proc,
    profileDir,
    port,
    headless,
    windowSize,
    cpuThrottle,
    attribute,
  }) {
    this.client = client;
    this.cpuThrottle = cpuThrottle;
    this.attribute = attribute;
    this.proc = proc;
    this.profileDir = profileDir;
    this.port = port;
    this.headless = headless;
    this.windowSize = windowSize;
    this.network = null;
  }

  static async launch({
    chrome,
    headless = true,
    windowSize = "1600,1000",
    extraArgs = [],
    cpuThrottle = 1,
    attribute = false,
  } = {}) {
    const port = await reservePort();
    const profileDir = mkdtempSync(join(tmpdir(), "sandy-perf-chrome-"));
    const executable = resolveChrome(chrome);
    const proc = launchChrome({
      chrome: executable,
      profileDir,
      port,
      headless,
      extraArgs,
      windowSize,
    });
    const exited = new Promise((_, reject) =>
      proc.once("exit", (code) =>
        reject(new Error("Chrome exited early with code " + code)),
      ),
    );
    exited.catch(() => {});
    const target = await Promise.race([createPageTarget(port), exited]);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    const browser = new PerfBrowser({
      client,
      proc,
      profileDir,
      port,
      headless,
      windowSize,
      cpuThrottle,
      attribute,
    });
    await browser.setup();
    return browser;
  }

  async setup() {
    const { client } = this;
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Performance.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (this.cpuThrottle > 1)
      await client.send("Emulation.setCPUThrottlingRate", {
        rate: this.cpuThrottle,
      });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: PAGE_PROBE_SOURCE,
    });
    await client.send("Page.bringToFront");
    this.trackNetwork();
  }

  async watchOnLoad(specs) {
    const source = "window.__sandyperf.watch(" + JSON.stringify(specs) + ")";
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async readWatches(names, ledger, label) {
    const { results, pending } = await this.evaluate(
      "window.__sandyperf.watches()",
    );
    for (const name of names)
      ledger.record(
        label + ": '" + name + "' became ready",
        Boolean(results[name]?.paintedMs),
        { pending },
      );
    return results;
  }

  trackNetwork() {
    const requests = new Map();
    this.network = requests;
    this.client.on("Network.requestWillBeSent", (params) => {
      requests.set(params.requestId, {
        url: params.request.url,
        startedAt: params.timestamp,
        type: params.type,
        bytes: 0,
        status: null,
        finishedAt: null,
        fromCache: false,
      });
    });
    this.client.on("Network.responseReceived", (params) => {
      const entry = requests.get(params.requestId);
      if (!entry) return;
      entry.status = params.response.status;
      entry.fromCache = Boolean(
        params.response.fromDiskCache || params.response.fromServiceWorker,
      );
    });
    this.client.on("Network.loadingFinished", (params) => {
      const entry = requests.get(params.requestId);
      if (!entry) return;
      entry.finishedAt = params.timestamp;
      entry.bytes = params.encodedDataLength;
    });
  }

  networkSummary() {
    const entries = [...this.network.values()];
    const finished = entries.filter((entry) => entry.finishedAt !== null);
    const byType = {};
    for (const entry of finished) {
      const bucket = (byType[entry.type ?? "Other"] ??= { count: 0, bytes: 0 });
      bucket.count += 1;
      bucket.bytes += entry.bytes;
    }
    const slowest = finished
      .map((entry) => ({
        url: entry.url.slice(0, 140),
        ms: (entry.finishedAt - entry.startedAt) * 1000,
        bytes: entry.bytes,
        status: entry.status,
        type: entry.type,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
    return {
      requests: entries.length,
      finished: finished.length,
      failed: entries.filter(
        (entry) => entry.status !== null && entry.status >= 400,
      ).length,
      transferredBytes: finished.reduce(
        (total, entry) => total + entry.bytes,
        0,
      ),
      byType,
      slowest,
    };
  }

  resetNetwork() {
    this.network.clear();
  }

  async setCacheDisabled(disabled) {
    await this.client.send("Network.setCacheDisabled", {
      cacheDisabled: disabled,
    });
  }

  evaluate(expression) {
    return evaluateValue(this.client, expression);
  }

  async navigate(url, { timeoutMs = 60_000 } = {}) {
    const loaded = this.client.once("Page.loadEventFired", timeoutMs);
    await this.client.send("Page.navigate", { url });
    await loaded;
  }

  async reload({ timeoutMs = 60_000 } = {}) {
    const loaded = this.client.once("Page.loadEventFired", timeoutMs);
    await this.client.send("Page.reload", { ignoreCache: false });
    await loaded;
  }

  async waitForExpression(
    expression,
    { timeoutMs = 30_000, intervalMs = 50, description = expression } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate("Boolean(" + expression + ")")) return;
      await wait(intervalMs);
    }
    throw new Error(
      "Timed out after " + timeoutMs + " ms waiting for: " + description,
    );
  }

  async rect(selector) {
    const rect = await this.evaluate(
      "(() => { const el = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()",
    );
    if (!rect) throw new Error("No element matches " + selector);
    return rect;
  }

  async center(selector) {
    const rect = await this.rect(selector);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  async mouseMove(point) {
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
  }

  async setViewport({ width, height, mobile = false }) {
    await this.client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }

  async reveal(selector) {
    await this.evaluate(
      "(() => { const node = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!node) throw new Error('no element for ' + " +
        JSON.stringify(selector) +
        "); node.scrollIntoView({ block: 'nearest' }); return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })()",
    );
  }

  async click(target, { clickCount = 1 } = {}) {
    const point =
      typeof target === "string" ? await this.center(target) : target;
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount,
    });
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount,
    });
  }

  async pressKey(
    key,
    { code = key, windowsVirtualKeyCode, modifiers = 0 } = {},
  ) {
    await this.client.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
  }

  async typeText(text, { perCharDelayMs = 0 } = {}) {
    for (const character of text) {
      const isNewline = character === "\n";
      const key = isNewline ? "Enter" : character;
      await this.client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        text: isNewline ? "\r" : character,
        unmodifiedText: isNewline ? "\r" : character,
      });
      await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      if (perCharDelayMs > 0) await wait(perCharDelayMs);
    }
  }

  async insertText(text) {
    await this.client.send("Input.insertText", { text });
  }

  async scrollGesture({
    x,
    y,
    distance,
    speed = 1600,
    source = "mouse",
    repeatCount = 0,
    repeatDelayMs = 0,
  }) {
    await this.client.send("Input.synthesizeScrollGesture", {
      x,
      y,
      yDistance: -distance,
      speed,
      gestureSourceType: source,
      repeatCount,
      repeatDelayMs,
      preventFling: true,
    });
  }

  async touchFling({ x, y, distance, durationMs = 80, steps = 10 }) {
    const startY = Math.round(y - distance / 2);
    const touch = (type, pointY) =>
      this.client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y: pointY }],
      });
    await touch("touchStart", startY);
    for (let step = 1; step <= steps; step += 1) {
      await touch("touchMove", Math.round(startY + (distance * step) / steps));
      await wait(durationMs / steps);
    }
    await touch("touchEnd", startY + distance);
  }

  async wheel(point, deltaY) {
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY,
    });
  }

  async performanceMetrics() {
    const { metrics } = await this.client.send("Performance.getMetrics");
    return Object.fromEntries(
      metrics.map((metric) => [metric.name, metric.value]),
    );
  }

  async heapUsage() {
    try {
      return await this.client.send("Runtime.getHeapUsage");
    } catch {
      return null;
    }
  }

  async collectGarbage() {
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
  }

  async livenessProbe(ledger, { label = "pre-capture", minFps = 30 } = {}) {
    const state = await this.evaluate(
      "({ visibility: document.visibilityState, hasFocus: document.hasFocus() })",
    );
    ledger.record(
      label + ": page visible",
      state.visibility === "visible",
      state,
    );
    const raf = await this.evaluate("window.__sandyperf.rafProbe(500)");
    const fps = (raf.frames / raf.elapsedMs) * 1000;
    ledger.record(
      label + ": rAF frames are produced (page not throttled)",
      fps >= minFps,
      {
        frames: raf.frames,
        elapsedMs: Math.round(raf.elapsedMs),
        fps: Math.round(fps),
      },
    );
    const drift = await this.evaluate("window.__sandyperf.timerDrift(30, 10)");
    const driftSummary = summarize(drift);
    ledger.record(
      label + ": timers are not throttled",
      driftSummary.p95 !== null && driftSummary.p95 < 25,
      driftSummary,
    );
    return { fps, drift: driftSummary };
  }

  async capture({
    label,
    ledger,
    action,
    urlPrefix,
    expectFrames = true,
    expectActivity = true,
    minWindowMs = 0,
    onTrace = null,
  }) {
    const hostBusy = await sampleHostBusyShare(500);
    ledger.record(
      label + ": host CPU is quiet before capture",
      hostBusy < 0.5,
      { hostBusyShare: Math.round(hostBusy * 1000) / 1000, loadavg: loadavg() },
    );
    await this.livenessProbe(ledger, { label });
    await this.evaluate("window.__sandyperf.reset()");
    const metricsBefore = await this.performanceMetrics();
    const before = await this.evaluate("window.__sandyperf.collect()");
    const handle = await startTrace(this.client, {
      extraCategories: this.attribute ? ATTRIBUTION_CATEGORIES : [],
    });
    await this.evaluate("window.__sandyperf.mark('sandyperf:start')");
    const startedAt = Date.now();
    let actionResult;
    let actionError = null;
    try {
      actionResult = await action();
    } catch (error) {
      actionError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    await this.evaluate("window.__sandyperf.mark('sandyperf:end')");
    const events = await stopTrace(this.client, handle);
    if (actionError) throw actionError;
    const after = await this.evaluate("window.__sandyperf.collect()");
    const metricsAfter = await this.performanceMetrics();
    const startMark = events.find((event) => event.name === "sandyperf:start");
    const endMark = events.find((event) => event.name === "sandyperf:end");
    ledger.record(
      label + ": trace window markers present",
      Boolean(startMark && endMark),
      { start: Boolean(startMark), end: Boolean(endMark) },
    );
    const analysis = analyzeTrace(events, {
      urlPrefix,
      windowStartTs: startMark?.ts,
      windowEndTs: endMark?.ts,
    });
    ledger.record(
      label + ": trace contains a renderer main thread",
      analysis.ok,
      analysis.ok ? analysis.main : analysis.reason,
    );
    if (analysis.ok) {
      ledger.record(
        label + ": trace window covers the action",
        analysis.windowMs >= Math.max(minWindowMs, elapsedMs * 0.8),
        { windowMs: analysis.windowMs, actionMs: elapsedMs },
      );
      ledger.record(
        label + ": main-thread tasks were recorded",
        analysis.mainThread.taskCount > 0,
        { taskCount: analysis.mainThread.taskCount },
      );
      if (expectFrames)
        ledger.record(
          label + ": frames were presented",
          analysis.frames.presentedCount >= 2,
          {
            presented: analysis.frames.presentedCount,
            states: analysis.frames.reporterStates,
          },
        );
      if (expectActivity)
        ledger.record(
          label + ": renderer did measurable work",
          analysis.mainThread.busyMs > 1,
          { busyMs: analysis.mainThread.busyMs },
        );
    }
    ledger.record(
      label + ": page stayed visible and focused",
      after.visibility === "visible",
      { visibility: after.visibility, hasFocus: after.hasFocus },
    );
    const attribution =
      this.attribute && startMark && endMark
        ? await this.attributeWindow(events, {
            name: label,
            pid: startMark.pid,
            start: startMark.ts,
            end: endMark.ts,
          })
        : null;
    const inspected = onTrace === null ? null : onTrace(events);
    return {
      label,
      actionResult,
      actionMs: elapsedMs,
      analysis,
      attribution,
      inspected,
      page: {
        longTasks: summarize(after.longTasks.map((entry) => entry.duration)),
        longAnimationFrames: {
          ...summarize(after.loafs.map((entry) => entry.duration)),
          blocking: summarize(after.loafs.map((entry) => entry.blocking)),
          worst: after.loafs
            .slice()
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5)
            .map((entry) => ({
              duration: Math.round(entry.duration),
              blocking: Math.round(entry.blocking),
              renderStart: Math.round(entry.renderStart - entry.start),
              styleAndLayoutStart: Math.round(
                entry.styleAndLayoutStart - entry.start,
              ),
              scripts: entry.scripts
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 4)
                .map((script) => ({
                  ...script,
                  duration: Math.round(script.duration),
                  forcedStyleAndLayout: Math.round(script.forcedStyleAndLayout),
                })),
            })),
        },
        slowEvents: after.slowEvents.slice(0, 20),
        observerErrors: after.errors,
        domNodes: { before: before.domNodes, after: after.domNodes },
        jsHeapUsed: { before: before.jsHeapUsed, after: after.jsHeapUsed },
        viewport: {
          width: after.innerWidth,
          height: after.innerHeight,
          dpr: after.devicePixelRatio,
        },
      },
      counters: {
        before: metricsBefore,
        after: metricsAfter,
        delta: Object.fromEntries(
          [
            "LayoutCount",
            "RecalcStyleCount",
            "LayoutDuration",
            "RecalcStyleDuration",
            "ScriptDuration",
            "TaskDuration",
            "Nodes",
            "JSHeapUsedSize",
            "JSEventListeners",
            "Documents",
            "Frames",
          ].map((key) => [key, metricsAfter[key] - metricsBefore[key]]),
        ),
      },
    };
  }

  async attributeWindow(events, window) {
    const profiles = cpuProfiles(events);
    await loadSourceMaps(frameUrls(profiles), { cache: SOURCE_MAP_CACHE });
    const [attribution] = attributeCpu(profiles, [window], {
      resolve: sourceResolver(SOURCE_MAP_CACHE),
    });
    return attribution;
  }

  async close() {
    try {
      this.client.close();
    } catch {}
    this.proc.kill("SIGKILL");
    await wait(200);
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
