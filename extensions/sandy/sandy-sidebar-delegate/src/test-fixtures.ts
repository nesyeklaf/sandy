import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";
import type { DelegateChildRecord } from "./delegate-children";

/** A hidden delegate child of "parent", as the plugin server lists it. */
export function delegateChildRecord(id: string, overrides: Partial<DelegateChildRecord> = {}): DelegateChildRecord {
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
    runtimeDisplayStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    visibility: "hidden",
    archivedAt: null,
    createdAt: 10,
    updatedAt: 10,
    lastReadAt: null,
    latestAttentionAt: 10,
    environment: null,
    ...overrides,
  };
}

/**
 * Sidebar-thread fields no test here varies: an idle, visible, unpinned,
 * unarchived thread. Spread first in a factory so its own defaults and the
 * test's overrides win.
 */
export const idleSidebarThreadFields = {
  displayTitle: "",
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  pinnedAt: null,
  pinSortKey: null,
  archivedAt: null,
  href: "",
  isHidden: false,
} satisfies Partial<PluginSidebarThread>;

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
