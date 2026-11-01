import { contractChecks, headlineFromCapture } from "../lib/contract.mjs";
import { SELECTORS, openThread, settle } from "../lib/ui.mjs";

const PACED_PROVIDER_ID = "paced-stream-agent";
const FIRST_MARKER = "token0 streams";
const LAST_MARKER = "token239 streams";

const occurrences = (marker) =>
  "document.body.innerText.split(" + JSON.stringify(marker) + ").length - 1";

export default {
  name: "streaming",
  description:
    "A long markdown answer streamed in 25 ms chunks by the paced-stream-provider fixture: frame time, long tasks, input latency while typing into the composer mid-stream, time to first token and to the last token on screen.",
  async run(context) {
    const { ledger } = context;
    const threads = (await context.api.sidebarThreads()).filter(
      (thread) =>
        thread.providerId === PACED_PROVIDER_ID &&
        !thread.archived &&
        thread.status === "idle",
    );
    ledger.record(
      "streaming: an idle thread on the paced-stream-agent provider exists (install scripts/perf/fixtures/paced-stream-provider and spawn a thread on it)",
      threads.length > 0,
      { found: threads.length },
    );
    if (threads.length === 0) return { headline: {}, data: { thread: null } };
    const thread = await context.api.weigh(threads[0]);
    const browser = await context.launchBrowser();
    await openThread(browser, context.baseUrl, thread, { composer: true });
    await settle(browser);
    const baseline = {
      first: await browser.evaluate(occurrences(FIRST_MARKER)),
      last: await browser.evaluate(occurrences(LAST_MARKER)),
    };
    const phases = {};
    const capture = await browser.capture({
      label: "streaming",
      ledger,
      urlPrefix: context.baseUrl,
      action: async () => {
        await browser.click(SELECTORS.composer);
        await browser.typeText("stream a long answer please", {
          perCharDelayMs: 0,
        });
        await browser.evaluate(
          "window.__sandyperf.arm(" +
            JSON.stringify(occurrences(FIRST_MARKER) + " > " + baseline.first) +
            ", 20000)",
        );
        await browser.pressKey("Enter", {
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        phases.firstToken = await browser.evaluate(
          "window.__sandyperf.collectArmed()",
        );
        await browser.evaluate(
          "window.__sandyperf.arm(" +
            JSON.stringify(occurrences(LAST_MARKER) + " > " + baseline.last) +
            ", 30000)",
        );
        await browser.click(SELECTORS.composer);
        await browser.typeText("typing while the answer streams in", {
          perCharDelayMs: 40,
        });
        phases.lastToken = await browser.evaluate(
          "window.__sandyperf.collectArmed()",
        );
      },
    });
    ledger.record(
      "streaming: the first streamed token appeared",
      Boolean(phases.firstToken) &&
        !phases.firstToken.timedOut &&
        !phases.firstToken.staleAtArm &&
        phases.firstToken.waitMs !== null,
      phases.firstToken,
    );
    ledger.record(
      "streaming: the last streamed token appeared",
      Boolean(phases.lastToken) &&
        !phases.lastToken.timedOut &&
        !phases.lastToken.staleAtArm &&
        phases.lastToken.waitMs !== null,
      phases.lastToken,
    );
    return {
      headline: {
        firstTokenWaitMs: phases.firstToken?.waitMs ?? null,
        streamCompleteMs: phases.lastToken?.waitMs ?? null,
        ...headlineFromCapture(capture),
      },
      data: { thread, phases, capture, contract: contractChecks(capture) },
    };
  },
};
