import { expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server";
import { createFakePluginHost, disposers, projectThread, projectsWith } from "./test-server";

async function setup(initial: Record<string, boolean> = { a: false, b: false }) {
  const pins = new Map(Object.entries(initial));
  const response = (threadId: string) => makeThreadResponse({ id: threadId, pinnedAt: pins.get(threadId) ? 1 : null });
  const host = createFakePluginHost({
    sdk: {
      plugins: { getSettings: async () => ({ pluginId: "sandy-sidebar", values: {} }) },
      projects: {
        list: async () =>
          projectsWith([...pins].map(([id, pinned]) => projectThread({ id, pinnedAt: pinned ? 1 : null }))),
      },
      threads: {
        get: async ({ threadId }) => response(threadId),
        pin: async ({ threadId }) => {
          pins.set(threadId, true);
          return response(threadId);
        },
        unpin: async ({ threadId }) => {
          pins.set(threadId, false);
          return response(threadId);
        },
      },
    },
  });
  await plugin(host.sandy);
  disposers.push(() => host.harness.lifecycle.dispose());
  const call = <T>(method: string, input: unknown = {}) => host.harness.behavior.callRpc(method, input) as Promise<T>;
  return { ...host, pins, response, call };
}

type BulkChange = { changed: string[]; failed: string[]; undoToken: string };
type BulkUndo = { restored: string[]; failed: string[] };

it("keeps a committed pin undoable when the read after it fails", async () => {
  const h = await setup();
  h.harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    if (h.pins.get(threadId)) throw new Error("network lost after pin");
    return h.response(threadId);
  });
  const result = await h.call<BulkChange>("pinThreads", { threadIds: ["a", "b"], pinned: true });
  expect(result).toMatchObject({ changed: ["a", "b"], failed: [] });
  h.harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => h.response(threadId));
  const undo = await h.call<BulkUndo>("undoBulkAction", { undoToken: result.undoToken });
  expect(undo).toEqual({ restored: ["a", "b"], failed: [] });
  expect([...h.pins]).toEqual([
    ["a", false],
    ["b", false],
  ]);
});
