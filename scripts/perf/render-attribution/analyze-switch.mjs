import { cpuProfiles, labWindows } from "../lib/attribution.mjs";
import { chunkLabel } from "../lib/sourcemap.mjs";

export const HARNESS = "lab harness (probe, polling)";

export const EXTRA_TRACE_CATEGORIES = [
  "disabled-by-default-v8.cpu_profiler",
  "v8.execute",
  "disabled-by-default-devtools.timeline.stack",
  "devtools.timeline.async",
];

const BROWSER_WORK = [
  ["style", /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|StyleEngine::|Document::UpdateStyle|SelectorStats)/],
  ["layout", /^(Layout|LocalFrameView::performLayout|UpdateIntersectionObservations|IntersectionObserverController::computeIntersections|ResizeObserver::|UpdateResizeObservers)/],
  ["paint", /^(PrePaint|Paint$|PaintImage|Layerize|Decode|ImageDecode)/],
  ["composite", /^(Commit|UpdateLayerTree|CompositeLayers|UpdateLayer$)/],
  ["gc", /^(MinorGC|MajorGC|BlinkGC|V8\.GC|CppGC|ThreadState::)/],
  ["parse-html", /^ParseHTML$/],
  ["hit-test", /^HitTest$/],
];

const JS_EVENTS = /^(FunctionCall|EvaluateScript|v8\.callFunction|v8\.run|v8\.compile|v8\.evaluateModule|V8\.Execute|TimerFire|FireAnimationFrame|FireIdleCallback|EventDispatch|RunMicrotasks|HandlePostMessage|XHRReadyStateChange|XHRLoad|WebSocketReceive|ProfileCall)/;

const NATIVE = new Set(["(program)", "(garbage collector)", "(root)", "(idle)"]);

const browserCategory = (name) => BROWSER_WORK.find(([, pattern]) => pattern.test(name))?.[0] ?? null;

export const pluginAssetHash = (url) => /\/plugin-app-assets\/([0-9a-z]+)\//.exec(url ?? "")?.[1] ?? null;

export const ownerOfUrl = (url, pluginByHash) => {
  if (!url) return null;
  if (url.endsWith("ra-switch-probe.js")) return HARNESS;
  const hash = pluginAssetHash(url);
  if (hash !== null) return pluginByHash[hash] ?? "plugin:" + hash;
  if (/\/assets\//.test(url) || /\/(index|main)[^/]*\.js/.test(url)) return "host";
  return "other:" + chunkLabel(url).slice(0, 60);
};

const rendererMain = (events, switchWindow) => {
  const names = new Map();
  for (const event of events)
    if (event.ph === "M" && event.name === "thread_name") names.set(event.pid + ":" + event.tid, event.args?.name);
  for (const [key, name] of names) {
    const [pid, tid] = key.split(":").map(Number);
    if (name === "CrRendererMain" && pid === switchWindow.pid) return { pid, tid };
  }
  return null;
};

const nestEvents = (events) => {
  const ordered = events
    .filter((event) => event.ph === "X" && typeof event.dur === "number")
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [];
  const nodes = [];
  for (const event of ordered) {
    while (stack.length > 0 && stack.at(-1).end <= event.ts) stack.pop();
    const parent = stack.at(-1) ?? null;
    const node = {
      name: event.name,
      start: event.ts,
      end: event.ts + event.dur,
      args: event.args ?? {},
      parent,
      depth: parent === null ? 0 : parent.depth + 1,
      childUs: 0,
    };
    if (parent) parent.childUs += Math.min(node.end, parent.end) - node.start;
    stack.push(node);
    nodes.push(node);
  }
  return nodes;
};

const clip = (start, end, windowStart, windowEnd) => Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));

const inJs = (node) => {
  for (let current = node.parent; current !== null; current = current.parent) if (JS_EVENTS.test(current.name)) return true;
  return false;
};

const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);

const ms = (us) => Math.round(us / 10) / 100;

