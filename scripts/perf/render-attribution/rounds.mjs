import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { threadInfo, timedAction } from "../lib/ab-run.mjs";
import { PerfBrowser, sampleHostBusyShare } from "../lib/browser.mjs";
import { wait } from "../lib/cdp.mjs";
import { startTrace, stopTrace } from "../lib/trace.mjs";
import { threadReadyExpression } from "../lib/ui.mjs";
import { EXTRA_TRACE_CATEGORIES, pluginAssetHash } from "./analyze-switch.mjs";
import { analyzeEvents } from "./analyze-traces.mjs";
import { startProxy, stopProxy, STAGING_ORIGIN, VARIANTS } from "./proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = readFileSync(join(here, "switch-probe.js"), "utf8") + "\n//# sourceURL=ra-switch-probe.js\n";

export const THREADS = [
  { id: "thr_9xa8txsan6", key: "9xa", cards: 5 },
  { id: "thr_yksmpwcs9d", key: "yks", cards: 0 },
  { id: "thr_s9b37caehp", key: "s9b", cards: 4 },
];
export const START_THREAD = "thr_yge7c483t3";

const { values } = parseArgs({
  options: {
    lab: { type: "string" },
    labs: { type: "string" },
    out: { type: "string" },
    rounds: { type: "string", default: "8" },
    variants: { type: "string", default: "prod,genui-off,profiling,prod~bare,genui-off~bare" },
    chrome: { type: "string", default: "/usr/bin/chromium" },
    viewport: { type: "string", default: "2396,1318" },
    "keep-traces": { type: "boolean", default: true },
  },
});
if ((!values.lab && !values.labs) || !values.out)
  throw new Error("usage: rounds.mjs (--lab <dir> | --labs name=dir,...) --out <dir> [--rounds 8] [--variants prod,genui-off,profiling]");
const labs = values.labs
  ? values.labs.split(",").map((entry) => {
      const [name, dir] = entry.split("=");
      return { name, dir };
    })
  : [{ name: null, dir: values.lab }];
const labDirOf = Object.fromEntries(labs.map((lab) => [lab.name ?? "", lab.dir]));
const rounds = Number(values.rounds);
const variants = values.variants.split(",");
const [width, height] = values.viewport.split(",").map(Number);
mkdirSync(join(values.out, "traces"), { recursive: true });

const labThreadUrl = (base, thread) =>
  thread.projectId === "proj_personal" ? base + "/threads/" + thread.id : base + "/projects/" + thread.projectId + "/threads/" + thread.id;

const settleExpression = (quietMs, timeoutMs) =>
  "new Promise((resolve) => { const started = performance.now(); let lastBusy = started; let last = started; const observer = new MutationObserver(() => { lastBusy = performance.now() }); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); const tick = (now) => { if (now - last > 50) lastBusy = now; last = now; if (now - lastBusy >= " +
  quietMs +
  ") { observer.disconnect(); resolve(true); return } if (now - started >= " +
  timeoutMs +
  ") { observer.disconnect(); resolve(false); return } requestAnimationFrame(tick) }; requestAnimationFrame(tick) })";

const click = async (browser, selector) => {
  const point = await browser.center(selector);
  const mouse = (type, extra = {}) => browser.client.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
  await mouse("mouseMoved");
  await wait(150);
  await mouse("mousePressed", { button: "left", clickCount: 1 });
  await wait(80);
  await mouse("mouseReleased", { button: "left", clickCount: 1 });
};

const pluginsResponse = await (await fetch(STAGING_ORIGIN + "/api/v1/plugins")).json();
const pluginByHash = { cc871f9f4974a1b2: "sandy-sidebar-delegate" };
for (const plugin of pluginsResponse.plugins) {
  const hash = plugin.app?.bundle?.hash ?? pluginAssetHash(plugin.app?.bundle?.jsUrl);
  if (hash) pluginByHash[hash] = plugin.id;
}
const pluginIds = [...new Set([...pluginsResponse.plugins.map((plugin) => plugin.id), "sandy-sidebar-delegate"])];

const start = await threadInfo(STAGING_ORIGIN, START_THREAD);
const threads = await Promise.all(THREADS.map(async (thread) => ({ ...thread, ...(await threadInfo(STAGING_ORIGIN, thread.id)) })));
const sequence = [...threads.map((thread) => ({ thread, visit: "first" })), ...threads.map((thread) => ({ thread, visit: "revisit" }))];

const served = (variant) => variant.split("~")[0];
const labOf = (variant) => (served(variant).includes(":") ? served(variant).split(":")[0] : "");
const baseOf = (variant) => served(variant).split(":").at(-1);
const isBare = (variant) => variant.endsWith("~bare");
const servers = await startProxy({ labs, auditPath: join(values.out, "proxy-audit.jsonl"), variants: [...new Set(variants.map(baseOf))] });
const urlOf = Object.fromEntries(servers.map((server) => [server.name, server.url]));
const sourceMapCache = new Map();

