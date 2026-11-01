import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { loadPlugin, deferred } from "./test-server";

describe("pin/parent policy", () => {
  it.each([null, 0, 1])("rejects child Pin with pinnedAt=%s without changing lifecycle", async (pinnedAt) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "child" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "child", parentThreadId: "missing-parent", pinnedAt }),
    );
    await expect(harness.behavior.callRpc("pin", { threadId: "child" })).rejects.toThrow(
      "Child threads cannot be pinned",
    );
    expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "child" }));
    await expect(harness.behavior.callRpc("pin", { threadId: "child" })).resolves.toEqual({ ok: true });
  });

  it("allows root and fork-root Pin and clears lifecycle after SDK success", async () => {
    const harness = await loadPlugin();
    for (const originKind of [null, "fork"] as const) {
      await harness.behavior.callRpc("park", { threadId: "root" });
      harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "root", originKind, sourceThreadId: originKind ? "source" : null }),
      );
      await expect(harness.behavior.callRpc("pin", { threadId: "root" })).resolves.toEqual({ ok: true });
      expect(await harness.behavior.callRpc("listLifecycle", {})).toMatchObject({
        rows: [{ threadId: "root", parkedAt: null, settledOverride: "active" }],
      });
    }
    expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(2);
  });

  it("accepts Pin for an existing pinned root with pinnedAt=0", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "root", pinnedAt: 0 }));
    await expect(harness.behavior.callRpc("pin", { threadId: "root" })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.pin")).toEqual([[{ threadId: "root" }]]);
  });

  it.each([null, "old"])(
    "updates parent before unpinning a pinned thread with current parent=%s (pin zero)",
    async (currentParent) => {
      const harness = await loadPlugin();
      await harness.behavior.callRpc("park", { threadId: "thread" });
      const before = await harness.behavior.callRpc("listLifecycle", {});
      const calls: string[] = [];
      harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "thread", parentThreadId: currentParent, pinnedAt: 0 }),
      );
      harness.inspection.sdk.stub("threads.update", async () => {
        calls.push("update");
        return makeThreadResponse({ id: "thread", parentThreadId: "next", pinnedAt: 0 });
      });
      harness.inspection.sdk.stub("threads.unpin", async () => {
        calls.push("unpin");
        return makeThreadResponse({ id: "thread", parentThreadId: "next" });
      });
      await expect(
        harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" }),
      ).resolves.toEqual({ ok: true });
      expect(calls).toEqual(["update", "unpin"]);
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    },
  );

  it.each([
    { currentParent: null, pinnedAt: null, nextParent: "parent" },
    { currentParent: null, pinnedAt: 0, nextParent: null },
    { currentParent: "old", pinnedAt: 0, nextParent: "next" },
    { currentParent: "old", pinnedAt: 0, nextParent: "old" },
    { currentParent: "old", pinnedAt: 0, nextParent: null },
  ])(
    "allows parent correction/clear: $currentParent/$pinnedAt → $nextParent",
    async ({ currentParent, pinnedAt, nextParent }) => {
      const harness = await loadPlugin();
      harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "thread", parentThreadId: currentParent, pinnedAt }),
      );
      harness.inspection.sdk.stub("threads.update", async () =>
        makeThreadResponse({ id: "thread", parentThreadId: nextParent, pinnedAt }),
      );
      await expect(
        harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: nextParent }),
      ).resolves.toEqual({ ok: true });
      expect(harness.inspection.sdk.callsTo("threads.update")).toEqual(
        currentParent === nextParent ? [] : [[{ threadId: "thread", parentThreadId: nextParent }]],
      );
      expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(
        nextParent != null && currentParent !== nextParent && pinnedAt != null ? 1 : 0,
      );
    },
  );

  it("requires explicit parentThreadId, never treating omission as clear", async () => {
    const harness = await loadPlugin();
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread" })).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it.each(["get", "pin", "update"])("preserves lifecycle and releases the gate after %s failure", async (stage) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    let failing = true;
    harness.inspection.sdk.stub("threads.get", async () => {
      if (stage === "get" && failing) throw new Error("GET failed");
      return makeThreadResponse({ id: "thread" });
    });
    harness.inspection.sdk.stub("threads.pin", async () => {
      if (stage === "pin" && failing) throw new Error("pin failed");
      return makeThreadResponse({ id: "thread", pinnedAt: 1 });
    });
    harness.inspection.sdk.stub("threads.update", async () => {
      if (stage === "update" && failing) throw new Error("Invalid parent relationship");
      return makeThreadResponse({ id: "thread", parentThreadId: "parent" });
    });
    const run = () =>
      stage === "update"
        ? harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "parent" })
        : harness.behavior.callRpc("pin", { threadId: "thread" });
    await expect(run()).rejects.toThrow(
      stage === "get" ? "GET failed" : stage === "pin" ? "pin failed" : "Invalid parent relationship",
    );
    if (stage === "get") {
      expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
      expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
    }
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    failing = false;
    await expect(run()).resolves.toEqual({ ok: true });
  });

  it.each(["pin", "setThreadParent"])(
    "holds one gate during %s and rechecks the changed state",
    async (firstMethod) => {
      const harness = await loadPlugin();
      const entered = deferred<void>(),
        release = deferred<void>();
      let state = makeThreadResponse({ id: "thread" });
      harness.inspection.sdk.stub("threads.get", async () => ({ ...state }));
      harness.inspection.sdk.stub("threads.pin", async () => {
        entered.resolve();
        await release.promise;
        state = { ...state, pinnedAt: 0 };
        return state;
      });
      harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => {
        entered.resolve();
        await release.promise;
        state = { ...state, parentThreadId: parentThreadId ?? null };
        return state;
      });
      harness.inspection.sdk.stub("threads.unpin", async () => {
        state = { ...state, pinnedAt: null };
        return state;
      });
      const pin = () => harness.behavior.callRpc("pin", { threadId: "thread" });
      const parent = () =>
        harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "parent" });
      const first = firstMethod === "pin" ? pin() : parent();
      await entered.promise;
      const opposite = firstMethod === "pin" ? parent : pin;
      for (let i = 0; i < 2; i += 1)
        await expect(opposite()).rejects.toThrow("Thread update already in progress. Try again.");
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
      release.resolve();
      await expect(first).resolves.toEqual({ ok: true });
      if (firstMethod === "pin") {
        await expect(opposite()).resolves.toEqual({ ok: true });
        expect(state.parentThreadId).toBe("parent");
        expect(state.pinnedAt).toBeNull();
        expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(1);
      } else {
        await expect(opposite()).rejects.toThrow("Child threads cannot be pinned");
        expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
      }
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    },
  );

  it("acquires before GET awaits and keeps different thread IDs independent", async () => {
    const harness = await loadPlugin();
    const entered = deferred<void>(),
      release = deferred<void>();
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "a") {
        entered.resolve();
        await release.promise;
      }
      return makeThreadResponse({ id: threadId });
    });
    harness.inspection.sdk.stub("threads.update", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: "parent" }),
    );
    const first = harness.behavior.callRpc("pin", { threadId: "a" });
    await entered.promise;
    await expect(
      harness.behavior.callRpc("setThreadParent", { threadId: "a", parentThreadId: "parent" }),
    ).rejects.toThrow("Thread update already in progress");
    await expect(
      harness.behavior.callRpc("setThreadParent", { threadId: "b", parentThreadId: "parent" }),
    ).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.get")).toEqual([[{ threadId: "a" }], [{ threadId: "b" }]]);
    release.resolve();
    await expect(first).resolves.toEqual({ ok: true });
  });
});
