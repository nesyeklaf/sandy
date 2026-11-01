import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";
import { childStatusSummary, threadsWithAskingDescendants } from "./child-status";
import { visibleInboxThreads } from "./inbox";
import { delegateChildRecord, idleSidebarThreadFields } from "./test-fixtures";
import {
  type DelegateChildRecord,
  delegateChildParentId,
  mergeDelegateChildren,
  withoutFinishedDelegateChildren,
} from "./delegate-children";

function hostThread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    sectionId: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    ...overrides,
  } as PluginSidebarThread;
}

const record = delegateChildRecord;

const parent = hostThread("parent");

// One of each: hidden, revealed (visible), archived, needs-you, worker, plus
// strays that must stay out.
const fixture: DelegateChildRecord[] = [
  record("hidden-child"),
  record("visible-child", { visibility: "visible" }),
  record("archived-child", { archivedAt: 5 }),
  record("needs-you-child", { hasPendingInteraction: true }),
  record("worker", { originPluginId: "workflows-plus", parentThreadId: null, lifecycleOwnerThreadId: "parent" }),
  record("foreign-origin", { originPluginId: "someone-else" }),
  record("no-parent", { parentThreadId: null }),
  record("parent-gone", { parentThreadId: "deleted-thread" }),
];

const childrenOf = (threads: readonly PluginSidebarThread[], parentId: string) =>
  threads.filter((thread) => thread.parentThreadId === parentId).map((thread) => thread.id);

describe("delegateChildParentId", () => {
  it("uses the parent, else the lifecycle owner", () => {
    expect(delegateChildParentId(record("a", { parentThreadId: "x", lifecycleOwnerThreadId: "y" }))).toBe("x");
    expect(delegateChildParentId(record("a", { parentThreadId: null, lifecycleOwnerThreadId: "y" }))).toBe("y");
    expect(delegateChildParentId(record("a", { parentThreadId: null }))).toBeNull();
  });
});

describe("mergeDelegateChildren", () => {
  it("nests hidden, revealed, needs-you and worker children and drops the rest", () => {
    const merged = mergeDelegateChildren([parent], fixture);
    expect(childrenOf(merged, "parent").sort()).toEqual(
      ["hidden-child", "needs-you-child", "visible-child", "worker"].sort(),
    );
    expect(merged.map((thread) => thread.id)).not.toContain("archived-child");
    expect(merged.map((thread) => thread.id)).not.toContain("foreign-origin");
    expect(merged.map((thread) => thread.id)).not.toContain("no-parent");
    expect(merged.map((thread) => thread.id)).not.toContain("parent-gone");
  });

  it("marks hidden children as hidden and keeps the worker's origin", () => {
    const merged = mergeDelegateChildren([parent], fixture);
    const byId = new Map(merged.map((thread) => [thread.id, thread]));
    expect(byId.get("hidden-child")?.isHidden).toBe(true);
    expect(byId.get("visible-child")?.isHidden).toBe(false);
    expect(byId.get("worker")?.originPluginId).toBe("workflows-plus");
    expect(byId.get("worker")?.parentThreadId).toBe("parent");
  });

  it("leaves the host's own threads and rows untouched", () => {
    const other = hostThread("other", { parentThreadId: "parent" });
    const hostVisible = hostThread("visible-child", { parentThreadId: "parent", title: "host copy" });
    const hostThreads = [parent, other, hostVisible];
    const merged = mergeDelegateChildren(hostThreads, fixture);
    expect(merged.filter((thread) => thread.id === "visible-child")).toEqual([hostVisible]);
    expect(merged.slice(0, 3)).toEqual(hostThreads);
    expect(hostThreads).toHaveLength(3);
  });

  it("returns the host threads when there are no records", () => {
    expect(mergeDelegateChildren([parent], [])).toEqual([parent]);
  });

  it("nests a visible worker the host lists without a parent", () => {
    const hostWorker = hostThread("worker", { originPluginId: "workflows-plus" });
    const merged = mergeDelegateChildren([parent, hostWorker], fixture);
    expect(merged.find((thread) => thread.id === "worker")?.parentThreadId).toBe("parent");
    expect(merged.filter((thread) => thread.id === "worker")).toHaveLength(1);
  });

  it("drops children of an archived or unlisted parent", () => {
    const archivedParent = hostThread("parent", { isArchived: true });
    expect(mergeDelegateChildren([archivedParent], fixture)).toEqual([archivedParent]);
    expect(mergeDelegateChildren([], fixture)).toEqual([]);
  });

  it("nests a worker under a delegate child (two levels) and drops cycles", () => {
    const merged = mergeDelegateChildren(
      [parent],
      [
        record("hidden-child"),
        record("nested-worker", {
          originPluginId: "workflows-plus",
          parentThreadId: null,
          lifecycleOwnerThreadId: "hidden-child",
        }),
        record("cycle-a", { parentThreadId: "cycle-b" }),
        record("cycle-b", { parentThreadId: "cycle-a" }),
        record("self", { parentThreadId: "self" }),
      ],
    );
    expect(merged.map((thread) => thread.id).sort()).toEqual(["hidden-child", "nested-worker", "parent"]);
    expect(childrenOf(merged, "hidden-child")).toEqual(["nested-worker"]);
  });
});

