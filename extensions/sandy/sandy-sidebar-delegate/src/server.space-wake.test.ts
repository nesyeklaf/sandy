import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_IN_TICK_MS, FALLBACK_ENTRIES_MAX, FALLBACK_INTERVAL_MS } from "./space-coordination-contract";
import { loadSpacePlugin, spaceThread, type FakeThread, type SpaceWorld } from "./test-space-server";

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;
type SendCall = { threadId: string; senderThreadId?: string; input: Array<{ text: string }> };

const MINUTE_MS = 60_000;
const call = (harness: Harness, method: string, input: unknown) => harness.behavior.callRpc(method, input as never);
const tool = (harness: Harness, name: string, input: unknown, threadId: string) =>
  harness.behavior.callAgentTool(name, input as never, { threadId } as never);

async function load(memberCount: number, delivery: "sent" | "queued" = "sent", orchestratorCount = 1) {
  const orchestrators = Array.from({ length: orchestratorCount }, (_, index) =>
    spaceThread(`thr_orch${index}`, "space_a"),
  );
  const members = Array.from({ length: memberCount }, (_, index) =>
    spaceThread(`thr_m${index}`, "space_a", { updatedAt: Date.now() }),
  );
  const state: SpaceWorld = {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [...orchestrators, ...members, spaceThread("thr_indep", "space_a")],
  };
  const send = vi.fn(async (_input: SendCall) => ({ ok: true, delivery }));
  const harness = await loadSpacePlugin(state, { send });
  for (const orchestrator of orchestrators) {
    await call(harness, "setOrchestrator", { threadId: orchestrator.id, orchestrator: true });
  }
  for (const member of members) await call(harness, "setMemberMode", { threadId: member.id, mode: "managed" });
  const update = (threadId: string, change: Partial<FakeThread> & { hasPendingInteraction?: boolean }) => {
    state.threads = state.threads.map((thread) => (thread.id === threadId ? { ...thread, ...change } : thread));
    const found = state.threads.find((thread) => thread.id === threadId);
    if (found === undefined) throw new Error(`no thread ${threadId}`);
    return found;
  };
  const texts = () => send.mock.calls.map(([input]) => input.input[0]?.text ?? "");
  return { harness, state, send, update, texts };
}

describe("coordination settings", () => {
  it("defaults to self-reports on, check-ins every 10 minutes and the fallback on", async () => {
    const { harness } = await load(0);
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as { settings: unknown };
    expect(context.settings).toEqual({ selfReports: true, checkInMinutes: 10, failureFallback: true });
  });

  it("refuses an interval out of range and keeps the setting", async () => {
    const { harness } = await load(0);
    for (const checkInMinutes of [1441, -1]) {
      await expect(
        call(harness, "setSpaceCoordinationSettings", { spaceId: "space_a", checkInMinutes }),
      ).rejects.toMatchObject({ issues: [{ message: "Check-in interval must be 0 to 1440 minutes" }] });
    }
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      settings: { checkInMinutes: number };
    };
    expect(context.settings.checkInMinutes).toBe(10);
  });
});

