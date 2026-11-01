import type { Sample } from "./contract.ts";

export function sample(overrides: Partial<Sample>): Sample {
  return {
    kind: "open",
    label: "More",
    at: 0,
    path: "/",
    threadId: null,
    visit: null,
    overlay: "menu",
    mountMs: 10,
    readyMs: 20,
    settledMs: null,
    timedOut: false,
    eventMs: 24,
    inputDelayMs: 1,
    processingMs: 5,
    presentationMs: 18,
    frameMs: 0,
    blockingMs: 0,
    styleLayoutMs: 0,
    scripts: [],
    domNodes: 100,
    tracedMs: null,
    phases: null,
    scroll: null,
    ...overrides,
  };
}
