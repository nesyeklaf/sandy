import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./server-context";
import { createServerDelegateChildren } from "./server-delegate-children";

type Listed = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];
type ListArgs = NonNullable<Parameters<ServerContext["sandy"]["sdk"]["threads"]["list"]>[0]>;
type Handler = (event: { thread: { id: string; originPluginId: string | null } }) => void;

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

function fakeSdk(initial: Listed[], options: { ignoreThreadIds?: boolean } = {}) {
  const threads = new Map(initial.map((thread) => [thread.id, thread]));
  const calls: ListArgs[] = [];
  const handlers = new Map<string, Handler>();
  const published: string[] = [];
  const warnings: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failNext = 0;
  const ctx = {
    sandy: {
      sdk: {
        threads: {
          list: async (args: ListArgs) => {
            calls.push(args);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            if (failNext > 0) {
              failNext -= 1;
              throw new Error("read ECONNRESET");
            }
            const ids = args.threadIds && !options.ignoreThreadIds ? new Set(args.threadIds) : null;
            const matching = [...threads.values()].filter(
              (thread) =>
                (ids === null || ids.has(thread.id)) &&
                (args.originPluginId === undefined || thread.originPluginId === args.originPluginId) &&
                (args.archived !== false || thread.archivedAt === null),
            );
            const offset = args.offset ?? 0;
            return matching.slice(offset, offset + (args.limit ?? 50));
          },
        },
      },
      events: { on: (name: string, handler: Handler) => void handlers.set(name, handler) },
      realtime: { publish: (channel: string) => void published.push(channel) },
      log: { warn: (message: string) => void warnings.push(message), error: () => {}, info: () => {} },
    },
  } as unknown as ServerContext;
  const emit = (name: string, thread: Listed) => handlers.get(name)?.({ thread });
  return {
    ctx,
    threads,
    calls,
    emit,
    published,
    warnings,
    maxInFlight: () => maxInFlight,
    failNextCalls: (count: number) => {
      failNext = count;
    },
  };
}

const origins = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    listed(`t${index}`, { originPluginId: ["work", "delegate", "workflows-plus"][index % 3] }),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("delegate children cache", () => {
  it("shares one listing between concurrent callers and lists the origins in parallel", async () => {
    const sdk = fakeSdk(origins(30));
    const { handlers } = createServerDelegateChildren(sdk.ctx);

    const results = await Promise.all(Array.from({ length: 10 }, () => handlers.listDelegateChildren()));

    expect(sdk.calls).toHaveLength(3);
    expect(sdk.maxInFlight()).toBe(3);
    for (const result of results) expect(result.children).toHaveLength(30);
  });

  it("answers repeat calls from the cache", async () => {
    const sdk = fakeSdk(origins(9));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    for (let index = 0; index < 5; index += 1) await handlers.listDelegateChildren();
    expect(sdk.calls).toHaveLength(3);
  });

  it("folds a burst of 50 thread events into one targeted lookup for every caller", async () => {
    const sdk = fakeSdk(origins(6));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    sdk.calls.length = 0;

    for (let index = 0; index < 50; index += 1) {
      const thread = listed(`new${index}`);
      sdk.threads.set(thread.id, thread);
      sdk.emit(index % 2 === 0 ? "thread.created" : "thread.active", thread);
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => handlers.listDelegateChildren()));

    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]).toMatchObject({ includeHidden: true, archived: false });
    expect(sdk.calls[0]?.threadIds).toHaveLength(50);
    for (const result of results) expect(result.children).toHaveLength(56);
  });

  it("drops an archived or deleted child and picks up changed fields", async () => {
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();

    const archived = { ...sdk.threads.get("t0")!, archivedAt: 5 };
    sdk.threads.set("t0", archived);
    sdk.emit("thread.archived", archived);
    const deleted = sdk.threads.get("t1")!;
    sdk.threads.delete("t1");
    sdk.emit("thread.deleted", deleted);
    const busy = { ...sdk.threads.get("t2")!, status: "active" } as Listed;
    sdk.threads.set("t2", busy);
    sdk.emit("thread.active", busy);

    const { children } = await handlers.listDelegateChildren();
    expect(children.map((child) => [child.id, child.status])).toEqual([["t2", "active"]]);
  });

  it("ignores threads from other origins", async () => {
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    sdk.calls.length = 0;
    sdk.emit("thread.created", listed("plain", { originPluginId: null }));
    await handlers.listDelegateChildren();
    expect(sdk.calls).toHaveLength(0);
  });

  it("relists in the background once the cache is stale and publishes when the list changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    sdk.threads.set("t0", { ...sdk.threads.get("t0")!, hasPendingInteraction: true });
    vi.setSystemTime(Date.now() + 21_000);
    sdk.calls.length = 0;

    const stale = await handlers.listDelegateChildren();
    expect(stale.children.find((child) => child.id === "t0")?.hasPendingInteraction).toBe(false);
    await vi.waitFor(() => expect(sdk.published).toEqual(["delegate-children"]));
    expect(sdk.calls).toHaveLength(3);
    const fresh = await handlers.listDelegateChildren();
    expect(fresh.children.find((child) => child.id === "t0")?.hasPendingInteraction).toBe(true);
    expect(sdk.calls).toHaveLength(3);
  });

  it("keeps the cached list and logs when a background relist fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    vi.setSystemTime(Date.now() + 21_000);
    sdk.failNextCalls(3);

    expect((await handlers.listDelegateChildren()).children).toHaveLength(3);
    await vi.waitFor(() => expect(sdk.warnings).toHaveLength(1));
    expect(sdk.published).toEqual([]);
  });

  it("rejects the first listing when it fails and recovers on the next call", async () => {
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    sdk.failNextCalls(1);
    await expect(handlers.listDelegateChildren()).rejects.toThrow("ECONNRESET");
    expect((await handlers.listDelegateChildren()).children).toHaveLength(3);
  });

  it("retries a failed targeted lookup on the next call", async () => {
    const sdk = fakeSdk(origins(3));
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    const thread = listed("late");
    sdk.threads.set(thread.id, thread);
    sdk.emit("thread.created", thread);
    sdk.failNextCalls(1);
    await expect(handlers.listDelegateChildren()).rejects.toThrow("ECONNRESET");
    expect((await handlers.listDelegateChildren()).children.map((child) => child.id)).toContain("late");
  });

  it("falls back to a full listing on a host that ignores the thread id filter", async () => {
    const sdk = fakeSdk(origins(3), { ignoreThreadIds: true });
    const { handlers } = createServerDelegateChildren(sdk.ctx);
    await handlers.listDelegateChildren();
    const thread = listed("late");
    sdk.threads.set(thread.id, thread);
    sdk.emit("thread.created", thread);
    const { children } = await handlers.listDelegateChildren();
    expect(children.map((child) => child.id).sort()).toEqual(["late", "t0", "t1", "t2"]);
  });
});