describe("self-reports", () => {
  it("delivers a done report to every orchestrator as a message from the member and keeps it", async () => {
    const { harness, send } = await load(1, "sent", 2);
    const result = await tool(harness, "space_report", { outcome: "done", summary: "Fixed the queue" }, "thr_m0");
    expect(JSON.parse(String(result))).toMatchObject({ outcome: "done", deliveredTo: ["thr_orch0", "thr_orch1"] });
    expect(send).toHaveBeenCalledTimes(2);
    for (const [input] of send.mock.calls) {
      expect(input.senderThreadId).toBe("thr_m0");
      expect(input.input[0]?.text).toContain("[Space Alpha] Report from thr_m0 (thr_m0): done\nFixed the queue");
    }
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      members: Array<{ threadId: string; latestReport: { outcome: string; summary: string } | null }>;
    };
    expect(context.members.find((member) => member.threadId === "thr_m0")?.latestReport).toMatchObject({
      outcome: "done",
      summary: "Fixed the queue",
    });
  });

  it("refuses a report from an independent member and sends nothing", async () => {
    const { harness, send } = await load(1);
    const result = await tool(harness, "space_report", { outcome: "done", summary: "x" }, "thr_indep");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/Only managed members report/);
    expect(send).not.toHaveBeenCalled();
  });

  it("offers the tool and instructions only while self-reports are on", async () => {
    const { harness } = await load(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resolve = () =>
      harness.behavior.resolveAgentConfiguration({
        thread: { id: "thr_m0", title: null, parentThreadId: null, sourceThreadId: null },
        project: { id: "p" },
      } as never);
    const on = await resolve();
    expect(on.tools.map((entry: { name: string }) => entry.name)).toContain("space_report");
    expect(on.instructions).toContain("call space_report");
    await call(harness, "setSpaceCoordinationSettings", { spaceId: "space_a", selfReports: false });
    const off = await resolve();
    expect(off.tools.map((entry: { name: string }) => entry.name)).not.toContain("space_report");
    expect(off.instructions ?? "").not.toContain("space_report");
    const refused = await harness.behavior.runCli(["report", "done", "--summary", "x"], { threadId: "thr_m0" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/Self-reports are off/);
  });

  it("refuses a summary over 2000 characters", async () => {
    const { harness, send } = await load(1);
    const refused = await harness.behavior.runCli(["report", "done", "--summary", "x".repeat(2001)], {
      threadId: "thr_m0",
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/2000 characters/);
    expect(send).not.toHaveBeenCalled();
    const accepted = await harness.behavior.runCli(["report", "blocked", "--summary", "Need the key", "--json"], {
      threadId: "thr_m0",
    });
    expect(accepted.exitCode).toBe(0);
  });

  it("does not carry a report into another Space", async () => {
    const { harness, update } = await load(1);
    await tool(harness, "space_report", { outcome: "done", summary: "ok" }, "thr_m0");
    update("thr_m0", { sectionId: "space_b" });
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_b" })) as {
      members: Array<{ threadId: string; latestReport: unknown }>;
    };
    expect(context.members.find((member) => member.threadId === "thr_m0")?.latestReport).toBeNull();
  });

  it("forgets the report when the member is deleted", async () => {
    const { harness, update } = await load(1);
    await tool(harness, "space_report", { outcome: "done", summary: "ok" }, "thr_m0");
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: update("thr_m0", {}) });
    const count = harness.sidebarDb.prepare("SELECT COUNT(*) AS count FROM space_member_reports").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});

