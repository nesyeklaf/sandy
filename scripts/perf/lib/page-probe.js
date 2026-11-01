(() => {
  if (window.__sandyperf) return;
  const state = {
    longTasks: [],
    loafs: [],
    slowEvents: [],
    errors: [],
    armed: null,
    rafFrames: 0,
    rafRunning: false,
  };
  const observe = (type, options, handler) => {
    try {
      new PerformanceObserver((list) =>
        list.getEntries().forEach(handler),
      ).observe({ type, buffered: true, ...options });
    } catch (error) {
      state.errors.push(type + ": " + error.message);
    }
  };
  const describeTarget = (node) => {
    if (!node || !node.tagName) return null;
    const testId = node.getAttribute && node.getAttribute("data-testid");
    return (
      node.tagName.toLowerCase() +
      (testId ? "[data-testid=" + testId + "]" : "")
    );
  };
  observe("longtask", {}, (entry) =>
    state.longTasks.push({ start: entry.startTime, duration: entry.duration }),
  );
  observe("long-animation-frame", {}, (entry) =>
    state.loafs.push({
      start: entry.startTime,
      duration: entry.duration,
      blocking: entry.blockingDuration,
      renderStart: entry.renderStart,
      styleAndLayoutStart: entry.styleAndLayoutStart,
      scripts: entry.scripts.map((script) => ({
        invoker: script.invoker,
        type: script.invokerType,
        source: script.sourceURL,
        fn: script.sourceFunctionName,
        char: script.sourceCharPosition,
        duration: script.duration,
        forcedStyleAndLayout: script.forcedStyleAndLayoutDuration,
      })),
    }),
  );
  observe("event", { durationThreshold: 16 }, (entry) =>
    state.slowEvents.push({
      type: entry.name,
      start: entry.startTime,
      duration: entry.duration,
      inputDelay: entry.processingStart - entry.startTime,
      target: describeTarget(entry.target),
    }),
  );
  const onInput = (event) => {
    const armed = state.armed;
    if (armed && armed.inputAt === null) armed.inputAt = event.timeStamp;
  };
  for (const type of ["pointerdown", "keydown", "click", "wheel"])
    window.addEventListener(type, onInput, { capture: true, passive: true });

  const evaluate = (source) => {
    try {
      return Boolean(new Function("return (" + source + ")")());
    } catch (error) {
      state.errors.push("predicate: " + error.message);
      return false;
    }
  };

  const arm = (source, timeoutMs) => {
    if (state.armed && state.armed.cleanup) state.armed.cleanup();
    const armed = {
      armedAt: performance.now(),
      inputAt: null,
      staleAtArm: evaluate(source),
      satisfiedAt: null,
      paintedAt: null,
      timedOut: false,
      cleanup: null,
      done: null,
    };
    state.armed = armed;
    armed.done = new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        armed.cleanup();
        resolve();
      };
      const check = () => {
        if (finished || armed.satisfiedAt !== null || armed.staleAtArm) return;
        if (!evaluate(source)) return;
        armed.satisfiedAt = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            armed.paintedAt = performance.now();
            finish();
          }),
        );
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const interval = setInterval(check, 4);
      const timeout = setTimeout(() => {
        armed.timedOut = true;
        finish();
      }, timeoutMs);
      armed.cleanup = () => {
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(timeout);
      };
      if (armed.staleAtArm) finish();
    });
  };

  const collectArmed = async () => {
    const armed = state.armed;
    if (!armed) return null;
    await armed.done;
    const start = armed.inputAt ?? armed.armedAt;
    return {
      staleAtArm: armed.staleAtArm,
      timedOut: armed.timedOut,
      sawInput: armed.inputAt !== null,
      startMs: start,
      waitMs: armed.paintedAt === null ? null : armed.paintedAt - start,
      readyMs: armed.satisfiedAt === null ? null : armed.satisfiedAt - start,
    };
  };

  const rafProbe = (durationMs) =>
    new Promise((resolve) => {
      let frames = 0;
      const started = performance.now();
      const tick = () => {
        frames += 1;
        if (performance.now() - started < durationMs)
          requestAnimationFrame(tick);
        else resolve({ frames, elapsedMs: performance.now() - started });
      };
      requestAnimationFrame(tick);
    });

  const timerDrift = (count, intervalMs) =>
    new Promise((resolve) => {
      const drifts = [];
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        drifts.push(now - last - intervalMs);
        last = now;
        if (drifts.length >= count) resolve(drifts);
        else setTimeout(step, intervalMs);
      };
      setTimeout(step, intervalMs);
    });

  const recordScroll = (selector) => {
    const scroller = document.querySelector(selector);
    if (!scroller) throw new Error("no scroller for " + selector);
    const recording = {
      scroller,
      requestedAt: performance.now(),
      startTop: scroller.scrollTop,
      scrolls: [],
      rafs: [],
      running: true,
    };
    recording.onScroll = () => recording.scrolls.push(performance.now());
    scroller.addEventListener("scroll", recording.onScroll, { passive: true });
    const tick = (timestamp) => {
      recording.rafs.push(timestamp);
      if (recording.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    state.scrollRecording = recording;
    return true;
  };

  const stopScroll = (quietMs) =>
    new Promise((resolve) => {
      const recording = state.scrollRecording;
      const check = () => {
        const last = recording.scrolls.at(-1) ?? recording.requestedAt;
        if (performance.now() - last < quietMs) {
          setTimeout(check, 16);
          return;
        }
        recording.running = false;
        recording.scroller.removeEventListener("scroll", recording.onScroll);
        state.scrollRecording = null;
        const first = recording.scrolls[0] ?? null;
        const lastScroll = recording.scrolls.at(-1) ?? null;
        const inside = (time) =>
          first !== null && time >= first && time <= lastScroll;
        resolve({
          requestedAt: recording.requestedAt,
          firstScrollAt: first,
          lastScrollAt: lastScroll,
          scrollCount: recording.scrolls.length,
          startTop: recording.startTop,
          endTop: recording.scroller.scrollTop,
          rafTimes: recording.rafs.filter(inside),
          loafs: state.loafs.filter(
            (entry) =>
              first !== null &&
              entry.start + entry.duration >= first &&
              entry.start <= lastScroll,
          ),
        });
      };
      setTimeout(check, quietMs);
    });

  const watches = {
    results: {},
    pending: new Map(),
    dirty: true,
    running: false,
  };
  const watch = (specs) => {
    for (const [name, source] of Object.entries(specs))
      watches.pending.set(name, source);
    new MutationObserver(() => {
      watches.dirty = true;
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    if (watches.running) return;
    watches.running = true;
    const loop = () => {
      if (watches.dirty) {
        watches.dirty = false;
        for (const [name, source] of [...watches.pending]) {
          if (!evaluate(source)) continue;
          watches.pending.delete(name);
          watches.results[name] = {
            readyMs: performance.now(),
            paintedMs: null,
          };
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              watches.results[name].paintedMs = performance.now();
            }),
          );
        }
      }
      if (watches.pending.size > 0) requestAnimationFrame(loop);
      else watches.running = false;
    };
    requestAnimationFrame(loop);
  };

  window.__sandyperf = {
    arm,
    watch,
    watches: () => ({
      results: watches.results,
      pending: [...watches.pending.keys()],
    }),
    paintTimings: () =>
      performance
        .getEntriesByType("paint")
        .map((entry) => ({ name: entry.name, start: entry.startTime })),
    navigationTiming: () => {
      const [entry] = performance.getEntriesByType("navigation");
      if (!entry) return null;
      return {
        responseStart: entry.responseStart,
        domContentLoaded: entry.domContentLoadedEventEnd,
        load: entry.loadEventEnd,
        transferSize: entry.transferSize,
        decodedBodySize: entry.decodedBodySize,
      };
    },
    largestContentfulPaint: () =>
      new Promise((resolve) => {
        let last = null;
        try {
          const observer = new PerformanceObserver((list) => {
            last = list.getEntries().at(-1) ?? last;
          });
          observer.observe({
            type: "largest-contentful-paint",
            buffered: true,
          });
          setTimeout(() => {
            observer.disconnect();
            resolve(
              last
                ? {
                    start: last.startTime,
                    size: last.size,
                    element: last.element
                      ? last.element.tagName.toLowerCase()
                      : null,
                  }
                : null,
            );
          }, 50);
        } catch {
          resolve(null);
        }
      }),
    collectArmed,
    rafProbe,
    recordScroll,
    stopScroll,
    timerDrift,
    reset() {
      state.longTasks.length = 0;
      state.loafs.length = 0;
      state.slowEvents.length = 0;
      state.errors.length = 0;
    },
    collect() {
      return {
        longTasks: state.longTasks.slice(),
        loafs: state.loafs.slice(),
        slowEvents: state.slowEvents.slice(),
        errors: state.errors.slice(),
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        domNodes: document.getElementsByTagName("*").length,
        jsHeapUsed: performance.memory
          ? performance.memory.usedJSHeapSize
          : null,
        now: performance.now(),
        url: location.href,
      };
    },
    mark(name) {
      performance.mark(name);
    },
  };
})();
