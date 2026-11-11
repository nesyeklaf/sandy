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

async function prepare(state: SpaceWorld = world(), beforeStart: (harness: Harness) => void = () => {}) {
  const stop = vi.fn(async () => makeThreadResponse({ id: "thr_started" }));
  const spawn = vi.fn(async (args: { title: string; sectionId: string }) =>
    makeThreadResponse({ id: "thr_started", title: args.title, sectionId: args.sectionId }),
  );
  const harness = await loadSpacePlugin(state, { spawn, stop });
  await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
  await call(harness, "setMemberMode", { threadId: "thr_managed", mode: "managed" });
  beforeStart(harness);
  const result = await harness.behavior.callAgentTool(
    "space_start_session",
    { projectId: "proj_1", title: "Worker", prompt: "Go" },
    { threadId: "thr_orch" },
  );
  return Object.assign(harness, { result, stop });
}

async function createChild(harness: Harness, state: SpaceWorld, id: string, parent: string, sectionId: string | null) {
  state.threads.push(spaceThread(id, sectionId, { parentThreadId: parent }));
  await harness.behavior.emitThreadEvent("thread.created", {
    thread: makeThreadResponse({ id, parentThreadId: parent, sectionId }),
  });
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
  it("lets a started session message an orchestrator of its Space but not other independent targets", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_orch", "thr_started")).toEqual({ action: "proceed" });
    const refused = await dispatch(harness, "thr_indep", "thr_started");
    expect((refused as { message: string }).message).toMatch(/independent/);
  });

  it("keeps the restriction after the starter is archived", async () => {
    const state = world();
    const harness = await prepare(state);
    state.threads = state.threads.map((t) => (t.id === "thr_orch" ? { ...t, archivedAt: 5 } : t));
    expect(await dispatch(harness, "thr_indep", "thr_started")).toMatchObject({ action: "reject" });
  });

  it("restricts a child, a grandchild and a child of an orchestrator, in or outside a Space", async () => {
    const state = world();
    const harness = await prepare(state);
    await createChild(harness, state, "thr_child", "thr_started", null);
    await createChild(harness, state, "thr_grand", "thr_child", null);
    await createChild(harness, state, "thr_orch_child", "thr_orch", "space_a");
    await createChild(harness, state, "thr_plain_child", "thr_indep", "space_a");
    for (const sender of ["thr_child", "thr_grand", "thr_orch_child"]) {
      expect(await dispatch(harness, "thr_indep", sender)).toMatchObject({ action: "reject" });
      expect(await dispatch(harness, "thr_foreign", sender)).toMatchObject({ action: "reject" });
    }
    expect(await dispatch(harness, "thr_managed", "thr_grand")).toEqual({ action: "proceed" });
    expect(await dispatch(harness, "thr_indep", "thr_plain_child")).toEqual({ action: "proceed" });
  });

  it("ends a child's restriction when it is observed in another Space", async () => {
    const state = world();
    const harness = await prepare(state);
    await createChild(harness, state, "thr_child", "thr_started", "space_a");
    state.threads = state.threads.map((t) => (t.id === "thr_child" ? { ...t, sectionId: "space_b" } : t));
    expect(await dispatch(harness, "thr_indep", "thr_child")).toEqual({ action: "proceed" });
  });

  it("stops the started session and says so when the record cannot be written", async () => {
    const harness = await prepare(world(), (h) =>
      h.sidebarDb.exec(
        "CREATE TRIGGER fail_started BEFORE INSERT ON space_started_sessions BEGIN SELECT RAISE(ABORT, 'disk'); END",
      ),
    );
    expect(harness.result).toMatchObject({ isError: true });
    expect(JSON.stringify(harness.result)).toMatch(/It was stopped/);
    expect(harness.stop).toHaveBeenCalledWith({ threadId: "thr_started" });
  });

  it("stops the started session and keeps its restriction when the managed mode cannot be written", async () => {
    const harness = await prepare(world(), (h) =>
      h.sidebarDb.exec(
        "CREATE TRIGGER fail_managed BEFORE INSERT ON space_managed_members WHEN NEW.thread_id = 'thr_started' BEGIN SELECT RAISE(ABORT, 'disk'); END",
      ),
    );
    expect(harness.result).toMatchObject({ isError: true });
    expect(harness.stop).toHaveBeenCalledWith({ threadId: "thr_started" });
    expect(startedRows(harness)).toHaveLength(1);
    expect(await dispatch(harness, "thr_indep", "thr_started")).toMatchObject({ action: "reject" });
  });

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
