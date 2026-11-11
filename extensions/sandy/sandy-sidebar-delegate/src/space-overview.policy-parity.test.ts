import { describe, expect, it } from "vitest";
import { listed, type Listed, type overview } from "./test-space-overview";
import plugin from "./server";
import { createFakePluginHost, disposers } from "./test-server";
import type { StoredLifecycleRow } from "./server-lifecycle";

const HOUR = 60 * 60 * 1000;

function row(threadId: string, overrides: Partial<StoredLifecycleRow>): StoredLifecycleRow {
  return {
    threadId,
    parkedAt: null,
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    ...overrides,
  };
}

async function shelves(threads: Listed[], rows: StoredLifecycleRow[]) {
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar" });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  const db = sandy.storage.database();
  for (const stored of rows) {
    db.prepare(
      "INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at, deferred_interaction_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      stored.threadId,
      stored.settledAt,
      stored.settledOverride,
      stored.snoozedUntil,
      stored.snoozedAt,
      stored.parkedAt ?? null,
      stored.deferredInteractionId ?? null,
    );
  }
  harness.inspection.sdk.stub("threads.list", async () => threads);
  harness.inspection.sdk.stub("threadSections.list", async () => []);
  harness.inspection.sdk.stub("plugins.callRpc", async () => ({}));
  const result = (await harness.behavior.callRpc("getSpaceOverview", {})) as Awaited<ReturnType<typeof overview>>;
  return Object.fromEntries(result.spaces.flatMap((space) => space.roots.map((root) => [root.rootId, root.shelf])));
}

describe("getSpaceOverview follows the native lifecycle and working policy", () => {
  it("counts pending and starting turns, goals and plan mode as working", async () => {
    const goal = {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 1,
    };
    const plan = { ...goal, activeGoalCount: 0, activePlanModeCount: 1 };
    expect(
      await shelves(
        [
          listed("pending", { status: "pending" }),
          listed("starting", { status: "starting" }),
          listed("stopping", { status: "stopping" }),
          listed("goal", { activity: goal }),
          listed("plan", { activity: plan }),
          listed("calm"),
        ],
        [],
      ),
    ).toEqual({
      pending: "working",
      starting: "working",
      stopping: "working",
      goal: "working",
      plan: "working",
      calm: "ready",
    });
  });

  it("wakes a snoozed root for a new question but honours a deferred question", async () => {
    const now = Date.now();
    const snoozed = { snoozedUntil: now + 2 * HOUR, snoozedAt: now - HOUR };
    expect(
      await shelves(
        [
          listed("asked", { hasPendingInteraction: true, latestAttentionAt: now - 2 * HOUR }),
          listed("deferred", { hasPendingInteraction: true, latestAttentionAt: now - 2 * HOUR }),
          listed("quiet", { latestAttentionAt: now - 2 * HOUR }),
        ],
        [row("asked", snoozed), row("deferred", { ...snoozed, deferredInteractionId: "int_1" }), row("quiet", snoozed)],
      ),
    ).toEqual({ asked: "needs", deferred: "snoozed", quiet: "snoozed" });
  });

  it("reactivates a settled or parked root with attention newer than the stored mark", async () => {
    const now = Date.now();
    expect(
      await shelves(
        [
          listed("settled-new", { latestAttentionAt: now - HOUR }),
          listed("settled-old", { latestAttentionAt: now - 3 * HOUR }),
          listed("parked-new", { latestAttentionAt: now - HOUR }),
          listed("parked-old", { latestAttentionAt: now - 3 * HOUR }),
        ],
        [
          row("settled-new", { settledAt: now - 2 * HOUR }),
          row("settled-old", { settledAt: now - 2 * HOUR }),
          row("parked-new", { parkedAt: now - 2 * HOUR }),
          row("parked-old", { parkedAt: now - 2 * HOUR }),
        ],
      ),
    ).toEqual({ "settled-new": "ready", "settled-old": "archived", "parked-new": "ready", "parked-old": "snoozed" });
  });

  it("wakes a snoozed root when a hidden worker asks and keeps a deferred question snoozed", async () => {
    const now = Date.now();
    const snoozed = { snoozedUntil: now + 2 * HOUR, snoozedAt: now - HOUR };
    const old = { latestAttentionAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR };
    const hidden = { ...old, visibility: "hidden", hasPendingInteraction: true } as Partial<Listed>;
    expect(
      await shelves(
        [
          listed("asks-root", old),
          listed("asks-child", { ...hidden, parentThreadId: "asks-root" }),
          listed("deferred-root", old),
          listed("deferred-child", { ...hidden, parentThreadId: "deferred-root" }),
        ],
        [row("asks-root", snoozed), row("deferred-root", { ...snoozed, deferredInteractionId: "int_1" })],
      ),
    ).toEqual({ "asks-root": "needs", "deferred-root": "snoozed" });
  });

  it("keeps a snoozed root snoozed for a hidden active worker but wakes it when a deferred question has an active sibling", async () => {
    const now = Date.now();
    const snoozed = { snoozedUntil: now + 2 * HOUR, snoozedAt: now - HOUR };
    const old = { latestAttentionAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR };
    const hidden = { ...old, visibility: "hidden" } as Partial<Listed>;
    expect(
      await shelves(
        [
          listed("works-root", old),
          listed("works-child", { ...hidden, parentThreadId: "works-root", status: "active" }),
          listed("mixed-root", old),
          listed("mixed-asks", { ...hidden, parentThreadId: "mixed-root", hasPendingInteraction: true }),
          listed("mixed-works", { ...hidden, parentThreadId: "mixed-root", status: "active" }),
        ],
        [row("works-root", snoozed), row("mixed-root", { ...snoozed, deferredInteractionId: "int_1" })],
      ),
    ).toEqual({ "works-root": "snoozed", "mixed-root": "needs" });
  });

  it("keeps a pinned root active over a settled, snoozed or parked row unless it was explicitly settled", async () => {
    const now = Date.now();
    const old = { latestAttentionAt: now - 3 * HOUR, pinnedAt: now - HOUR };
    expect(
      await shelves(
        [
          listed("pinned-settled-auto", old),
          listed("pinned-settled-override", old),
          listed("pinned-snoozed", old),
          listed("pinned-parked", old),
          listed("unpinned-settled", { latestAttentionAt: now - 3 * HOUR }),
        ],
        [
          row("pinned-settled-auto", { settledAt: now - 2 * HOUR }),
          row("pinned-settled-override", { settledAt: now - 2 * HOUR, settledOverride: "settled" }),
          row("pinned-snoozed", { snoozedUntil: now + HOUR, snoozedAt: now - 2 * HOUR }),
          row("pinned-parked", { parkedAt: now - 2 * HOUR }),
          row("unpinned-settled", { settledAt: now - 2 * HOUR }),
        ],
      ),
    ).toEqual({
      "pinned-settled-auto": "ready",
      "pinned-settled-override": "archived",
      "pinned-snoozed": "snoozed",
      "pinned-parked": "snoozed",
      "unpinned-settled": "archived",
    });
  });
});
