import { describe, expect, it } from "vitest";
import { SPACE_MEMBERS_LISTED_MAX } from "./space-coordination-contract";
import { loadSpacePlugin, spaceThread, type SpaceWorld } from "./test-space-server";

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;

const call = (harness: Harness, method: string, input: unknown) => harness.behavior.callRpc(method, input as never);
const tool = (harness: Harness, name: string, input: unknown, threadId = "thr_orch") =>
  harness.behavior.callAgentTool(name, input as never, { threadId } as never);

function world(): SpaceWorld {
  return {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [spaceThread("thr_orch", "space_a"), spaceThread("thr_m", "space_a"), spaceThread("thr_b", "space_b")],
  };
}

function manyMembers(count: number): SpaceWorld {
  const state = world();
  state.threads = Array.from({ length: count }, (_, index) => spaceThread("m" + index, "space_a"));
  return state;
}

async function startHarness(state: SpaceWorld) {
  const spawned: Array<Record<string, unknown>> = [];
  const harness = await loadSpacePlugin(state, {
    spawn: async (args: Record<string, unknown>) => {
      spawned.push(args);
      const thread = spaceThread("thr_new" + spawned.length, args.sectionId as string);
      state.threads.push(thread);
      return thread;
    },
  });
  await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
  return { harness, spawned };
}

const START = { projectId: "p", title: "t", prompt: "go" };

describe("space_start_session", () => {
  describe("reusing an environment", () => {
    function envWorld(): SpaceWorld {
      return {
        sections: [
          { id: "space_a", name: "Alpha" },
          { id: "space_b", name: "Beta" },
        ],
        threads: [
          spaceThread("thr_orch", "space_a", { environmentId: "env_orch" }),
          spaceThread("thr_managed", "space_a", { environmentId: "env_managed" }),
          spaceThread("thr_indep", "space_a", { environmentId: "env_indep" }),
          spaceThread("thr_foreign", "space_b", { environmentId: "env_foreign" }),
        ],
      };
    }
    const reuse = (environmentId: string) => ({ ...START, environment: { type: "reuse", environmentId } });

    it("allows the caller's own and a managed member's environment", async () => {
      const { harness, spawned } = await startHarness(envWorld());
      await call(harness, "setMemberMode", { threadId: "thr_managed", mode: "managed" });
      expect(await tool(harness, "space_start_session", reuse("env_orch"))).not.toMatchObject({ isError: true });
      expect(await tool(harness, "space_start_session", reuse("env_managed"))).not.toMatchObject({ isError: true });
      expect(spawned).toHaveLength(2);
    });

    it.each(["env_indep", "env_foreign", "env_unknown"])("refuses %s before it spawns", async (environmentId) => {
      const { harness, spawned } = await startHarness(envWorld());
      await call(harness, "setMemberMode", { threadId: "thr_managed", mode: "managed" });
      const result = await tool(harness, "space_start_session", reuse(environmentId));
      expect(result).toMatchObject({ isError: true });
      expect(spawned).toHaveLength(0);
    });
  });

  it("refuses an unknown idea before it starts anything", async () => {
    const { harness, spawned } = await startHarness(world());
    const result = await tool(harness, "space_start_session", { ...START, ideaId: "missing" });
    expect(result).toMatchObject({ isError: true });
    expect(spawned).toHaveLength(0);
  });

  it("refuses an idea of another Space before it starts anything", async () => {
    const { harness, spawned } = await startHarness(world());
    const idea = (await call(harness, "createIdea", { spaceId: "space_b", title: "foreign" })) as { id: string };
    const result = await tool(harness, "space_start_session", { ...START, ideaId: idea.id });
    expect(result).toMatchObject({ isError: true });
    expect(spawned).toHaveLength(0);
  });

  it("names the created session when a step after the start fails", async () => {
    const { harness, spawned } = await startHarness(world());
    const idea = (await call(harness, "createIdea", { spaceId: "space_a", title: "ok" })) as { id: string };
    harness.sidebarDb.prepare("DROP TABLE space_managed_members").run();
    const result = await tool(harness, "space_start_session", { ...START, ideaId: idea.id });
    expect(spawned).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("thr_new1");
    expect(JSON.stringify(result)).toContain("Do not start it again");
  });

  it.each([
    [{ type: "project-default" }],
    [{ type: "reuse", environmentId: "env_1" }],
    [{ type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }],
    [{ type: "host", workspace: { type: "personal" } }],
  ])("passes the environment selector %j to the SDK and keeps the session flat", async (environment) => {
    const state = world();
    state.threads[0] = spaceThread("thr_orch", "space_a", { environmentId: "env_1" });
    const { harness, spawned } = await startHarness(state);
    const result = await tool(harness, "space_start_session", { ...START, environment });
    expect(JSON.stringify(result)).toContain("thr_new1");
    expect(spawned[0]).toMatchObject({ environment, sectionId: "space_a" });
    expect(spawned[0]).not.toHaveProperty("parentThreadId");
  });

  it("defaults to the project environment", async () => {
    const { harness, spawned } = await startHarness(world());
    await tool(harness, "space_start_session", START);
    expect(spawned[0]).toMatchObject({ environment: { type: "project-default" } });
  });

  it("rejects an unknown selector without starting anything", async () => {
    const { harness, spawned } = await startHarness(world());
    const outcome = await tool(harness, "space_start_session", { ...START, environment: { type: "teleport" } }).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(JSON.stringify(outcome) + String(outcome)).toMatch(/environment|invalid/i);
    expect(spawned).toHaveLength(0);
  });
});

