import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { loadSpacePlugin, spaceThread, type SpaceWorld } from "./test-space-server";

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;

function world(): SpaceWorld {
  return {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [
      spaceThread("thr_orch", "space_a"),
      spaceThread("thr_started", "space_a"),
      spaceThread("thr_managed", "space_a"),
      spaceThread("thr_indep", "space_a"),
      spaceThread("thr_foreign", "space_b"),
    ],
  };
}

const call = (harness: Harness, method: string, input: unknown) => harness.behavior.callRpc(method, input as never);

async function prepare(state: SpaceWorld = world()) {
  const spawn = vi.fn(async (args: { title: string; sectionId: string }) =>
    makeThreadResponse({ id: "thr_started", title: args.title, sectionId: args.sectionId }),
  );
  const harness = await loadSpacePlugin(state, { spawn });
  await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
  await call(harness, "setMemberMode", { threadId: "thr_managed", mode: "managed" });
  await harness.behavior.callAgentTool(
    "space_start_session",
    { projectId: "proj_1", title: "Worker", prompt: "Go" },
    { threadId: "thr_orch" },
  );
  return harness;
}

async function dispatch(
  harness: Harness,
  targetId: string,
  senderThreadId: string | null | "mixed",
  senders: Array<string | null> = [],
) {
  const hook = harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("no dispatch hook");
  return hook({
    thread: makeThreadResponse({ id: targetId }),
    senderThreadId,
    queuedMessages: senders.map((sender) => ({ senderThreadId: sender })),
  } as never);
}

const startedRows = (harness: Harness) =>
  harness.sidebarDb.prepare("SELECT thread_id, space_id, starter_thread_id FROM space_started_sessions").all();

describe("sessions an orchestrator started", () => {
  it("records the starter and the Space", async () => {
    const harness = await prepare();
    expect(startedRows(harness)).toEqual([
      { thread_id: "thr_started", space_id: "space_a", starter_thread_id: "thr_orch" },
    ]);
  });

  it("refuses a started session's message to an independent member and names the reason", async () => {
    const harness = await prepare();
    const decision = await dispatch(harness, "thr_indep", "thr_started");
    expect(decision).toMatchObject({ action: "reject" });
    expect((decision as { message: string }).message).toMatch(/independent/);
    expect(await dispatch(harness, "thr_foreign", "thr_started")).toMatchObject({ action: "reject" });
  });

  it("lets a started session message a managed member of the same Space", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_managed", "thr_started")).toEqual({ action: "proceed" });
  });

  it("refuses a mixed queue that contains a started session", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_indep", "mixed", [null, "thr_started"])).toMatchObject({ action: "reject" });
  });

  it("keeps the restriction after the starter loses its role", async () => {
    const harness = await prepare();
    await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: false });
    expect(await dispatch(harness, "thr_indep", "thr_started")).toMatchObject({ action: "reject" });
  });

  it("forgets the record when the session is deleted", async () => {
    const harness = await prepare();
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_started" }) });
    expect(startedRows(harness)).toEqual([]);
  });

  it("ends the restriction when the session moves to another Space", async () => {
    const state = world();
    const harness = await prepare(state);
    state.threads = state.threads.map((t) => (t.id === "thr_started" ? { ...t, sectionId: "space_b" } : t));
    expect(await dispatch(harness, "thr_indep", "thr_started")).toEqual({ action: "proceed" });
    expect(startedRows(harness)).toEqual([]);
    state.threads = state.threads.map((t) => (t.id === "thr_started" ? { ...t, sectionId: "space_a" } : t));
    expect(await dispatch(harness, "thr_indep", "thr_started")).toEqual({ action: "proceed" });
  });
});
