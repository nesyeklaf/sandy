import { beforeAll } from "vitest";

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;

// Node tests do not need Testing Library's React/DOM dependency graph.
if (typeof window !== "undefined") {
  beforeAll(async () => {
    const { configure } = await import("@testing-library/react");
    // Loaded runners need headroom; successful queries still resolve immediately.
    configure({ asyncUtilTimeout: 5_000 });
  });
}
