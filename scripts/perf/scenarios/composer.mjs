import { contractChecks, headlineFromCapture } from "../lib/contract.mjs";
import { SELECTORS, openThread, settle } from "../lib/ui.mjs";
import { wait } from "../lib/cdp.mjs";

const TYPED =
  "Please review the retry logic in the webhook handler and keep the change small.";
const PASTE_LINES = 400;

const composerText = (browser) =>
  browser.evaluate(
    "document.querySelector(" +
      JSON.stringify(SELECTORS.composer) +
      ").innerText",
  );

export default {
  name: "composer",
  description:
    "Follow-up composer on a heavy thread: keystroke typing, a large paste, and the @ mention popup.",
  async run(context) {
    const { ledger } = context;
    const [heavy] = await context.api.rankSidebarThreads(40);
    const browser = await context.launchBrowser();
    await openThread(browser, context.baseUrl, heavy, { composer: true });
    await settle(browser);
    await browser.click(SELECTORS.composer);
    const focused = await browser.evaluate(
      "document.activeElement?.id === 'thread-detail-follow-up-composer'",
    );
    ledger.record("composer: the composer holds focus", focused, null);
    const paste = Array.from(
      { length: PASTE_LINES },
      (_, index) =>
        "line " +
        index +
        ": const value" +
        index +
        " = compute(" +
        index +
        ") // pasted fixture text to stress the editor",
    ).join("\n");
    const phases = {};
    const capture = await browser.capture({
      label: "composer",
      ledger,
      urlPrefix: context.baseUrl,
      action: async () => {
        const typingStartedAt = performance.now();
        await browser.typeText(TYPED, { perCharDelayMs: 25 });
        phases.typingMs = performance.now() - typingStartedAt;
        await wait(300);
        phases.typedText = await composerText(browser);
        await browser.pressKey("a", {
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await browser.pressKey("Backspace", {
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await wait(200);
        const pasteStartedAt = performance.now();
        await browser.evaluate(
          "window.__sandyperf.arm(" +
            JSON.stringify(
              "document.querySelector('" +
                SELECTORS.composer +
                "').innerText.includes('line " +
                (PASTE_LINES - 1) +
                ":')",
            ) +
            ", 15000)",
        );
        await browser.insertText(paste);
        phases.paste = await browser.evaluate("window.__sandyperf.collectArmed()");
        phases.pasteMs = performance.now() - pasteStartedAt;
        await browser.pressKey("a", {
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await browser.pressKey("Backspace", {
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await wait(300);
        await browser.evaluate(
          "window.__sandyperf.arm(" +
            JSON.stringify(
              "Boolean(document.querySelector('[class*=\"mention-menu\"]'))",
            ) +
            ", 5000)",
        );
        await browser.typeText("@", { perCharDelayMs: 0 });
        phases.mentionWait = await browser.evaluate(
          "window.__sandyperf.collectArmed()",
        );
        phases.mentionPopup = await browser.evaluate(
          "(() => { const popup = document.querySelector('[class*=\"mention-menu\"]'); return popup ? { text: popup.innerText.slice(0, 80) } : null })()",
        );
        await browser.pressKey("Escape", {
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
      },
    });
    ledger.record(
      "composer: typed text reached the editor",
      typeof phases.typedText === "string" &&
        phases.typedText.includes("webhook handler"),
      { text: String(phases.typedText).slice(0, 120) },
    );
    ledger.record(
      "composer: the large paste was rendered in the editor",
      Boolean(phases.paste) &&
        !phases.paste.timedOut &&
        phases.paste.waitMs !== null,
      phases.paste,
    );
    ledger.record(
      "composer: the @ popup appeared",
      Boolean(phases.mentionPopup),
      phases.mentionPopup,
    );
    return {
      headline: {
        pastePerceivedWaitMs: phases.paste?.waitMs ?? null,
        ...headlineFromCapture(capture),
      },
      data: {
        thread: heavy,
        phases,
        capture,
        contract: contractChecks(capture),
      },
    };
  },
};
