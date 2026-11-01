import { contractChecks, headlineFromCapture } from "../lib/contract.mjs";
import { SELECTORS, openThread, settle } from "../lib/ui.mjs";
import { wait } from "../lib/cdp.mjs";

const COMPACT = { width: 390, height: 844 };

const labelSelector = (prefix) =>
  "button[aria-label^=" + JSON.stringify(prefix) + "]";
const rightPanelOpen =
  "(() => { const chrome = document.querySelector('[data-testid=thread-secondary-panel-top-chrome]'); return Boolean(chrome) && chrome.getBoundingClientRect().left < innerWidth - 20 })()";
const diffShown =
  "Boolean(document.querySelector('[data-testid=git-diff-toolbar-layout]'))";
const infoShown = "(" + rightPanelOpen + ") && !(" + diffShown + ")";
const drawerOpen =
  "document.querySelector('[data-testid=app-sidebar-body]')?.closest('[role=dialog]')?.getAttribute('data-state') === 'open' && document.querySelectorAll('[data-sidebar-thread-id]').length > 5";
const sidebarOpen =
  "(() => { const body = document.querySelector('[data-testid=app-sidebar-body]'); return Boolean(body) && getComputedStyle(body).visibility === 'visible' && body.getBoundingClientRect().right > 150 })()";

const interact = async (
  browser,
  ledger,
  waits,
  name,
  selector,
  readyExpression,
) => {
  await browser.reveal(selector);
  await browser.evaluate(
    "window.__sandyperf.arm(" + JSON.stringify(readyExpression) + ", 8000)",
  );
  await browser.click(selector);
  const result = await browser.evaluate("window.__sandyperf.collectArmed()");
  ledger.record(
    "drawers-panels: " + name + " became usable",
    Boolean(result) &&
      !result.timedOut &&
      !result.staleAtArm &&
      result.waitMs !== null,
    result,
  );
  waits.push({ name, waitMs: result?.waitMs ?? null });
  await settle(browser, { quietMs: 250, timeoutMs: 4000 });
};

export default {
  name: "drawers-panels",
  description:
    "Right panel open/close, panel tabs, sidebar collapse at desktop size, and the sidebar drawer at a phone viewport.",
  async run(context) {
    const { ledger } = context;
    const [heavy] = await context.api.rankSidebarThreads(40);
    const browser = await context.launchBrowser();
    await openThread(browser, context.baseUrl, heavy);
    await settle(browser);
    const waits = [];
    const desktop = await browser.capture({
      label: "drawers-panels desktop",
      ledger,
      urlPrefix: context.baseUrl,
      action: async () => {
        await interact(
          browser,
          ledger,
          waits,
          "open right panel",
          labelSelector("Show right panel"),
          rightPanelOpen,
        );
        await interact(
          browser,
          ledger,
          waits,
          "open diff panel",
          labelSelector("Show diff panel"),
          diffShown,
        );
        await interact(
          browser,
          ledger,
          waits,
          "open thread info panel",
          labelSelector("Show thread info panel"),
          infoShown,
        );
        await interact(
          browser,
          ledger,
          waits,
          "close right panel",
          labelSelector("Hide right panel"),
          "!(" + rightPanelOpen + ")",
        );
        await interact(
          browser,
          ledger,
          waits,
          "collapse sidebar",
          labelSelector("Toggle sidebar"),
          "!(" + sidebarOpen + ")",
        );
        await interact(
          browser,
          ledger,
          waits,
          "expand sidebar",
          labelSelector("Toggle sidebar"),
          sidebarOpen,
        );
      },
    });
    await browser.setViewport(COMPACT);
    await wait(800);
    await settle(browser);
    const compactState = await browser.evaluate(
      "({ width: innerWidth, sidebarWidth: document.querySelector(" +
        JSON.stringify(SELECTORS.sidebarBody) +
        ")?.getBoundingClientRect().width ?? 0, toggle: Boolean(document.querySelector(" +
        JSON.stringify(labelSelector("Toggle sidebar")) +
        ")) })",
    );
    ledger.record(
      "drawers-panels: the phone viewport is applied",
      compactState.width <= 500,
      compactState,
    );
    const compact = await browser.capture({
      label: "drawers-panels compact",
      ledger,
      urlPrefix: context.baseUrl,
      action: async () => {
        await interact(
          browser,
          ledger,
          waits,
          "compact sidebar drawer open",
          labelSelector("Toggle sidebar"),
          drawerOpen,
        );
        await interact(
          browser,
          ledger,
          waits,
          "compact sidebar drawer close",
          labelSelector("Toggle sidebar"),
          "!(" + drawerOpen + ")",
        );
        await wait(400);
      },
    });
    const numbers = waits
      .map((entry) => entry.waitMs)
      .filter((value) => typeof value === "number")
      .sort((a, b) => a - b);
    return {
      headline: {
        perceivedWaitMaxMs: numbers.at(-1) ?? null,
        perceivedWaitMedianMs: numbers[Math.floor(numbers.length / 2)] ?? null,
        ...headlineFromCapture(desktop, "desktop."),
        ...headlineFromCapture(compact, "compact."),
      },
      data: {
        thread: heavy,
        waits,
        compactState,
        desktop,
        compact,
        desktopContract: contractChecks(desktop),
        compactContract: contractChecks(compact),
      },
    };
  },
};
