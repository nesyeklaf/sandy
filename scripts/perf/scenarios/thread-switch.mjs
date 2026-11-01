import { contractChecks, headlineFromCapture } from "../lib/contract.mjs";
import {
  SELECTORS,
  openThread,
  settle,
  threadLinkSelector,
  threadReadyExpression,
} from "../lib/ui.mjs";
import { summarize } from "../lib/metrics.mjs";

const SWITCHES = 8;

export default {
  name: "thread-switch",
  description:
    "Click sidebar threads (heavy and light, first visit and revisit): click until the thread timeline and composer are usable.",
  async run(context) {
    const { ledger } = context;
    const known = await context.api.sidebarThreads();
    const browser = await context.launchBrowser();
    await openThread(
      browser,
      context.baseUrl,
      known.find((thread) => !thread.archived && thread.status === "idle"),
    );
    await browser.waitForExpression(
      "document.querySelectorAll(" +
        JSON.stringify(SELECTORS.sidebarThread) +
        ").length > 20",
      { description: "sidebar list" },
    );
    await settle(browser);
    const listed = await browser.evaluate(
      "[...document.querySelectorAll(" +
        JSON.stringify(SELECTORS.sidebarThread) +
        ")].map((el) => el.getAttribute('data-sidebar-thread-id'))",
    );
    const candidates = known.filter(
      (thread) =>
        listed.includes(thread.id) &&
        !thread.archived &&
        thread.status === "idle",
    );
    ledger.record(
      "fixture: enough rendered idle sidebar threads to switch between",
      candidates.length >= SWITCHES + 2,
      { rendered: listed.length, candidates: candidates.length },
    );
    const weighed = [];
    for (const thread of candidates)
      weighed.push(await context.api.weigh(thread));
    weighed.sort((a, b) => b.eventCount - a.eventCount);
    const heavy = weighed.slice(0, SWITCHES / 2);
    const light = weighed.slice(-SWITCHES / 2).reverse();
    const order = heavy
      .flatMap((thread, index) => [thread, light[index]])
      .filter(Boolean);
    const sequence = [
      ...order.map((thread) => ({ thread, visit: "first" })),
      ...order
        .slice(0, -1)
        .reverse()
        .map((thread) => ({ thread, visit: "revisit" })),
    ];
    const waits = [];
    const capture = await browser.capture({
      label: "thread-switch",
      ledger,
      urlPrefix: context.baseUrl,
      action: async () => {
        for (const { thread, visit } of sequence) {
          const link = threadLinkSelector(thread);
          await browser.reveal(link);
          await browser.evaluate(
            "window.__sandyperf.arm(" +
              JSON.stringify(threadReadyExpression(thread)) +
              ", 20000)",
          );
          await browser.click(link);
          const result = await browser.evaluate(
            "window.__sandyperf.collectArmed()",
          );
          ledger.record(
            "thread-switch: " + thread.id + " (" + visit + ") became usable",
            Boolean(result) &&
              !result.timedOut &&
              !result.staleAtArm &&
              result.sawInput &&
              result.waitMs !== null,
            result,
          );
          waits.push({
            id: thread.id,
            visit,
            eventCount: thread.eventCount,
            rowCount: thread.rowCount,
            ...result,
          });
          await settle(browser, { quietMs: 300, timeoutMs: 5000 });
        }
      },
    });
    const valid = (filter) =>
      waits
        .filter((wait) => wait.waitMs !== null && filter(wait))
        .map((wait) => wait.waitMs);
    const heavyIds = new Set(heavy.map((thread) => thread.id));
    const all = summarize(valid(() => true));
    return {
      headline: {
        perceivedWaitP50Ms: all.p50,
        perceivedWaitP95Ms: all.p95,
        perceivedWaitMaxMs: all.max,
        firstVisitP50Ms: summarize(valid((wait) => wait.visit === "first")).p50,
        revisitP50Ms: summarize(valid((wait) => wait.visit === "revisit")).p50,
        heavyThreadsP50Ms: summarize(valid((wait) => heavyIds.has(wait.id)))
          .p50,
        ...headlineFromCapture(capture),
      },
      data: { waits, capture, contract: contractChecks(capture) },
    };
  },
};
