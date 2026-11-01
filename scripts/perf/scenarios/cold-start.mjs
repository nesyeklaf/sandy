import { headlineFromCapture, contractChecks } from "../lib/contract.mjs";
import { threadReadyExpression, SELECTORS } from "../lib/ui.mjs";
import { threadUrl } from "../lib/api.mjs";
import { round } from "../lib/metrics.mjs";

const MIN_SIDEBAR_ROWS = 20;

const coldLoad = async (context, label, url, specs, names) => {
  const { ledger } = context;
  const browser = await context.launchBrowser();
  await browser.navigate("about:blank");
  await browser.setCacheDisabled(false);
  await browser.watchOnLoad(specs);
  const capture = await browser.capture({
    label,
    ledger,
    urlPrefix: context.baseUrl,
    action: async () => {
      browser.resetNetwork();
      await browser.navigate(url);
      await browser.waitForExpression(
        "Object.keys(window.__sandyperf.watches().results).length === " +
          names.length +
          " && " +
          names
            .map(
              (name) =>
                "Boolean(window.__sandyperf.watches().results['" +
                name +
                "'].paintedMs)",
            )
            .join(" && "),
        {
          timeoutMs: 60_000,
          description: label + " readiness watches " + names.join(", "),
        },
      );
      await browser.evaluate(
        "new Promise((resolve) => setTimeout(resolve, 1500))",
      );
    },
  });
  const watches = await browser.readWatches(names, ledger, label);
  const [paints, lcp, navigation] = await Promise.all([
    browser.evaluate("window.__sandyperf.paintTimings()"),
    browser.evaluate("window.__sandyperf.largestContentfulPaint()"),
    browser.evaluate("window.__sandyperf.navigationTiming()"),
  ]);
  const network = browser.networkSummary();
  ledger.record(
    label + ": the app shell was fetched from the server",
    network.finished > 0 && network.failed === 0,
    { finished: network.finished, failed: network.failed },
  );
  const fcp = paints.find((entry) => entry.name === "first-contentful-paint");
  ledger.record(
    label + ": first-contentful-paint was recorded",
    Boolean(fcp),
    paints,
  );
  return {
    capture,
    contract: contractChecks(capture),
    waitsMs: Object.fromEntries(
      names.map((name) => [
        name,
        {
          ready: round(watches[name]?.readyMs),
          painted: round(watches[name]?.paintedMs),
        },
      ]),
    ),
    firstContentfulPaintMs: round(fcp?.start),
    largestContentfulPaint: lcp,
    navigation,
    network,
  };
};

export default {
  name: "cold-start",
  description:
    "Fresh browser profile: time from navigation until the sidebar list and a heavy thread are usable, with the load-time main-thread budget.",
  async run(context) {
    const [heavy] = await context.api.rankSidebarThreads(40);
    context.ledger.record(
      "fixture: a heavy non-archived thread exists",
      Boolean(heavy) && heavy.rowCount > 50,
      heavy,
    );
    const home = await coldLoad(
      context,
      "cold home",
      context.baseUrl + "/",
      {
        sidebarList:
          "document.querySelectorAll(" +
          JSON.stringify(SELECTORS.sidebarThread) +
          ").length >= " +
          MIN_SIDEBAR_ROWS,
      },
      ["sidebarList"],
    );
    const deepLink = await coldLoad(
      context,
      "cold deep link",
      threadUrl(context.baseUrl, heavy),
      {
        sidebarList:
          "document.querySelectorAll(" +
          JSON.stringify(SELECTORS.sidebarThread) +
          ").length >= " +
          MIN_SIDEBAR_ROWS,
        threadUsable: threadReadyExpression(heavy),
      },
      ["sidebarList", "threadUsable"],
    );
    return {
      headline: {
        "home.sidebarUsablePaintedMs": home.waitsMs.sidebarList.painted,
        "home.firstContentfulPaintMs": home.firstContentfulPaintMs,
        "deepLink.threadUsablePaintedMs": deepLink.waitsMs.threadUsable.painted,
        "deepLink.sidebarUsablePaintedMs": deepLink.waitsMs.sidebarList.painted,
        "deepLink.transferredMb": round(
          deepLink.network.transferredBytes / 1048576,
          2,
        ),
        ...headlineFromCapture(deepLink.capture, "deepLink."),
      },
      data: { thread: heavy, home, deepLink },
    };
  },
};
