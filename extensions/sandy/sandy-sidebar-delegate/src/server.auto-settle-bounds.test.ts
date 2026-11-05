import { describe, expect, it } from "vitest";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  pullRequestStatus,
  type ProjectThread,
} from "./test-server";

const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old, status: "idle" as const };
type ListArgs = Parameters<SandyPluginApi["sdk"]["threads"]["list"]>[0];

function trackConcurrency() {
  let inFlight = 0;
  let max = 0;
  return {
    max: () => max,
    async around<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      max = Math.max(max, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
  };
}

describe("automatic settle evaluation bounds", () => {
  it("reads several thread pages at once and still sees every thread", async () => {
    const threads: ProjectThread[] = Array.from({ length: 950 }, (_, index) =>
      projectThread({ id: `thr_${index}`, ...(index === 940 ? quiet : { latestAttentionAt: Date.now() }) }),
    );
    const pages = trackConcurrency();
    const { sandy, harness } = createFakePluginHost({
      pluginId: "sandy-sidebar",
      sdk: {
        projects: { list: async () => projectsWith(threads) },
        threads: {
          list: (args: ListArgs) =>
            pages.around(async () => {
              const matching = args?.threadIds ? threads.filter((t) => args.threadIds!.includes(t.id)) : threads;
              const offset = args?.offset ?? 0;
              return matching.slice(offset, offset + (args?.limit ?? 100));
            }),
        },
      },
    });
    await plugin(sandy);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_940"],
    });
    expect(pages.max()).toBeGreaterThan(1);
  });

  it("looks up pull request batches in parallel", async () => {
    const threads = Array.from({ length: 450 }, (_, index) =>
      projectThread({ id: `thr_${index}`, environmentId: `env_${index}`, ...quiet }),
    );
    const lookups = trackConcurrency();
    const batches: string[][] = [];
    const callRpc = pullRequestStatus(() => ({ outcome: "absent" }), batches);
    const { sandy, harness } = createFakePluginHost({
      pluginId: "sandy-sidebar",
      sdk: {
        projects: { list: async () => projectsWith(threads) },
        plugins: { callRpc: ((args) => lookups.around(() => callRpc(args))) as typeof callRpc },
      },
    });
    await plugin(sandy);
    disposers.push(() => harness.lifecycle.dispose());

    const { changedThreadIds } = (await harness.behavior.callRpc("evaluateAutoSettle", {})) as {
      changedThreadIds: string[];
    };
    expect(changedThreadIds).toHaveLength(450);
    expect(batches.map((keys) => keys.length)).toEqual([200, 200, 50]);
    expect(lookups.max()).toBe(3);
  });
});
