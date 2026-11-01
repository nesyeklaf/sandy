import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { createThreadPullRequests } from "./thread-pull-requests";

type Sdk = SandyPluginApi["sdk"];

function created(seq: number, number: number) {
  return {
    seq,
    type: "item/completed",
    data: {
      item: {
        type: "commandExecution",
        command: "gh pr create --fill",
        aggregatedOutput: `https://github.com/o/r/pull/${number}`,
      },
    },
  };
}

it("scans new events only and caches merged PR status", async () => {
  let events = [created(1, 10), created(2, 11)];
  // Pages like sandy's API: at most `limit` events, which it caps at 100.
  const list = vi.fn(async ({ afterSeq, limit }: { afterSeq?: string; limit: string }) => {
    if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
    return events.filter((event) => event.seq > Number(afterSeq ?? 0)).slice(0, Number(limit));
  });
  const call = vi.fn(async ({ input }: { input: unknown }) => ({
    pullRequests: (input as { urls: string[] }).urls.map((url) => ({
      url,
      number: Number(url.split("/").at(-1)),
      title: `PR ${url.split("/").at(-1)}`,
      state: url.endsWith("/10") ? "merged" : "open",
    })),
  }));
  const { sandy, harness } = createFakePluginHost({
    experimental_callHostRpc: call,
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_a", environmentId: "env_a" }),
        events: { list } as unknown as Sdk["threads"]["events"],
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as Awaited<ReturnType<Sdk["environments"]["get"]>>,
      },
    },
  });
  try {
    const pullRequests = createThreadPullRequests(sandy);
    await expect(pullRequests.getThreadPullRequests({ threadId: "thr_a" })).resolves.toEqual({
      pullRequests: [
        { url: "https://github.com/o/r/pull/11", number: 11, title: "PR 11", state: "open" },
        { url: "https://github.com/o/r/pull/10", number: 10, title: "PR 10", state: "merged" },
      ],
    });
    events = [...events, created(3, 12)];
    const second = await pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    expect(second.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([12, 11, 10]);
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ afterSeq: "2", types: ["item/completed"] });
    // #11 is still fresh and #10 is merged, so only the new PR is looked up.
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({
      hostId: "host_a",
      method: "pullRequests",
      input: { urls: ["https://github.com/o/r/pull/12"] },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("lists PR numbers without status when the host lookup fails", async () => {
  const { sandy, harness } = createFakePluginHost({
    experimental_callHostRpc: async () => {
      throw new Error("gh: not found");
    },
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_a", environmentId: "env_a" }),
        events: { list: async () => [created(1, 5)] } as unknown as Sdk["threads"]["events"],
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as Awaited<ReturnType<Sdk["environments"]["get"]>>,
      },
    },
  });
  try {
    await expect(createThreadPullRequests(sandy).getThreadPullRequests({ threadId: "thr_a" })).resolves.toEqual({
      pullRequests: [{ url: "https://github.com/o/r/pull/5", number: 5, title: null, state: null }],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
