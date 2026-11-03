import { expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server";
import { createFakePluginHost, disposers, projectThread, projectsWith } from "./test-server";
import { deferred } from "./test-fixtures";
import type { LifecycleListResult } from "./test-server";

async function setup(initial: Record<string, boolean> = { a: false, b: false }) {
  const pins = new Map(Object.entries(initial));
  const pendingQuestions = new Map<string, string[]>();
  const response = (threadId: string) => makeThreadResponse({ id: threadId, pinnedAt: pins.get(threadId) ? 1 : null });
  const host = createFakePluginHost({
    sdk: {
      plugins: { getSettings: async () => ({ pluginId: "sandy-sidebar", values: {} }) },
      projects: {
        list: async () =>
          projectsWith(
            [...pins].map(([id, pinned]) =>
              projectThread({
                id,
                pinnedAt: pinned ? 1 : null,
                hasPendingInteraction: (pendingQuestions.get(id) ?? []).length > 0,
              }),
            ),
          ),
      },
      threads: {
        get: async ({ threadId }) => response(threadId),
        interactions: {
          list: async ({ threadId }) => (pendingQuestions.get(threadId) ?? []).map((id) => ({ id })) as never,
        },
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
  return { ...host, pins, pendingQuestions, response, call };
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

it("an Undo in flight keeps a Snooze chosen while it waited", async () => {
  const h = await setup();
  const result = await h.call<BulkChange>("pinThreads", { threadIds: ["a"], pinned: true });
  const entered = deferred<void>();
  const release = deferred<void>();
  let first = true;
  h.harness.inspection.sdk.stub("threads.unpin", async ({ threadId }: { threadId: string }) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    h.pins.set(threadId, false);
    return h.response(threadId);
  });
  const undo = h.call<BulkUndo>("undoBulkAction", { undoToken: result.undoToken });
  await entered.promise;
  const snoozedUntil = Date.now() + 3_600_000;
  const snooze = h.call("snooze", { threadId: "a", snoozedUntil });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release.resolve();
  await Promise.all([undo, snooze]);
  const { rows } = await h.call<LifecycleListResult>("listLifecycle");
  expect(rows).toEqual([expect.objectContaining({ threadId: "a", snoozedUntil })]);
  expect(h.pins.get("a")).toBe(false);
});

it("a question that arrives while Later commits wakes the thread", async () => {
  const h = await setup();
  const entered = deferred<void>();
  const release = deferred<void>();
  h.harness.inspection.sdk.stub("threads.unpin", async ({ threadId }: { threadId: string }) => {
    entered.resolve();
    await release.promise;
    h.pins.set(threadId, false);
    return h.response(threadId);
  });
  const later = h.call("snooze", {
    threadId: "a",
    snoozedUntil: Date.now() + 3_600_000,
    deferredInteractionId: "old-question",
  });
  await entered.promise;
  const event = h.harness.behavior.emitThreadEvent("interaction.pending", {
    thread: h.response("a"),
    interaction: { id: "new-question" },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release.resolve();
  await Promise.all([later, event]);
  expect((await h.call<LifecycleListResult>("listLifecycle")).rows).toEqual([]);
});

it("Later refuses to defer when a newer question is already pending", async () => {
  const h = await setup({ a: true });
  h.pendingQuestions.set("a", ["old-question", "new-question"]);
  await expect(
    h.call("snooze", { threadId: "a", snoozedUntil: Date.now() + 3_600_000, deferredInteractionId: "old-question" }),
  ).rejects.toThrow(/Another question arrived/);
  expect((await h.call<LifecycleListResult>("listLifecycle")).rows).toEqual([]);
  expect(h.pins.get("a")).toBe(true);
  h.pendingQuestions.set("a", ["old-question"]);
  await h.call("snooze", { threadId: "a", snoozedUntil: Date.now() + 3_600_000, deferredInteractionId: "old-question" });
  expect((await h.call<LifecycleListResult>("listLifecycle")).rows).toEqual([
    expect.objectContaining({ threadId: "a", deferredInteractionId: "old-question" }),
  ]);
});