describe("member listing", () => {
  it("returns the maximum and marks the context truncated instead of failing", async () => {
    const harness = await loadSpacePlugin(manyMembers(SPACE_MEMBERS_LISTED_MAX + 1));
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      members: unknown[];
      membersTruncated: boolean;
    };
    expect(context.members).toHaveLength(SPACE_MEMBERS_LISTED_MAX);
    expect(context.membersTruncated).toBe(true);
  });

  it("is not truncated at exactly the maximum", async () => {
    const harness = await loadSpacePlugin(manyMembers(SPACE_MEMBERS_LISTED_MAX));
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      members: unknown[];
      membersTruncated: boolean;
    };
    expect(context.members).toHaveLength(SPACE_MEMBERS_LISTED_MAX);
    expect(context.membersTruncated).toBe(false);
  });

  it("carries the activity facts that drive the shelves", async () => {
    const state = world();
    state.threads = state.threads.map((thread) =>
      thread.id === "thr_m"
        ? {
            ...thread,
            queuedWork: "failed",
            activity: {
              activeWorkflowCount: 1,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 0,
              activeGoalCount: 2,
            },
          }
        : thread,
    );
    const harness = await loadSpacePlugin(state);
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      members: Array<{ threadId: string; queuedWork: string; activity: Record<string, number> }>;
    };
    const member = context.members.find((entry) => entry.threadId === "thr_m");
    expect(member?.queuedWork).toBe("failed");
    expect(member?.activity).toMatchObject({ activeWorkflowCount: 1, activeGoalCount: 2 });
  });
});

describe("orchestrator role after a move", () => {
  it("drops the role from the listing and the management tools once the session left its Space", async () => {
    const state = world();
    const harness = await loadSpacePlugin(state);
    await call(harness, "setOrchestrator", { threadId: "thr_orch", orchestrator: true });
    state.threads = state.threads.map((thread) => (thread.id === "thr_orch" ? { ...thread, sectionId: null } : thread));
    const listed = (await call(harness, "listOrchestrators", {})) as { threadIds: string[] };
    expect(listed.threadIds).not.toContain("thr_orch");
    const configuration = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "thr_orch", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "p" },
    } as never);
    expect(configuration.tools.map((entry) => entry.name)).not.toContain("space_start_session");
  });
});
