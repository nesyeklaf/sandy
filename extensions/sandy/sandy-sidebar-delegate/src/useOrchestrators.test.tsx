// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { loadSpacePlugin, spaceThread } from "./test-space-server";

const state = vi.hoisted(() => ({ call: async (_method: string, _input: unknown): Promise<unknown> => ({}) }));

vi.mock("@sandy-sdk/plugin-sdk/app", () => ({
  useRpc: () => ({ call: (method: string, input: unknown) => state.call(method, input) }),
  useRealtime: () => {},
}));

const { useMarkOrchestrators } = await import("./useOrchestrators");

async function setup(world: Parameters<typeof loadSpacePlugin>[0]) {
  const harness = await loadSpacePlugin(world);
  state.call = (method, input) => harness.behavior.callRpc(method, input);
  const rows = () => harness.sidebarDb.prepare("select thread_id from space_orchestrators order by thread_id").all();
  return { harness, rows };
}

it("assigns sessions of different Spaces in one call and reports every changed id", async () => {
  const { rows } = await setup({
    sections: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    threads: [spaceThread("first", "a"), spaceThread("second", "b")],
  });
  const hook = renderHook(() => useMarkOrchestrators());
  let changed: string[] = [];
  await act(async () => {
    changed = await hook.result.current(["first", "second"], true);
  });
  expect(changed).toEqual(["first", "second"]);
  expect(rows()).toHaveLength(2);
  cleanup();
});

it("changes nothing when one selected session is outside every Space", async () => {
  const { rows } = await setup({
    sections: [{ id: "a", name: "A" }],
    threads: [spaceThread("first", "a"), spaceThread("free", null), spaceThread("last", "a")],
  });
  const hook = renderHook(() => useMarkOrchestrators());
  let message = "";
  await act(async () => {
    await hook.result.current(["first", "free", "last"], true).catch((error: unknown) => {
      message = error instanceof Error ? error.message : "";
    });
  });
  expect(message).toContain("free");
  expect(rows()).toEqual([]);
  cleanup();
});

it("lets the whole change be undone with the returned ids", async () => {
  const { rows } = await setup({
    sections: [{ id: "a", name: "A" }],
    threads: [spaceThread("first", "a"), spaceThread("last", "a")],
  });
  const hook = renderHook(() => useMarkOrchestrators());
  let changed: string[] = [];
  await act(async () => {
    changed = await hook.result.current(["first", "last"], true);
  });
  await act(async () => {
    await hook.result.current(changed, false);
  });
  expect(rows()).toEqual([]);
  cleanup();
});