describe("failure fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends nothing for a turn that ended, nor for a failure the member recovered from", async () => {
    const { harness, send, update } = await load(2);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: update("thr_m0", {}), lastAssistantText: null });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: update("thr_m1", { status: "error" }),
      error: null,
    });
    update("thr_m1", { status: "active" });
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("merges two outcomes of one member into one entry with the latest", async () => {
    const { harness, update, texts } = await load(1);
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: update("thr_m0", { status: "error" }),
      error: null,
    });
    const asking = update("thr_m0", { hasPendingInteraction: true });
    await harness.behavior.emitThreadEvent("interaction.pending", { thread: asking, interaction: {} } as never);
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS);
    expect(texts()).toHaveLength(1);
    const lines = (texts()[0] ?? "").split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual(["- thr_m0 (thr_m0): waiting on a question"]);
    expect(texts()[0]).toMatch(/^\[Space Alpha\] /);
  });

  it("drops a question answered before sending", async () => {
    const { harness, send, update } = await load(1);
    const asking = update("thr_m0", { hasPendingInteraction: true });
    await harness.behavior.emitThreadEvent("interaction.pending", { thread: asking, interaction: {} } as never);
    update("thr_m0", { hasPendingInteraction: false });
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a failure the member reported after", async () => {
    const { harness, update, texts } = await load(1);
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: update("thr_m0", { status: "error" }),
      error: null,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await tool(harness, "space_report", { outcome: "blocked", summary: "Tests fail on CI" }, "thr_m0");
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("Report from");
  });

  it("caps a burst at 50 entries with the omitted count", async () => {
    const { harness, update, texts } = await load(70);
    for (let index = 0; index < 70; index += 1) {
      await harness.behavior.emitThreadEvent("thread.failed", {
        thread: update(`thr_m${index}`, { status: "error" }),
        error: null,
      });
    }
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS);
    expect(texts()).toHaveLength(1);
    const text = texts()[0] ?? "";
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(FALLBACK_ENTRIES_MAX);
    expect(text).toContain("(20 more members omitted)");
  });

  it("sends nothing while the fallback is off", async () => {
    const { harness, send, update } = await load(1);
    await call(harness, "setSpaceCoordinationSettings", { spaceId: "space_a", failureFallback: false });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: update("thr_m0", { status: "error" }),
      error: null,
    });
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("periodic check-in", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function silent() {
    const world = await load(2);
    await call(world.harness, "setSpaceCoordinationSettings", { spaceId: "space_a", failureFallback: false });
    return world;
  }

  it("lists a silent working member once and sends nothing when nothing changed", async () => {
    const { update, texts } = await silent();
    update("thr_m0", { status: "active" });
    await vi.advanceTimersByTimeAsync(CHECK_IN_TICK_MS + 10 * MINUTE_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("[Space Alpha] Check-in");
    expect(texts()[0]).toMatch(/thr_m0 \(thr_m0\): working, no change for 1[01] min; it may be stuck/);
    expect(texts()[0]).not.toContain("thr_m1");
    await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
    expect(texts()).toHaveLength(1);
  });

  it("lists a member idle after a turn without a report, but not one that reported", async () => {
    const { harness, update, texts } = await silent();
    for (const id of ["thr_m0", "thr_m1"]) {
      await harness.behavior.emitThreadEvent("thread.active", { thread: update(id, { status: "active" }) });
    }
    await vi.advanceTimersByTimeAsync(1000);
    await tool(harness, "space_report", { outcome: "done", summary: "ok" }, "thr_m1");
    for (const id of ["thr_m0", "thr_m1"]) {
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: update(id, { status: "idle" }),
        lastAssistantText: null,
      });
    }
    await vi.advanceTimersByTimeAsync(CHECK_IN_TICK_MS + 10 * MINUTE_MS);
    const checkIns = texts().filter((text) => text.includes("Check-in"));
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0]).toContain("thr_m0 (thr_m0): idle, no report since its last turn");
    expect(checkIns[0]).not.toContain("thr_m1 (thr_m1)");
  });

  it("does not stack a check-in while the previous one is still queued", async () => {
    const world = await load(2, "queued");
    await call(world.harness, "setSpaceCoordinationSettings", { spaceId: "space_a", failureFallback: false });
    world.update("thr_m0", { status: "active" });
    await vi.advanceTimersByTimeAsync(CHECK_IN_TICK_MS + 10 * MINUTE_MS);
    expect(world.texts()).toHaveLength(1);
    world.update("thr_m1", { status: "error" });
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(world.texts()).toHaveLength(1);
    await world.harness.behavior.emitThreadEvent("thread.active", { thread: world.update("thr_orch0", {}) });
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(world.texts()).toHaveLength(2);
    expect(world.texts()[1]).toContain("thr_m1 (thr_m1): failed");
  });

  it("sends nothing while check-ins are off", async () => {
    const { harness, update, send } = await silent();
    await call(harness, "setSpaceCoordinationSettings", { spaceId: "space_a", checkInMinutes: 0 });
    update("thr_m0", { status: "error" });
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
