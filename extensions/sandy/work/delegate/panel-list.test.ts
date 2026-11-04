import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "../server.ts";
import { admit, bindChild } from "./server/ledger.ts";
import { DEFAULT_SETTINGS } from "./server/settings.ts";

const NOW = Date.now();

async function load() {
  const host = createFakePluginHost({ pluginId: "work", agentSkillIds: ["workflows-plus", "track", "delegate"] });
  await plugin(host.sandy);
  const db = host.sandy.storage.database();
  const children = ["thr_child_a", "thr_child_b"];
  children.forEach((child, index) => {
    const admitted = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: `h${index}` }, DEFAULT_SETTINGS, NOW - 60_000);
    if (!admitted.ok) throw new Error("admit failed");
    if (!bindChild(db, admitted.delegation.delegationId, child, NOW - 50_000).ok) throw new Error("bind failed");
  });
  const { harness } = host;
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
    id: threadId, status: "active", archivedAt: null, visibility: "hidden", environmentId: null, parentThreadId: "thr_parent", originPluginId: "work", createdAt: NOW - 50_000,
  }));
  harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "m", reasoningLevel: "high" }));
  harness.sdk.stub("threads.events.list", async () => []);
  return { host, harness };
}

const listDelegates = (harness: Awaited<ReturnType<typeof load>>["harness"], threadId = "thr_parent") => harness.callRpc("listDelegates", { threadId });
const sdkCalls = (harness: Awaited<ReturnType<typeof load>>["harness"]) => harness.sdk.calls.length;

describe("listDelegates server side", () => {
  const open: Array<{ dispose(): Promise<void> }> = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!.dispose();
  });

  it("serves concurrent reads of one thread from a single SANDY read", async () => {
    const { harness } = await load();
    open.push(harness);
    const results = await Promise.all(Array.from({ length: 6 }, () => listDelegates(harness)));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(harness.sdk.callsTo("threads.defaultExecutionOptions")).toHaveLength(2);
  });

  it("serves a read right after another from the short-lived result, and reads again after the ttl", async () => {
    const { harness } = await load();
    open.push(harness);
    await listDelegates(harness);
    const afterFirst = sdkCalls(harness);
    await listDelegates(harness);
    expect(sdkCalls(harness)).toBe(afterFirst);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await listDelegates(harness);
    expect(sdkCalls(harness)).toBeGreaterThan(afterFirst);
  });

  it("keeps the result per viewed thread", async () => {
    const { harness } = await load();
    open.push(harness);
    await listDelegates(harness);
    const afterParent = sdkCalls(harness);
    const child = (await listDelegates(harness, "thr_child_a")) as { viewedIsChild: boolean; rows: unknown[] };
    expect(child.viewedIsChild).toBe(true);
    expect(sdkCalls(harness)).toBeGreaterThan(afterParent);
  });

  it("reads again once a delegate child's thread changes state, and tells the client's read to refresh", async () => {
    const { harness } = await load();
    open.push(harness);
    await listDelegates(harness);
    const before = sdkCalls(harness);
    const invalidations = harness.experimental_rpcInvalidations.length;
    await harness.emitThreadEvent("thread.idle", { thread: { id: "thr_child_a" }, lastAssistantText: null } as never);
    expect(harness.experimental_rpcInvalidations.length).toBeGreaterThan(invalidations);
    expect(harness.experimental_rpcInvalidations.at(-1)).toEqual(expect.arrayContaining(["delegates:thr_parent", "delegates:thr_child_a"]));
    await listDelegates(harness);
    expect(sdkCalls(harness)).toBeGreaterThan(before);
  });

  it("starts a new read when a change arrives while one is in flight, and keeps one read per generation", async () => {
    const { harness } = await load();
    open.push(harness);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.sdk.stub("threads.defaultExecutionOptions", async () => {
      await gate;
      return { model: "m", reasoningLevel: "high" };
    });
    const first = listDelegates(harness);
    await vi.waitFor(() => expect(harness.sdk.callsTo("threads.defaultExecutionOptions").length).toBeGreaterThan(0));
    await harness.emitThreadEvent("thread.idle", { thread: { id: "thr_child_a" }, lastAssistantText: null } as never);
    const second = listDelegates(harness);
    const third = listDelegates(harness);
    release();
    await Promise.all([first, second, third]);
    expect(harness.sdk.callsTo("threads.defaultExecutionOptions")).toHaveLength(4);
  });

  it("does not cache a failed read", async () => {
    const { harness } = await load();
    open.push(harness);
    harness.sdk.stub("threads.get", async () => {
      throw new Error("boom");
    });
    const first = (await listDelegates(harness)) as { rows: { sandyError?: string }[] };
    expect(first.rows[0].sandyError).toBe("boom");
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
      id: threadId, status: "active", archivedAt: null, visibility: "visible", environmentId: null, parentThreadId: "thr_parent", originPluginId: "work", createdAt: NOW,
    }));
    await harness.emitThreadEvent("thread.idle", { thread: { id: "thr_child_a" }, lastAssistantText: null } as never);
    const second = (await listDelegates(harness)) as { rows: { sandyError?: string }[] };
    expect(second.rows.every((row) => row.sandyError === undefined)).toBe(true);
  });
});