const runVariantRound = async (variant, round) => {
  const bare = isBare(variant);
  const base = baseOf(variant);
  const browser = await PerfBrowser.launch({ chrome: values.chrome, windowSize: values.viewport });
  const samples = [];
  const validity = [];
  try {
    await browser.setViewport({ width, height });
    await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: (base === "profiling" ? "window.__RA_REACT_HOOK__ = true;\n" : "") + PROBE,
    });
    const { product } = await browser.client.send("Browser.getVersion");
    await browser.navigate(labThreadUrl(urlOf[served(variant)], start));
    await browser.waitForExpression(threadReadyExpression(start), { timeoutMs: 45_000, description: "start thread" });
    await browser.evaluate(settleExpression(600, 15_000));
    await wait(1500);
    const page = await browser.evaluate("({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })");
    const hostBusy = await sampleHostBusyShare(500);
    validity.push({ name: "page visible", passed: page.visibility === "visible", page });
    validity.push({ name: "host CPU quiet", passed: hostBusy < 0.5, hostBusy });
    const cache = sourceMapCache.get(served(variant)) ?? sourceMapCache.set(served(variant), new Map()).get(served(variant));
    for (const [index, { thread, visit }] of sequence.entries()) {
      const selector = "[data-sidebar-thread-id=" + JSON.stringify(thread.id) + "]";
      await browser.reveal(selector);
      await browser.evaluate(settleExpression(300, 8000));
      await browser.evaluate("window.__sandymeasures && (window.__sandymeasures.length = 0), performance.clearResourceTimings(), true");
      const expectedCards = base === "genui-off" ? 0 : thread.cards;
      const trace = bare ? null : await startTrace(browser.client, { extraCategories: EXTRA_TRACE_CATEGORIES });
      await browser.evaluate(
        "window.__ra.arm(" + JSON.stringify({ threadId: thread.id, expectedCards, pluginIds, quietMs: 1000, timeoutMs: 8000 }) + ")",
      );
      const waitMs = await timedAction(browser, "switch", threadReadyExpression(thread), () => click(browser, selector));
      const probe = await browser.evaluate("window.__ra.collect()");
      const doneMs = probe ? Math.max(probe.pluginDoneMs ?? 0, probe.cardsPaintMs ?? 0, probe.collectorMs ?? 0, waitMs ?? 0) : null;
      if (probe && doneMs !== null)
        await browser.evaluate("performance.measure('lab:done', { start: " + probe.t0 + ", end: " + (probe.t0 + doneMs) + " }), true");
      await wait(50);
      let analysis = null;
      let tracePath = null;
      if (!bare) {
        const events = await stopTrace(browser.client, trace);
        tracePath = join(values.out, "traces", variant + "-r" + round + "-" + index + "-" + thread.key + "-" + visit + ".json.gz");
        if (values["keep-traces"]) writeFileSync(tracePath, gzipSync(JSON.stringify(events)));
        try {
          analysis = await analyzeEvents(events, { labDir: labDirOf[labOf(variant)], variant: base, pluginByHash, cache, probe });
        } catch (error) {
          analysis = { error: String(error?.stack ?? error).slice(0, 500) };
        }
      }
      samples.push({ variant, round, index, thread: thread.id, key: thread.key, visit, waitMs, doneMs, probe, analysis, tracePath });
      console.log(
        new Date().toISOString().slice(11, 19),
        variant,
        "r" + round,
        thread.key + "-" + visit,
        "ready", waitMs === null ? "null" : Math.round(waitMs),
        "collector", probe?.collectorMs === undefined || probe?.collectorMs === null ? "null" : Math.round(probe.collectorMs),
        "cards", probe?.cardsPaintMs === null || probe?.cardsPaintMs === undefined ? "-" : Math.round(probe.cardsPaintMs),
        "plugin-done", probe?.pluginDoneMs === null || probe?.pluginDoneMs === undefined ? "-" : Math.round(probe.pluginDoneMs),
        analysis === null ? "untraced" : analysis.error ? "ANALYSIS-ERR " + analysis.error.slice(0, 120) : "js " + analysis.sampledJsMs + " style " + (analysis.browser.style ?? 0) + " layout " + (analysis.browser.layout ?? 0),
      );
    }
    return { variant, round, product, validity, valid: validity.every((check) => check.passed), samples };
  } finally {
    await browser.close();
  }
};

const results = [];
try {
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 1 ? [...variants].reverse() : variants;
    for (const variant of order) {
      try {
        results.push(await runVariantRound(variant, round));
      } catch (error) {
        console.log(variant, round, "ERROR", String(error?.stack ?? error).slice(0, 400));
        results.push({ variant, round, error: String(error).slice(0, 400), samples: [] });
      }
      writeFileSync(join(values.out, "rounds.json"), JSON.stringify({ node: process.version, labs, variants: Object.fromEntries(variants.map((name) => [name, { ...VARIANTS[baseOf(name)], traced: !isBare(name) }])), pluginByHash, results }, null, 1));
    }
  }
} finally {
  await stopProxy(servers);
}
console.log("DONE", results.length);