describe("withoutFinishedDelegateChildren", () => {
  const ids = (threads: readonly PluginSidebarThread[]) => threads.map((thread) => thread.id).sort();

  it("drops finished hidden children and keeps working, asking, failed and queued ones", () => {
    const merged = mergeDelegateChildren(
      [parent],
      [
        record("done"),
        record("working", { status: "active" }),
        record("starting", { status: "starting" }),
        record("asks", { hasPendingInteraction: true }),
        record("failed", { status: "error" }),
        record("queued", { queuedWork: "waiting" }),
        record("done-worker", {
          originPluginId: "workflows-plus",
          parentThreadId: null,
          lifecycleOwnerThreadId: "parent",
        }),
      ],
    );
    expect(ids(withoutFinishedDelegateChildren(merged, null))).toEqual(
      ["asks", "failed", "parent", "queued", "starting", "working"].sort(),
    );
  });

  it("keeps a child the host lists itself and the host's own threads", () => {
    const hostVisible = hostThread("revealed", { parentThreadId: "parent", originPluginId: "delegate" });
    const plainChild = hostThread("fork", { parentThreadId: "parent" });
    const threads = [parent, hostVisible, plainChild];
    expect(withoutFinishedDelegateChildren(threads, null)).toBe(threads);
  });

  it("keeps the viewed finished child and a finished child whose worker still runs", () => {
    const merged = mergeDelegateChildren(
      [parent],
      [
        record("viewed"),
        record("other-done"),
        record("finished-mid"),
        record("running-worker", {
          originPluginId: "workflows-plus",
          parentThreadId: null,
          lifecycleOwnerThreadId: "finished-mid",
          status: "active",
        }),
      ],
    );
    expect(ids(withoutFinishedDelegateChildren(merged, "viewed"))).toEqual(
      ["finished-mid", "parent", "running-worker", "viewed"].sort(),
    );
    expect(ids(withoutFinishedDelegateChildren(merged, "unknown"))).toEqual(
      ["finished-mid", "parent", "running-worker"].sort(),
    );
  });
});

describe("merged children in the sidebar", () => {
  const merged = mergeDelegateChildren([parent], fixture);

  it("keeps hidden children out of the flat list", () => {
    expect(visibleInboxThreads(merged).map((thread) => thread.id)).toEqual(["parent", "visible-child"]);
  });

  it("shows needs-you on the parent only while a child waits on the user", () => {
    expect(threadsWithAskingDescendants(merged).has("parent")).toBe(true);
    const children = merged.filter((thread) => thread.parentThreadId === "parent");
    expect(childStatusSummary(children)).toMatchObject({ needsYou: 1, dominant: "needs-you" });

    const answered = mergeDelegateChildren([parent], [record("needs-you-child", { hasPendingInteraction: false })]);
    expect(threadsWithAskingDescendants(answered).has("parent")).toBe(false);
    expect(childStatusSummary(answered.filter((thread) => thread.parentThreadId === "parent")).dominant).toBeNull();
  });

  it("ignores an archived child's question", () => {
    const merged2 = mergeDelegateChildren([parent], [record("c", { hasPendingInteraction: true, archivedAt: 3 })]);
    expect(threadsWithAskingDescendants(merged2).has("parent")).toBe(false);
  });

  it("rolls a failed child up above a waiting one", () => {
    const merged3 = mergeDelegateChildren(
      [parent],
      [record("failed", { status: "error" }), record("asks", { hasPendingInteraction: true })],
    );
    expect(childStatusSummary(merged3.filter((thread) => thread.parentThreadId === "parent")).dominant).toBe("failed");
  });
});
