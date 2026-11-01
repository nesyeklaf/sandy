import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { loadPlugin } from "./test-server";

describe("parent thread RPC", () => {
  it("uses SANDY's thread update for assigning and removing a parent", async () => {
    const harness = await loadPlugin();
    let state = makeThreadResponse({ id: "thr_1" });
    harness.inspection.sdk.stub("threads.get", async () => state);
    harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => {
      state = { ...state, parentThreadId: parentThreadId ?? null };
      return state;
    });
    for (const parentThreadId of ["thr_parent", null]) {
      await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thr_1", parentThreadId })).resolves.toEqual(
        { ok: true },
      );
    }
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([
      [{ threadId: "thr_1", parentThreadId: "thr_parent" }],
      [{ threadId: "thr_1", parentThreadId: null }],
    ]);
  });
  it("propagates SANDY's validation failures", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.update", async () => {
      throw new Error("Invalid parent relationship");
    });
    await expect(
      harness.behavior.callRpc("setThreadParent", { threadId: "thr_1", parentThreadId: "thr_parent" }),
    ).rejects.toThrow("Invalid parent relationship");
  });
});
