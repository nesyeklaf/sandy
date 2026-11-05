// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import { rpcContract, delegatesTag } from "./contract.ts";
import { useDelegates } from "./use-delegates.ts";
import type { PanelList, PanelRow } from "./panel-types.ts";

const row = (status: string): PanelRow =>
  ({
    delegationId: "d1", threadId: "thr_child", parentThreadId: "thr_parent", agent: "scout", agentVersion: 1, role: "reader", title: null, state: "active",
    status, model: null, reasoningLevel: null, tokens: { total: null, context: null, contextWindow: null },
    runtime: { sinceBoundMs: 0, lastTurnMs: null, lastTurnRunning: false }, stale: false, error: null, question: null, hidden: null, acknowledged: false, createdAt: 0,
  }) as PanelRow;

const list = (status: string): PanelList => ({ rootThreadId: "thr_parent", viewedIsChild: false, rows: [row(status)], truncated: false });

function Consumers({ count, threadId }: { count: number; threadId: string }) {
  const consumers = Array.from({ length: count }, () => useDelegates(threadId));
  return <div>{consumers[0].data?.rows.length ?? 0}</div>;
}

let sequence = 0;

async function mount(status: string, consumers = 4) {
  const calls: unknown[] = [];
  const threadId = `thr_parent_${++sequence}`;
  const slot = renderSlot({ component: Consumers }, { count: consumers, threadId }, {
    rpc: { listDelegates: (input: unknown) => { calls.push(input); return list(status); } } as never,
    experimental_rpcContract: rpcContract,
  });
  await vi.waitFor(() => expect(slot.container.textContent).toBe("1"));
  expect(calls.length).toBe(1);
  return { slot, calls, threadId };
}

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useDelegates polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    setVisibility("visible");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("polls once per interval however many consumers show the same thread", async () => {
    const { calls } = await mount("running", 4);
    await advance(9_000);
    await vi.waitFor(() => expect(calls.length).toBe(4));
    await advance(100);
    expect(calls.length).toBe(4);
  });

  it("backs off while no delegate runs", async () => {
    const { calls } = await mount("completed", 2);
    await advance(20_000);
    expect(calls.length).toBe(1);
    await advance(10_000);
    await vi.waitFor(() => expect(calls.length).toBe(2));
  });

  it("does not poll while the document is hidden and reads again when it shows", async () => {
    const { calls } = await mount("running", 2);
    setVisibility("hidden");
    await advance(15_000);
    expect(calls.length).toBe(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(calls.length).toBe(2));
  });

  it("stops polling when the last consumer unmounts", async () => {
    const { slot, calls } = await mount("running", 2);
    slot.unmount();
    await advance(30_000);
    expect(calls.length).toBe(1);
  });

  it("reads again when the server invalidates the thread's delegates", async () => {
    const { slot, calls, threadId } = await mount("completed", 2);
    await slot.experimental_invalidateRpc([delegatesTag(threadId)]);
    await vi.waitFor(() => expect(calls.length).toBe(2));
  });
});
