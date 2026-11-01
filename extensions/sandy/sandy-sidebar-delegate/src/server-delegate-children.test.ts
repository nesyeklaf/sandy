import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./server-context";
import { createServerDelegateChildren } from "./server-delegate-children";

type Listed = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];

function listed(id: string, overrides: Partial<Listed> = {}): Listed {
  return {
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    parentThreadId: "parent",
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: "delegate",
    providerId: "pi",
    status: "idle",
    runtime: { displayStatus: "idle" },
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    visibility: "hidden",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    environmentId: null,
    ...overrides,
  } as Listed;
}

function fakeContext(listThreads: (args: Record<string, unknown>) => Listed[]) {
  const handlers = new Map<string, (event: { thread: { originPluginId: string | null } }) => void>();
  const published: string[] = [];
  const listCalls: Array<Record<string, unknown>> = [];
  const ctx = {
    sandy: {
      sdk: {
        threads: {
          list: async (args: Record<string, unknown>) => {
            listCalls.push(args);
            return listThreads(args);
          },
        },
      },
      events: { on: (name: string, handler: never) => void handlers.set(name, handler) },
      realtime: { publish: (channel: string) => void published.push(channel) },
    },
  } as unknown as ServerContext;
  return { ctx, handlers, published, listCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createServerDelegateChildren", () => {
  it("lists each origin plugin's unarchived threads including hidden ones", async () => {
    const { ctx, listCalls } = fakeContext(({ originPluginId }) =>
      originPluginId === "work"
        ? [listed("work-child", { originPluginId: "work" })]
        : originPluginId === "delegate"
          ? [listed("hidden-delegate")]
          : [
              listed("worker", {
                originPluginId: "workflows-plus",
                parentThreadId: null,
                lifecycleOwnerThreadId: "parent",
              }),
            ],
    );
    const { handlers } = createServerDelegateChildren(ctx);

    const { children } = await handlers.listDelegateChildren();
    expect(children.map((child) => child.id)).toEqual(["work-child", "hidden-delegate", "worker"]);
    expect(children[0]).toMatchObject({ originPluginId: "work" });
    expect(children[2]).toMatchObject({ originPluginId: "workflows-plus", lifecycleOwnerThreadId: "parent" });
    expect(listCalls.map((call) => call.originPluginId)).toEqual(["work", "delegate", "workflows-plus"]);
    for (const call of listCalls) expect(call).toMatchObject({ includeHidden: true, archived: false });
  });

  it("pages through a long listing", async () => {
    const all = Array.from({ length: 130 }, (_, index) => listed(`t${index}`));
    const { ctx } = fakeContext(({ originPluginId, offset, limit }) =>
      originPluginId === "delegate" ? all.slice(offset as number, (offset as number) + (limit as number)) : [],
    );
    const { list } = createServerDelegateChildren(ctx);
    expect(await list()).toHaveLength(130);
  });

  it("maps activity, runtime and environment to the record", async () => {
    const { ctx } = fakeContext(({ originPluginId }) =>
      originPluginId === "delegate"
        ? [
            listed("busy", {
              status: "active",
              hasPendingInteraction: true,
              runtime: { displayStatus: "active" },
              activity: {
                activeWorkflowCount: 1,
                activeBackgroundAgentCount: 2,
                activeBackgroundCommandCount: 3,
                activePlanModeCount: 4,
                activeGoalCount: 5,
              },
              environmentId: "env1",
              environmentName: "main",
              environmentBranchName: "b",
              environmentPath: "/w",
              environmentIsWorktree: false,
              environmentProviderId: "local",
              environmentWorkspaceDisplayKind: "other",
            } as Partial<Listed>),
          ]
        : [],
    );
    const [record] = await createServerDelegateChildren(ctx).list();
    expect(record).toMatchObject({
      status: "active",
      runtimeDisplayStatus: "active",
      hasPendingInteraction: true,
      activity: { workflows: 1, backgroundAgents: 2, backgroundCommands: 3, planMode: 4, goals: 5 },
      environment: { id: "env1", name: "main", branchName: "b", path: "/w", workspaceDisplayKind: "other" },
    });
  });

  it("publishes one realtime update per burst of changes to delegate or worker threads only", () => {
    vi.useFakeTimers();
    const { ctx, handlers, published } = fakeContext(() => []);
    createServerDelegateChildren(ctx);

    handlers.get("thread.created")?.({ thread: { originPluginId: "delegate" } });
    handlers.get("thread.idle")?.({ thread: { originPluginId: "workflows-plus" } });
    handlers.get("interaction.pending")?.({ thread: { originPluginId: "delegate" } });
    handlers.get("thread.created")?.({ thread: { originPluginId: "other-plugin" } });
    handlers.get("thread.created")?.({ thread: { originPluginId: null } });
    expect(published).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(published).toEqual(["delegate-children"]);

    handlers.get("thread.archived")?.({ thread: { originPluginId: "delegate" } });
    vi.advanceTimersByTime(300);
    expect(published).toEqual(["delegate-children", "delegate-children"]);
  });

  it("listens for every thread change that moves a child row", () => {
    const { ctx, handlers } = fakeContext(() => []);
    createServerDelegateChildren(ctx);
    expect([...handlers.keys()].sort()).toEqual(
      [
        "experimental_thread.parentChanged",
        "interaction.pending",
        "thread.active",
        "thread.archived",
        "thread.created",
        "thread.deleted",
        "thread.failed",
        "thread.idle",
        "thread.unarchived",
      ].sort(),
    );
  });
});
