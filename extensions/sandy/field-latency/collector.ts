import type { Sample, ScrollStats } from "./contract.ts";
import { normalizeLabel } from "./stats.ts";
import { TraceBook, type TraceRecord } from "./traces.ts";
import { deriveNetworkPhases, type RequestTiming } from "./network.ts";
import { CALIBRATION_FRAMES, INPUT_WINDOW_MS, ScrollSession, estimateRefreshMs, scrollContainerLabel } from "./scroll.ts";

const TRIGGER = 'button, a, [role="menuitem"], [role="option"], [role="tab"], [role="combobox"], [data-sidebar-thread-id]';
const OVERLAY = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-radix-popper-content-wrapper]';
const COMPOSER = "#thread-detail-follow-up-composer";
const THREAD_PATH = /\/threads\/([^/?#]+)/;
const OPEN_TIMEOUT_MS = 3000;
const SWITCH_TIMEOUT_MS = 15000;
const SETTLE_TIMEOUT_MS = 2000;
const FINALIZE_DELAY_MS = 700;
const SLOW_EVENT_MS = 100;
const BUFFER_WINDOW_MS = 60000;
const UNCLAIMED_TRACE_MS = 3000;
const MAX_REQUESTS = 500;
const CALIBRATION_DELAY_MS = 3000;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface ScriptTiming {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}

interface FrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  styleAndLayoutStart?: number;
  scripts?: readonly ScriptTiming[];
}

interface EventEntry extends PerformanceEntry {
  processingStart: number;
  processingEnd: number;
  interactionId?: number;
}

interface SeenEvent {
  name: string;
  start: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
  interactionId: number;
  label: string;
}

interface Pending {
  t0: number;
  at: number;
  label: string;
  threadTarget: string | null;
  threadBefore: string | null;
  finalized: boolean;
  needsComposer: boolean;
  kind: "open" | "switch" | null;
  overlay: string | null;
  overlayElement: Element | null;
  mountAt: number | null;
  readyAt: number | null;
  settledAt: number | null;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface Collector {
  dispose(): void;
}

function threadIdOf(path: string): string | null {
  return THREAD_PATH.exec(path)?.[1] ?? null;
}

function triggerLabel(element: Element): string {
  if (element.closest("[data-sidebar-thread-id]")) return "sidebar thread";
  const named = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "";
  const label = normalizeLabel(named);
  const role = element.getAttribute("role");
  return label.length > 0 ? label : `(${role ?? element.tagName.toLowerCase()})`;
}

function eventLabel(entry: PerformanceEntry): string {
  const target = (entry as PerformanceEntry & { target?: Node | null }).target;
  const element = target instanceof Element ? target : null;
  const trigger = element?.closest(TRIGGER) ?? null;
  const where = trigger ? triggerLabel(trigger) : element ? element.tagName.toLowerCase() : "(detached)";
  return `${entry.name} · ${where}`;
}

function shortSource(url: string | undefined): string {
  if (!url) return "(inline)";
  const clean = url.split(/[?#]/)[0] ?? url;
  const parts = clean.split("/").filter((part) => part.length > 0);
  const plugin = parts.indexOf("plugins");
  const tail = plugin >= 0 ? parts.slice(plugin, plugin + 2).concat(parts.slice(-1)) : parts.slice(-1);
  return tail.join("/").slice(0, 200);
}

function supports(type: string): boolean {
  return typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes(type);
}

function afterPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      callback();
    };
    channel.port2.postMessage(null);
  });
}

