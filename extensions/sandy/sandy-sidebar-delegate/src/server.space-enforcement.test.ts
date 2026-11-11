import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { WAKE_DIGEST_ENTRIES_MAX, WAKE_DIGEST_INTERVAL_MS } from "./space-coordination-contract";
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
      spaceThread("thr_managed", "space_a"),
      spaceThread("thr_indep", "space_a"),
      spaceThread("thr_foreign", "space_b"),
      spaceThread("thr_free", null),
    ],
  };
}

const call = (harness: Harness, method: string, input: unknown) => harness.behavior.callRpc(method, input as never);

async function prepare(sdk: Record<string, unknown> = {}) {
  const harness = await loadSpacePlugin(world(), sdk);
  await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
  await call(harness, "setMemberMode", { threadId: "thr_managed", mode: "managed" });
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

describe("message dispatch enforcement", () => {
  it("lets the owner message an independent member", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_indep", null)).toEqual({ action: "proceed" });
  });

  it("lets an orchestrator message a managed member", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_managed", "thr_orch")).toEqual({ action: "proceed" });
  });

  it("refuses an orchestrator message to an independent member and names the mode", async () => {
    const harness = await prepare();
    const decision = await dispatch(harness, "thr_indep", "thr_orch");
    expect(decision).toMatchObject({ action: "reject" });
    expect((decision as { message: string }).message).toMatch(/independent/);
  });

  it("refuses an orchestrator message to a session of another Space", async () => {
    const harness = await prepare();
    const decision = await dispatch(harness, "thr_foreign", "thr_orch");
    expect((decision as { message: string }).message).toMatch(/own Space/);
  });

  it("does not restrict a sender that is not an orchestrator", async () => {
    const harness = await prepare();
    expect(await dispatch(harness, "thr_indep", "thr_managed")).toEqual({ action: "proceed" });
  });

  it("refuses mixed senders when any queued sender is refused", async () => {
    const harness = await prepare();
    const refused = await dispatch(harness, "thr_indep", "mixed", [null, "thr_orch"]);
    expect(refused).toMatchObject({ action: "reject" });
    const allowed = await dispatch(harness, "thr_indep", "mixed", [null, "thr_managed"]);
    expect(allowed).toEqual({ action: "proceed" });
  });
});