const toObject = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, ms(value)]));

const SIDEBAR_OWNERS = new Set(["sandy-sidebar-delegate", "host:sidebar", "host:detached"]);

export const contentDoneMs = (probe) => {
  const content = probe.batches.filter((batch) => Object.keys(batch.owners).some((owner) => !SIDEBAR_OWNERS.has(owner)));
  return content.reduce((max, batch) => Math.max(max, batch.paintedAt ?? batch.at), 0) || null;
};

export const analyzeSwitch = (events, { pluginByHash, resolve = () => null, endMs = null }) => {
  const windows = labWindows(events);
  const switchWindow = windows.find((window) => window.name === "lab:switch");
  const doneWindow = windows.find((window) => window.name === "lab:done");
  if (!switchWindow || !doneWindow) return { error: "missing lab windows: " + windows.map((window) => window.name).join(",") };
  const main = rendererMain(events, switchWindow);
  if (main === null) return { error: "no renderer main thread" };
  const start = switchWindow.start;
  const end = endMs === null ? doneWindow.end : start + endMs * 1000;
  const readyEnd = switchWindow.end;
  const toMs = (ts) => Math.round((ts - start) / 10) / 100;
  const mainEvents = events.filter((event) => event.pid === main.pid && event.tid === main.tid);
  const nodes = nestEvents(mainEvents);

  const profile = cpuProfiles(events).find((candidate) => candidate.pid === main.pid && (candidate.tid === main.tid || candidate.threadName === "CrRendererMain"));
  const frameCache = new Map();
  const frameInfo = (node) => {
    if (frameCache.has(node.id)) return frameCache.get(node.id);
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    let module = null;
    let location = null;
    if (frame.url) {
      const mapped = resolve(frame.url, frame.lineNumber ?? 0, frame.columnNumber ?? 0);
      module = mapped ? mapped.source : chunkLabel(frame.url);
      location = mapped ? mapped.source + ":" + (mapped.line + 1) : chunkLabel(frame.url) + ":" + ((frame.lineNumber ?? 0) + 1);
    }
    const info = { name, url: frame.url, module, location, native: NATIVE.has(name) };
    frameCache.set(node.id, info);
    return info;
  };
  const ownership = new Map();
  const sampleOwner = (nodeId) => {
    if (ownership.has(nodeId)) return ownership.get(nodeId);
    const nodes = profile.nodes;
    let current = nodes.get(nodeId);
    const leaf = current ? frameInfo(current) : null;
    let leafOwner = null;
    let leafModule = null;
    let leafFunction = null;
    let stackPlugin = null;
    let namedWithoutUrl = false;
    while (current) {
      const info = frameInfo(current);
      if (!info.url && !info.native) namedWithoutUrl = true;
      const owner = ownerOfUrl(info.url, pluginByHash);
      if (owner !== null && leafOwner === null) {
        leafOwner = owner;
        leafModule = info.module;
        leafFunction = info.name + " " + info.location;
      }
      if (owner !== null && owner !== "host" && stackPlugin === null) stackPlugin = owner;
      current = current.parent === undefined ? null : nodes.get(current.parent);
    }
    const fallback = namedWithoutUrl ? HARNESS : "host";
    const result = {
      native: leaf?.native ? leaf.name : null,
      leafOwner: leafOwner ?? fallback,
      leafModule: leafModule ?? "(native)",
      leafFunction: leafFunction ?? (leaf ? leaf.name : "(unknown)"),
      stackOwner: stackPlugin ?? leafOwner ?? fallback,
    };
    ownership.set(nodeId, result);
    return result;
  };

  const browserIntervals = [];
  const browser = new Map();
  const browserBeforeReady = new Map();
  const forced = [];
  const styleRecalcs = [];
  const layouts = [];
  for (const node of nodes) {
    const category = browserCategory(node.name);
    if (category === null) continue;
    const selfUs = Math.max(0, node.end - node.start - node.childUs);
    const clipped = clip(node.start, node.end, start, end);
    if (clipped <= 0) continue;
    const share = clipped / Math.max(1, node.end - node.start);
    add(browser, category, selfUs * share);
    add(browserBeforeReady, category, Math.max(0, Math.min(node.end, readyEnd) - Math.max(node.start, start)) > 0 ? selfUs * (clip(node.start, node.end, start, readyEnd) / Math.max(1, node.end - node.start)) : 0);
    if (node.parent === null || browserCategory(node.parent.name) === null) browserIntervals.push([node.start, node.end, category]);
    const isForced = (category === "style" || category === "layout") && inJs(node);
    const entry = {
      at: toMs(node.start),
      ms: ms(node.end - node.start),
      elements: node.args?.elementCount ?? node.args?.beginData?.dirtyObjects ?? null,
      total: node.args?.beginData?.totalObjects ?? null,
      forced: isForced,
      stack: (node.args?.beginData?.stackTrace ?? node.args?.data?.stackTrace ?? []).slice(0, 3).map((frame) => {
        const mapped = frame.url ? resolve(frame.url, Math.max(0, (frame.lineNumber ?? 1) - 1), Math.max(0, (frame.columnNumber ?? 1) - 1)) : null;
        return { fn: frame.functionName, url: chunkLabel(frame.url), owner: ownerOfUrl(frame.url, pluginByHash), source: mapped ? mapped.source + ":" + (mapped.line + 1) : null };
      }),
      owner: null,
    };
    if (node.name === "UpdateLayoutTree") styleRecalcs.push(entry);
    if (node.name === "Layout") layouts.push(entry);
    if (isForced) forced.push(entry);
  }
  browserIntervals.sort((a, b) => a[0] - b[0]);
  const inBrowserWork = (ts) => {
    let low = 0;
    let high = browserIntervals.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [intervalStart, intervalEnd] = browserIntervals[middle];
      if (ts < intervalStart) high = middle - 1;
      else if (ts >= intervalEnd) low = middle + 1;
      else return true;
    }
    return false;
  };

  const jsLeaf = new Map();
  const jsStack = new Map();
  const jsModules = new Map();
  const jsFunctions = new Map();
  const jsBeforeReady = new Map();
  const native = new Map();
  let sampledUs = 0;
  const timeline = [];
  if (profile) {
    for (const sample of profile.samples) {
      const overlap = clip(sample.ts, sample.ts + sample.weight, start, end);
      if (overlap <= 0) continue;
      const owner = sampleOwner(sample.nodeId);
      if (owner.native === "(idle)" || owner.native === "(root)") continue;
      if (inBrowserWork(sample.ts)) continue;
      if (owner.native === "(program)" || owner.native === "(garbage collector)") {
        add(native, owner.native, overlap);
        continue;
      }
      sampledUs += overlap;
      add(jsLeaf, owner.leafOwner, overlap);
      add(jsStack, owner.stackOwner, overlap);
      add(jsModules, owner.stackOwner + "\u0000" + owner.leafModule, overlap);
      add(jsFunctions, owner.stackOwner + "\u0000" + owner.leafFunction, overlap);
      if (sample.ts < readyEnd) add(jsBeforeReady, owner.stackOwner, clip(sample.ts, sample.ts + sample.weight, start, readyEnd));
      timeline.push([sample.ts, owner.stackOwner, overlap]);
    }
  }
  for (const entry of forced) {
    const plugin = entry.stack.find((frame) => frame.owner !== null && frame.owner !== "host");
    if (plugin) {
      entry.owner = plugin.owner;
      continue;
    }
    if (entry.stack.length > 0 && entry.stack[0].owner) {
      entry.owner = entry.stack[0].owner;
      continue;
    }
    if (entry.stack.length > 0) {
      entry.owner = HARNESS;
      continue;
    }
    const startTs = start + entry.at * 1000;
    let best = null;
    for (const [ts, owner] of timeline) {
      if (ts > startTs) break;
      best = owner;
    }
    entry.owner = best;
  }

  const tasks = nodes.filter((node) => node.depth === 0 && clip(node.start, node.end, start, end) > 0);
  const busyUs = tasks.reduce((sum, node) => sum + clip(node.start, node.end, start, end), 0);
  const longTasks = tasks.filter((node) => node.end - node.start >= 50_000).map((node) => ({ at: toMs(node.start), ms: ms(node.end - node.start) }));

  const ownerDuring = (nodeStart, nodeEnd) => {
    const totals = new Map();
    for (const [ts, owner, weight] of timeline) {
      if (ts < nodeStart) continue;
      if (ts >= nodeEnd) break;
      add(totals, owner, weight);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  timeline.sort((a, b) => a[0] - b[0]);
  const waterfallNodes = nodes
    .filter((node) => node.depth <= 4 && node.end - node.start >= 300 && clip(node.start, node.end, start, end) > 0)
    .map((node) => {
      const category = browserCategory(node.name);
      let name = node.name;
      if (category === "style") name = "style recalc" + (node.args?.elementCount ? " (" + node.args.elementCount + " el)" : "");
      else if (node.name === "Layout") name = "layout" + (node.args?.beginData?.dirtyObjects ? " (" + node.args.beginData.dirtyObjects + "/" + node.args.beginData.totalObjects + " obj)" : "");
      else if (category !== null) name = category + ": " + node.name;
      else if (JS_EVENTS.test(node.name) || node.name === "RunTask") {
        const owner = ownerDuring(node.start, node.end);
        name = (node.name === "RunTask" ? "task" : "js " + node.name) + (owner ? " [" + owner + "]" : "");
      }
      return { name, start: toMs(node.start), duration: ms(node.end - node.start), depth: node.depth + 1 };
    });

  const requests = new Map();
  for (const event of events) {
    const data = event.args?.data;
    if (!data?.requestId) continue;
    if (event.name === "ResourceSendRequest") requests.set(data.requestId, { url: data.url, start: event.ts, end: null, status: null, priority: data.priority ?? null });
    else if (event.name === "ResourceReceiveResponse" && requests.has(data.requestId)) requests.get(data.requestId).status = data.statusCode ?? null;
    else if (event.name === "ResourceFinish" && requests.has(data.requestId)) requests.get(data.requestId).end = typeof data.finishTime === "number" && data.finishTime > 0 ? data.finishTime * 1e6 : event.ts;
  }
  const network = [...requests.values()]
    .filter((request) => request.start >= start - 50_000 && request.start <= end)
    .map((request) => {
      const url = new URL(request.url);
      return {
        path: url.pathname + (url.search.length > 80 ? url.search.slice(0, 80) + "…" : url.search),
        start: toMs(request.start),
        end: request.end === null ? null : toMs(request.end),
        status: request.status,
      };
    })
    .sort((a, b) => a.start - b.start);

  return {
    windowMs: ms(end - start),
    readyMs: ms(readyEnd - start),
    busyMs: ms(busyUs),
    idleMs: ms(end - start - busyUs),
    sampledJsMs: ms(sampledUs),
    jsByLeafOwner: toObject(jsLeaf),
    jsByStackOwner: toObject(jsStack),
    jsBeforeReadyByOwner: toObject(jsBeforeReady),
    jsModules: toObject(jsModules),
    jsFunctions: Object.fromEntries(Object.entries(toObject(jsFunctions)).slice(0, 60)),
    native: toObject(native),
    browser: toObject(browser),
    browserBeforeReady: toObject(browserBeforeReady),
    styleRecalcs: styleRecalcs.filter((entry) => entry.ms >= 0.5),
    layouts: layouts.filter((entry) => entry.ms >= 0.5),
    forced: forced.filter((entry) => entry.ms >= 0.2),
    longTasks,
    network,
    waterfall: waterfallNodes,
  };
};
