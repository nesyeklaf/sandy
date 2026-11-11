import { describe, expect, it } from "vitest";
import { loadSpacePlugin, spaceThread, type SpaceWorld } from "./test-space-server";

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;

function world(): SpaceWorld {
  return {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [spaceThread("thr_orch", "space_a"), spaceThread("thr_m", "space_a"), spaceThread("thr_free", null)],
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function toolNames(harness: Harness, id: string): Promise<string[]> {
  const configuration = await harness.behavior.resolveAgentConfiguration({
    thread: { id, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: "p" },
  } as never);
  return configuration.tools.map((tool: { name: string }) => tool.name);
}

async function withOrchestrator(state: SpaceWorld) {
  const harness = await loadSpacePlugin(state);
  await harness.behavior.callRpc("setOrchestrator", { threadId: "thr_orch", orchestrator: true } as never);
  return harness;
}

describe("agent configuration", () => {
  it("gives a thread outside any Space no tools", async () => {
    const harness = await withOrchestrator(world());
    await settle();
    expect(await toolNames(harness, "thr_free")).toEqual([]);
  });

  it("gives no tools to a thread the cache does not know yet, and learns it for the next resolution", async () => {
    const state = world();
    const harness = await withOrchestrator(state);
    state.threads.push(spaceThread("thr_late", "space_a"));
    expect(await toolNames(harness, "thr_late")).toEqual([]);
    await settle();
    expect(await toolNames(harness, "thr_late")).toContain("space_context");
  });

  it("gives an orchestrator no management tools while its Space is unverified after a restart", async () => {
    const state = world();
    const harness = await withOrchestrator(state);
    const restarted = await loadSpacePlugin(state);
    expect(await toolNames(restarted, "thr_orch")).not.toContain("space_start_session");
    await settle();
    expect(await toolNames(harness, "thr_orch")).toContain("space_start_session");
  });

  it("drops the management tools of an orchestrator that moved once the cache has refreshed", async () => {
    const state = world();
    const harness = await withOrchestrator(state);
    await settle();
    expect(await toolNames(harness, "thr_orch")).toContain("space_start_session");
    state.threads = state.threads.map((thread) =>
      thread.id === "thr_orch" ? { ...thread, sectionId: "space_b" } : thread,
    );
    await toolNames(harness, "thr_orch");
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.threads.find((thread) => thread.id === "thr_orch"),
      lastAssistantText: null,
    } as never);
    expect(await toolNames(harness, "thr_orch")).not.toContain("space_start_session");
    await settle();
    expect(
      ((await harness.behavior.callRpc("listOrchestrators", {} as never)) as { threadIds: string[] }).threadIds,
    ).toEqual([]);
  });
});
