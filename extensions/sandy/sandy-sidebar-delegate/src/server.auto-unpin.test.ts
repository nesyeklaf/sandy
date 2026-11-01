import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { loadPlugin, deferred } from "./test-server";

describe("parent auto-unpin partial result", () => {
  it.each(["get", "update"])("keeps pin/lifecycle and never unpins on %s failure", async (stage) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    const unpinsBefore = harness.inspection.sdk.callsTo("threads.unpin").length;
    const state = makeThreadResponse({ id: "thread", pinnedAt: 0 });
    harness.inspection.sdk.stub("threads.get", async () => {
      if (stage === "get") throw new Error("GET failed");
      return state;
    });
    harness.inspection.sdk.stub("threads.update", async () => {
      throw new Error("Invalid parent relationship");
    });
    await expect(
      harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" }),
    ).rejects.toThrow(stage === "get" ? "GET failed" : "Invalid parent relationship");
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(unpinsBefore);
    expect(state.pinnedAt).toBe(0);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each([false, true])(
    "holds the gate through deferred unpin, failed=%s, and never retries same-parent",
    async (fails) => {
      const harness = await loadPlugin();
      await harness.behavior.callRpc("park", { threadId: "thread" });
      const before = await harness.behavior.callRpc("listLifecycle", {});
      let state = makeThreadResponse({ id: "thread", pinnedAt: 0 });
      const entered = deferred<void>(),
        release = deferred<void>();
      const calls: string[] = [];
      harness.inspection.sdk.stub("threads.get", async () => ({ ...state }));
      harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => {
        calls.push("update");
        state = { ...state, parentThreadId: parentThreadId ?? null };
        return state;
      });
      harness.inspection.sdk.stub("threads.unpin", async () => {
        calls.push("unpin");
        entered.resolve();
        await release.promise;
        if (fails) throw new Error("Lost unpin response");
        state = { ...state, pinnedAt: null };
        return state;
      });
      const first = harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" });
      await entered.promise;
      expect(state.parentThreadId).toBe("next");
      expect(state.pinnedAt).toBe(0);
      for (const method of ["pin", "setThreadParent"]) {
        await expect(
          harness.behavior.callRpc(method, {
            threadId: "thread",
            ...(method === "setThreadParent" ? { parentThreadId: "next" } : {}),
          }),
        ).rejects.toThrow("Thread update already in progress");
      }
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
      release.resolve();
      await expect(first).resolves.toEqual(fails ? { ok: true, unpinFailed: true } : { ok: true });
      expect(calls).toEqual(["update", "unpin"]);
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
      if (fails) {
        expect(harness.inspection.logEntries).toContainEqual(
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("thread thread, parent next: Lost unpin response"),
          }),
        );
        expect(state.pinnedAt).toBe(0);
      } else expect(state.pinnedAt).toBeNull();
      await expect(
        harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" }),
      ).resolves.toEqual({ ok: true });
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
      expect(calls).toEqual(["update", "unpin"]); // no rollback or repeat unpin
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    },
  );
});