describe("agent tools", () => {
  const stubs = () => ({
    spawn: vi.fn(async (args: { title: string; sectionId: string }) =>
      makeThreadResponse({ id: "thr_new", title: args.title, sectionId: args.sectionId }),
    ),
    send: vi.fn(async () => ({ ok: true, delivery: "sent" })),
    stop: vi.fn(async () => makeThreadResponse({ id: "thr_managed" })),
    archive: vi.fn(async () => makeThreadResponse({ id: "thr_managed" })),
  });

  it("gives management tools to orchestrators only", async () => {
    const harness = await prepare();
    const context = {
      thread: { id: "", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "p" },
    };
    const names = async (id: string) =>
      (
        await harness.behavior.resolveAgentConfiguration({ ...context, thread: { ...context.thread, id } } as never)
      ).tools.map((tool: { name: string }) => tool.name);
    expect(await names("thr_orch")).toContain("space_start_session");
    expect(await names("thr_managed")).not.toContain("space_start_session");
    expect(await names("thr_managed")).toContain("space_scratchpad_write");
  });

  it("refuses a management tool called by a non-orchestrator", async () => {
    const harness = await prepare(stubs());
    const result = await harness.behavior.callAgentTool(
      "space_stop_session",
      { threadId: "thr_managed" },
      { threadId: "thr_indep" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(harness.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("refuses to stop an independent member and stops a managed one", async () => {
    const harness = await prepare(stubs());
    const refused = await harness.behavior.callAgentTool(
      "space_stop_session",
      { threadId: "thr_indep" },
      { threadId: "thr_orch" },
    );
    expect(refused).toMatchObject({ isError: true });
    await harness.behavior.callAgentTool("space_stop_session", { threadId: "thr_managed" }, { threadId: "thr_orch" });
    expect(harness.sdk.callsTo("threads.stop")).toHaveLength(1);
  });

  it("starts a flat managed member linked to an idea", async () => {
    const state = await loadSpacePlugin(
      {
        sections: [{ id: "space_a", name: "Alpha" }],
        threads: [spaceThread("thr_orch", "space_a"), spaceThread("thr_new", "space_a")],
      },
      stubs(),
    );
    await call(state, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
    const created = (await call(state, "createIdea", { spaceId: "space_a", title: "Do it" })) as { id: string };
    await state.behavior.callAgentTool(
      "space_start_session",
      { projectId: "proj_1", title: "Worker", prompt: "Go", ideaId: created.id },
      { threadId: "thr_orch" },
    );
    const [spawn] = state.sdk.callsTo("threads.spawn");
    const args = spawn?.[0] as Record<string, unknown>;
    expect(args.sectionId).toBe("space_a");
    expect(args.parentThreadId).toBeUndefined();
    expect(args.lifecycleOwnerThreadId).toBeUndefined();
    const coordination = (await call(state, "getSpaceCoordination", { spaceId: "space_a" })) as {
      members: Array<{ threadId: string; mode: string }>;
      ideas: Array<{ status: string; threadIds: string[] }>;
    };
    expect(coordination.members.find((member) => member.threadId === "thr_new")?.mode).toBe("managed");
    expect(coordination.ideas[0]).toMatchObject({ status: "in-progress", threadIds: ["thr_new"] });
  });

  it("lets a member record an idea but only an orchestrator delete it", async () => {
    const harness = await prepare();
    const created = JSON.parse(
      (await harness.behavior.callAgentTool(
        "space_idea_create",
        { title: "Member idea", body: "b" },
        { threadId: "thr_indep" },
      )) as string,
    ) as { id: string; authorThreadId: string };
    expect(created.authorThreadId).toBe("thr_indep");
    const refused = await harness.behavior.callAgentTool(
      "space_idea_delete",
      { ideaId: created.id },
      { threadId: "thr_indep" },
    );
    expect(refused).toMatchObject({ isError: true });
    await harness.behavior.callAgentTool("space_idea_delete", { ideaId: created.id }, { threadId: "thr_orch" });
    expect(((await call(harness, "listIdeas", { spaceId: "space_a" })) as { ideas: unknown[] }).ideas).toHaveLength(0);
  });

  it("refuses space tools for a session without a Space", async () => {
    const harness = await prepare();
    const result = await harness.behavior.callAgentTool("space_context", {}, { threadId: "thr_free" });
    expect(result).toMatchObject({ isError: true });
  });
});

describe("wake digest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function wakeWorld(managedCount: number) {
    const members = Array.from({ length: managedCount }, (_, index) => spaceThread(`thr_w${index}`, "space_a"));
    const state: SpaceWorld = {
      sections: [{ id: "space_a", name: "Alpha" }],
      threads: [spaceThread("thr_orch", "space_a"), ...members],
    };
    const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    const harness = await loadSpacePlugin(state, { send });
    await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
    for (const member of members) await call(harness, "setMemberMode", { threadId: member.id, mode: "managed" });
    return { harness, members, send };
  }

  it("sends one capped digest per interval with the omitted count", async () => {
    const { harness, members, send } = await wakeWorld(70);
    for (const member of members)
      await harness.behavior.emitThreadEvent("thread.idle", { thread: member, lastAssistantText: null });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKE_DIGEST_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    const text = (send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]?.text ?? "";
    expect(text).toContain("(20 older outcomes omitted)");
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(WAKE_DIGEST_ENTRIES_MAX);
    expect(text).toContain("thr_w69");
    expect(text).not.toContain("thr_w0)");
  });

  it("sends nothing when the Space switch is off or the member is independent", async () => {
    const { harness, members, send } = await wakeWorld(2);
    await call(harness, "setSpaceWake", { spaceId: "space_a", enabled: false });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: members[0], error: null });
    await call(harness, "setSpaceWake", { spaceId: "space_a", enabled: true });
    await call(harness, "setMemberMode", { threadId: members[1]?.id, mode: "independent" });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: members[1], error: null });
    await vi.advanceTimersByTimeAsync(WAKE_DIGEST_INTERVAL_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it("starts a new window after a digest", async () => {
    const { harness, members, send } = await wakeWorld(2);
    await harness.behavior.emitThreadEvent("thread.failed", { thread: members[0], error: null });
    await vi.advanceTimersByTimeAsync(WAKE_DIGEST_INTERVAL_MS);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: members[1], lastAssistantText: null });
    await vi.advanceTimersByTimeAsync(WAKE_DIGEST_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
