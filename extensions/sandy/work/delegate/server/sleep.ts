// Resolves after ms, or as soon as the signal aborts.
export const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