function round(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export function startCollector(emit: (sample: Sample) => void, signal: AbortSignal): Collector {
  const frames: FrameEntry[] = [];
  const events: SeenEvent[] = [];
  const tracked = new Set<number>();
  const visited = new Set<string>();
  const observers: PerformanceObserver[] = [];
  const requests: RequestTiming[] = [];
  const session = new ScrollSession();
  let sessionActive = false;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let refreshMs: number | null = null;
  let calibrationTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Pending | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let traceTimer: ReturnType<typeof setTimeout> | null = null;
  const traces = new TraceBook();
  const current = threadIdOf(location.pathname);
  if (current) visited.add(current);

  const prune = (now: number) => {
    while (frames.length > 0 && (frames[0]?.startTime ?? now) < now - BUFFER_WINDOW_MS) frames.shift();
    while (events.length > 0 && (events[0]?.start ?? now) < now - BUFFER_WINDOW_MS) events.shift();
    while (requests.length > 0 && ((requests[0]?.startTime ?? now) < now - BUFFER_WINDOW_MS || requests.length > MAX_REQUESTS)) {
      requests.shift();
    }
  };

  if (supports("resource")) {
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceResourceTiming;
        if (entry.initiatorType !== "fetch" && entry.initiatorType !== "xmlhttprequest") continue;
        if (!entry.name.startsWith(location.origin)) continue;
        requests.push({
          startTime: entry.startTime,
          requestStart: entry.requestStart,
          responseStart: entry.responseStart,
          responseEnd: entry.responseEnd,
          serverTiming: (entry.serverTiming ?? []).map((metric) => ({ name: metric.name, duration: metric.duration })),
        });
      }
      prune(performance.now());
    });
    observer.observe({ type: "resource", buffered: false });
    observers.push(observer);
  }

  if (supports("long-animation-frame")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) frames.push(entry as FrameEntry);
      prune(performance.now());
    });
    observer.observe({ type: "long-animation-frame", buffered: false });
    observers.push(observer);
  }

  if (supports("event")) {
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as EventEntry;
        const interactionId = entry.interactionId ?? 0;
        if (interactionId === 0) continue;
        events.push({
          name: entry.name,
          start: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          interactionId,
          label: eventLabel(entry),
        });
      }
      prune(performance.now());
      scheduleSlowCheck();
    });
    observer.observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
    observers.push(observer);
  }

  if (supports("measure")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith("sandy:")) continue;
        const measure = entry as PerformanceMeasure;
        if (traces.add({ startTime: measure.startTime, duration: measure.duration, detail: measure.detail }) !== null) {
          scheduleTraceCheck();
        }
      }
    });
    observer.observe({ type: "measure", buffered: false });
    observers.push(observer);
  }

  function scheduleTraceCheck() {
    if (traceTimer !== null) return;
    traceTimer = setTimeout(() => {
      traceTimer = null;
      if (signal.aborted) return;
      for (const record of traces.takeUnclaimed(performance.now() - UNCLAIMED_TRACE_MS)) emitTraceOnly(record);
      scheduleTraceCheck();
    }, UNCLAIMED_TRACE_MS);
  }

  function emitTraceOnly(record: TraceRecord) {
    const threadId = record.kind === "switch" ? record.label : threadIdOf(location.pathname);
    const visit = record.kind === "switch" ? (visited.has(record.label) ? "revisit" : "first") : null;
    if (record.kind === "switch") visited.add(record.label);
    emit(buildSample({
      kind: record.kind,
      label: record.kind === "switch" ? "keyboard or link switch" : `keyboard ${record.label}`,
      at: Date.now() - Math.round(performance.now() - record.start),
      start: record.start,
      end: record.end,
      threadId,
      visit,
      overlay: record.kind === "open" ? record.label : null,
      mountMs: null,
      readyMs: record.end - record.start,
      settledMs: null,
      timedOut: false,
      event: interactionEvent(record.start, record.end),
      trace: record,
    }));
  }

  const mutationObserver = new MutationObserver((records) => onMutations(records));

  function scheduleSlowCheck() {
    if (slowTimer !== null) return;
    slowTimer = setTimeout(() => {
      slowTimer = null;
      if (pending !== null) {
        scheduleSlowCheck();
        return;
      }
      reportSlowEvents(performance.now() - FINALIZE_DELAY_MS);
    }, 1500);
  }

  const reported = new Set<number>();

  function reportSlowEvents(before: number) {
    const byInteraction = new Map<number, SeenEvent>();
    for (const event of events) {
      if (event.start > before || tracked.has(event.interactionId) || reported.has(event.interactionId)) continue;
      const known = byInteraction.get(event.interactionId);
      if (!known || event.duration > known.duration) byInteraction.set(event.interactionId, event);
    }
    for (const [interactionId, event] of byInteraction) {
      reported.add(interactionId);
      if (event.duration < SLOW_EVENT_MS) continue;
      const end = event.start + event.duration;
      emit(buildSample({
        kind: "slow",
        label: event.label.slice(0, 120),
        at: Date.now() - Math.round(performance.now() - event.start),
        start: event.start,
        end,
        threadId: threadIdOf(location.pathname),
        visit: null,
        overlay: null,
        mountMs: null,
        readyMs: null,
        settledMs: null,
        timedOut: false,
        event,
        trace: null,
      }));
    }
    if (reported.size > 2000) reported.clear();
  }

  function buildSample(args: {
    kind: Sample["kind"];
    label: string;
    at: number;
    start: number;
    end: number;
    threadId: string | null;
    visit: Sample["visit"];
    overlay: string | null;
    mountMs: number | null;
    readyMs: number | null;
    settledMs: number | null;
    timedOut: boolean;
    event: SeenEvent | null;
    trace: TraceRecord | null;
    scroll?: ScrollStats;
  }): Sample {
    const overlapping = frames.filter((frame) => frame.startTime < args.end && frame.startTime + frame.duration > args.start);
    const scripts = overlapping
      .flatMap((frame) => frame.scripts ?? [])
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5)
      .map((script) => ({
        source: shortSource(script.sourceURL),
        invoker: (script.invoker ?? script.sourceFunctionName ?? "").slice(0, 200),
        durationMs: round(script.duration),
        forcedStyleLayoutMs: round(script.forcedStyleAndLayoutDuration ?? 0),
      }));
    const event = args.event;
    const network = args.trace === null ? null : deriveNetworkPhases(requests, args.trace.start, args.trace.end);
    return {
      kind: args.kind,
      label: args.label,
      at: args.at,
      path: location.pathname.slice(0, 300),
      threadId: args.threadId,
      visit: args.visit,
      overlay: args.overlay,
      mountMs: args.mountMs === null ? null : round(args.mountMs),
      readyMs: args.readyMs === null ? null : round(args.readyMs),
      settledMs: args.settledMs === null ? null : round(args.settledMs),
      timedOut: args.timedOut,
      eventMs: event ? round(event.duration) : null,
      inputDelayMs: event ? round(event.processingStart - event.start) : null,
      processingMs: event ? round(event.processingEnd - event.processingStart) : null,
      presentationMs: event ? round(event.start + event.duration - event.processingEnd) : null,
      frameMs: round(overlapping.reduce((sum, frame) => sum + frame.duration, 0)),
      blockingMs: round(overlapping.reduce((sum, frame) => sum + (frame.blockingDuration ?? 0), 0)),
      styleLayoutMs: round(
        overlapping.reduce(
          (sum, frame) => sum + (frame.styleAndLayoutStart ? frame.startTime + frame.duration - frame.styleAndLayoutStart : 0),
          0,
        ),
      ),
      scripts,
      domNodes: document.getElementsByTagName("*").length,
      tracedMs: args.trace === null ? null : round(args.trace.end - args.trace.start),
      phases: args.trace === null ? null : { ...args.trace.phases, ...network },
      scroll: args.scroll ?? null,
    };
  }

  function interactionEvent(t0: number, end: number): SeenEvent | null {
    const first = events.find((event) => event.start >= t0 - 1 && event.start <= end);
    if (!first) return null;
    tracked.add(first.interactionId);
    let worst = first;
    for (const event of events) {
      if (event.interactionId === first.interactionId && event.duration > worst.duration) worst = event;
    }
    return worst;
  }

  function stop(item: Pending) {
    if (item.timer !== null) clearTimeout(item.timer);
    item.timer = null;
    if (pending === item) {
      pending = null;
      mutationObserver.disconnect();
    }
  }

  function finalize(item: Pending) {
    stop(item);
    const kind = item.kind;
    if (item.finalized || kind === null) return;
    item.finalized = true;
    setTimeout(() => {
      if (signal.aborted) return;
      const end = item.settledAt ?? item.readyAt ?? item.mountAt ?? item.t0 + (kind === "switch" ? SWITCH_TIMEOUT_MS : OPEN_TIMEOUT_MS);
      const threadId = kind === "switch" ? item.threadTarget : threadIdOf(location.pathname);
      const visit = kind === "switch" && threadId ? (visited.has(threadId) ? "revisit" : "first") : null;
      if (kind === "switch" && threadId && !item.timedOut) visited.add(threadId);
      emit(buildSample({
        kind: kind,
        label: item.label,
        at: item.at,
        start: item.t0,
        end,
        threadId,
        visit,
        overlay: item.overlay,
        mountMs: item.mountAt === null ? null : item.mountAt - item.t0,
        readyMs: item.readyAt === null ? null : item.readyAt - item.t0,
        settledMs: item.settledAt === null ? null : item.settledAt - item.t0,
        timedOut: item.timedOut,
        event: interactionEvent(item.t0, end),
        trace: traces.claim(kind, item.t0),
      }));
    }, FINALIZE_DELAY_MS);
  }

  function waitForSettle(item: Pending) {
    const element = item.overlayElement;
    const animations = element && typeof element.getAnimations === "function" ? element.getAnimations({ subtree: true }) : [];
    if (animations.length === 0) {
      item.settledAt = item.readyAt;
      finalize(item);
      return;
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS));
    void Promise.race([Promise.allSettled(animations.map((animation) => animation.finished)), timeout]).then(() => {
      item.settledAt = performance.now();
      finalize(item);
    });
  }

  function switchReady(item: Pending): boolean {
    const id = item.threadTarget;
    if (!id || threadIdOf(location.pathname) !== id) return false;
    if (!document.querySelector(`[data-timeline-row-id^="${CSS.escape(id)}:"]`)) return false;
    return !item.needsComposer || document.querySelector(COMPOSER) !== null;
  }

  function onMutations(records: readonly MutationRecord[]) {
    const item = pending;
    if (item === null || item.mountAt !== null) return;
    const now = performance.now();
    const pathThread = threadIdOf(location.pathname);
    if (item.threadTarget === null && pathThread !== null && pathThread !== item.threadBefore) {
      item.threadTarget = pathThread;
      armTimer(item, SWITCH_TIMEOUT_MS);
    }
    if (item.threadTarget !== null) {
      item.kind = "switch";
      if (switchReady(item)) {
        item.mountAt = now;
        afterPaint(() => {
          item.readyAt = performance.now();
          item.settledAt = item.readyAt;
          finalize(item);
        });
      }
      return;
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const overlay = node.matches(OVERLAY) ? node : node.querySelector(OVERLAY);
        if (!overlay) continue;
        item.kind = "open";
        item.overlay = overlay.getAttribute("role") ?? "popper";
        item.overlayElement = overlay;
        item.mountAt = now;
        afterPaint(() => {
          item.readyAt = performance.now();
          waitForSettle(item);
        });
        return;
      }
    }
  }

  function armTimer(item: Pending, timeoutMs: number) {
    if (item.timer !== null) clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.timer = null;
      item.timedOut = item.kind === "switch" && item.readyAt === null;
      finalize(item);
    }, Math.max(0, item.t0 + timeoutMs - performance.now()));
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || document.visibilityState !== "visible") return;
    const target = event.target instanceof Element ? event.target.closest(TRIGGER) : null;
    if (!target) return;
    if (pending !== null && pending.mountAt === null) stop(pending);
    if (pending !== null) return;
    const href = target instanceof HTMLAnchorElement ? target.getAttribute("href") ?? "" : "";
    const threadTarget = target.closest("[data-sidebar-thread-id]")?.getAttribute("data-sidebar-thread-id") ?? threadIdOf(href);
    const currentThread = threadIdOf(location.pathname);
    if (threadTarget !== null && threadTarget === currentThread) return;
    const item: Pending = {
      t0: event.timeStamp,
      at: Date.now(),
      label: triggerLabel(target),
      threadTarget,
      threadBefore: currentThread,
      finalized: false,
      needsComposer: document.querySelector(COMPOSER) !== null,
      kind: null,
      overlay: null,
      overlayElement: null,
      mountAt: null,
      readyAt: null,
      settledAt: null,
      timedOut: false,
      timer: null,
    };
    pending = item;
    armTimer(item, threadTarget !== null ? SWITCH_TIMEOUT_MS : OPEN_TIMEOUT_MS);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function onHidden() {
    if (document.visibilityState === "hidden" && pending !== null) stop(pending);
  }

  function onInput(event: Event) {
    lastInputAt = event.timeStamp;
  }

  function onKey(event: KeyboardEvent) {
    if (SCROLL_KEYS.has(event.key)) lastInputAt = event.timeStamp;
  }

  function onScroll(event: Event) {
    const now = event.timeStamp;
    if (sessionActive) {
      session.lastEventAt = now;
      return;
    }
    if (now - lastInputAt > INPUT_WINDOW_MS || document.visibilityState !== "visible") return;
    const target = event.target;
    session.begin(now, scrollContainerLabel(target instanceof Element ? target : null));
    sessionActive = true;
    requestAnimationFrame(scrollFrame);
  }

  function scrollFrame(timestamp: number) {
    if (!sessionActive || signal.aborted) return;
    if (document.visibilityState !== "visible") {
      sessionActive = false;
      return;
    }
    session.record(timestamp);
    if (session.shouldEnd(timestamp)) {
      endScrollSession();
      return;
    }
    requestAnimationFrame(scrollFrame);
  }

  function endScrollSession() {
    sessionActive = false;
    const result = session.finish(refreshMs);
    if (result === null) return;
    refreshMs = result.refreshMs;
    const label = session.label;
    setTimeout(() => {
      if (signal.aborted) return;
      emit(buildSample({
        kind: "scroll",
        label,
        at: Date.now() - Math.round(performance.now() - result.start),
        start: result.start,
        end: result.end,
        threadId: threadIdOf(location.pathname),
        visit: null,
        overlay: null,
        mountMs: null,
        readyMs: null,
        settledMs: null,
        timedOut: false,
        event: null,
        trace: null,
        scroll: result.stats,
      }));
    }, FINALIZE_DELAY_MS);
  }

  function calibrateRefresh() {
    calibrationTimer = null;
    if (refreshMs !== null || signal.aborted) return;
    const retry = () => {
      calibrationTimer = setTimeout(calibrateRefresh, CALIBRATION_DELAY_MS);
    };
    if (document.visibilityState !== "visible" || sessionActive) {
      retry();
      return;
    }
    const stamps = new Float64Array(CALIBRATION_FRAMES);
    let count = 0;
    const tick = (timestamp: number) => {
      if (signal.aborted) return;
      if (document.visibilityState !== "visible" || sessionActive) {
        retry();
        return;
      }
      stamps[count++] = timestamp;
      if (count < stamps.length) requestAnimationFrame(tick);
      else refreshMs = estimateRefreshMs(stamps);
    };
    requestAnimationFrame(tick);
  }

  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onHidden);
  document.addEventListener("wheel", onInput, { capture: true, passive: true });
  document.addEventListener("touchstart", onInput, { capture: true, passive: true });
  document.addEventListener("touchmove", onInput, { capture: true, passive: true });
  document.addEventListener("pointerdown", onInput, { capture: true, passive: true });
  document.addEventListener("keydown", onKey, { capture: true, passive: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  calibrationTimer = setTimeout(calibrateRefresh, CALIBRATION_DELAY_MS);

  const dispose = () => {
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("visibilitychange", onHidden);
    document.removeEventListener("wheel", onInput, { capture: true });
    document.removeEventListener("touchstart", onInput, { capture: true });
    document.removeEventListener("touchmove", onInput, { capture: true });
    document.removeEventListener("pointerdown", onInput, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("scroll", onScroll, { capture: true });
    sessionActive = false;
    if (calibrationTimer !== null) clearTimeout(calibrationTimer);
    mutationObserver.disconnect();
    for (const observer of observers) observer.disconnect();
    if (pending !== null) stop(pending);
    if (slowTimer !== null) clearTimeout(slowTimer);
    if (traceTimer !== null) clearTimeout(traceTimer);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return { dispose };
}
