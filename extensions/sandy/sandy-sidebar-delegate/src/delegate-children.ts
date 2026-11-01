import type { PluginSidebarThread, PluginSidebarThreadIndicator } from "@sandy-sdk/plugin-sdk";

type ThreadStatus = PluginSidebarThread["status"];
type ThreadRuntimeDisplayStatus = PluginSidebarThread["runtimeStatus"];
type ThreadQueuedWork = PluginSidebarThread["queuedWork"];
type EnvironmentWorkspaceDisplayKind = NonNullable<
  NonNullable<PluginSidebarThread["environment"]>["workspaceDisplayKind"]
>;

/*
 * Fork addition (sandy-sidebar-delegate). Hidden delegate children and
 * workflows-plus workers never reach the host's sidebar thread array, so the
 * plugin server lists them (includeHidden) and the app merges them in here as
 * ordinary child rows. Everything below is pure: no React, no Node, no zod.
 */

/** Plugins whose threads are listed under the thread that started them. */
// "work" is the merged plugin (sandy/work); the old ids stay so children they started keep their parent.
export const DELEGATE_CHILD_ORIGIN_PLUGIN_IDS = ["work", "delegate", "workflows-plus"] as const;

/** The fields of sandy's thread list entry the sidebar needs to draw a child row. */
export interface DelegateChildRecord {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  originKind: "fork" | null;
  originPluginId: string | null;
  providerId: string;
  status: ThreadStatus;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
  queuedWork: ThreadQueuedWork;
  hasPendingInteraction: boolean;
  activity: {
    workflows: number;
    backgroundAgents: number;
    backgroundCommands: number;
    planMode: number;
    goals: number;
  };
  visibility: "hidden" | "visible";
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
  environment: {
    id: string | null;
    name: string | null;
    branchName: string | null;
    path: string | null;
    isWorktree: boolean | null;
    providerId: string | null;
    workspaceDisplayKind: EnvironmentWorkspaceDisplayKind;
  } | null;
}

function isDelegateChildOrigin(record: DelegateChildRecord): boolean {
  return (DELEGATE_CHILD_ORIGIN_PLUGIN_IDS as readonly (string | null)[]).includes(record.originPluginId);
}

/**
 * The thread a child hangs under: its parent, else the thread that owns its
 * lifecycle. Delegate children carry parentThreadId; workflows-plus workers
 * carry only lifecycleOwnerThreadId.
 */
export function delegateChildParentId(record: DelegateChildRecord): string | null {
  return record.parentThreadId ?? record.lifecycleOwnerThreadId;
}

function projectHref(projectId: string, threadId: string): string {
  const threadPath = `/threads/${encodeURIComponent(threadId)}`;
  return projectId === "proj_personal" ? threadPath : `/projects/${encodeURIComponent(projectId)}${threadPath}`;
}

function indicatorFor(record: DelegateChildRecord): PluginSidebarThreadIndicator {
  if (record.hasPendingInteraction) return "waiting-for-input";
  if (record.status === "error") return "unread-error";
  if (record.queuedWork === "failed") return "queued-failed";
  if (record.status === "active" || record.status === "starting") return "runtime";
  if (record.queuedWork === "waiting") return "queued-waiting";
  return "none";
}

const INDICATOR_LABELS: Partial<Record<PluginSidebarThreadIndicator, string>> = {
  "waiting-for-input": "Waiting for input",
  "unread-error": "Failed",
  "queued-failed": "Queued message failed",
  "queued-waiting": "Queued message waiting",
  runtime: "Working",
};

/** One of sandy's list entries as the sidebar row the host would have drawn for a visible thread. */
function delegateChildToSidebarThread(record: DelegateChildRecord, parentThreadId: string): PluginSidebarThread {
  const indicator = indicatorFor(record);
  const title = record.title ?? record.titleFallback;
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    titleFallback: record.titleFallback,
    displayTitle: title?.trim() ? title.trim() : "Untitled thread",
    parentThreadId,
    lifecycleOwnerThreadId: record.lifecycleOwnerThreadId,
    sourceThreadId: record.sourceThreadId,
    sectionId: null,
    originKind: record.originKind,
    originPluginId: record.originPluginId,
    providerId: record.providerId,
    status: record.status,
    runtimeStatus: record.runtimeDisplayStatus,
    queuedWork: record.queuedWork,
    hasPendingInteraction: record.hasPendingInteraction,
    activity: record.activity,
    indicator,
    indicatorLabel: INDICATOR_LABELS[indicator] ?? null,
    isUnread: record.lastReadAt !== null && record.latestAttentionAt > record.lastReadAt,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: record.archivedAt !== null,
    archivedAt: record.archivedAt,
    href: projectHref(record.projectId, record.id),
    isHidden: record.visibility === "hidden",
    environment: record.environment,
    host: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastReadAt: record.lastReadAt,
    latestAttentionAt: record.latestAttentionAt,
  };
}

/** A delegate child or worker row that has nothing left to show: not working, not asking, not failed, no queued work. */
function isFinishedDelegateChild(thread: PluginSidebarThread): boolean {
  return (
    thread.isHidden === true &&
    (DELEGATE_CHILD_ORIGIN_PLUGIN_IDS as readonly (string | null)[]).includes(thread.originPluginId) &&
    thread.indicator === "none" &&
    !thread.hasPendingInteraction &&
    thread.status !== "active" &&
    thread.status !== "starting"
  );
}

/**
 * The threads without finished hidden delegate children (setting "Hide
 * finished subagents"). Rows the host lists itself (a child the user revealed)
 * always stay. A finished child stays when it is the viewed thread, or when a
 * descendant stays, so a working worker under a finished child keeps its
 * parent row. The input is not changed; nothing hidden returns it as is.
 */
export function withoutFinishedDelegateChildren(
  threads: readonly PluginSidebarThread[],
  keepThreadId: string | null,
): readonly PluginSidebarThread[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const kept = new Set<string>();
  const keepWithAncestors = (startId: string) => {
    let currentId: string | null = startId;
    while (currentId !== null && !kept.has(currentId)) {
      kept.add(currentId);
      currentId = byId.get(currentId)?.parentThreadId ?? null;
    }
  };
  for (const thread of threads) {
    if (!isFinishedDelegateChild(thread)) keepWithAncestors(thread.id);
  }
  if (keepThreadId !== null && byId.has(keepThreadId)) keepWithAncestors(keepThreadId);
  if (kept.size === threads.length) return threads;
  return threads.filter((thread) => kept.has(thread.id));
}

/**
 * The host's threads plus the delegate children that belong under them.
 *
 * Rules, in order:
 * 1. Only threads of the delegate and workflows-plus plugins are considered.
 * 2. Archived children are dropped.
 * 3. A child needs a parent: parentThreadId, else lifecycleOwnerThreadId.
 *    One with neither stays out, because a root row would be unreachable
 *    from its parent.
 * 4. The parent chain must end at a thread the host lists and has not
 *    archived (a worker may sit under a delegate child). A missing, archived
 *    or cyclic chain drops the child instead of leaving an orphan row.
 * 5. A thread the host already lists keeps the host's row; when the host row
 *    has no parent yet, the child's parent is set so it nests too.
 * 6. Everything else is appended as a hidden row (isHidden) under its parent.
 *
 * The result is a new array; the input is not changed.
 */
export function mergeDelegateChildren(
  hostThreads: readonly PluginSidebarThread[],
  records: readonly DelegateChildRecord[],
): PluginSidebarThread[] {
  const hostById = new Map(hostThreads.map((thread) => [thread.id, thread]));
  const candidates = new Map<string, { record: DelegateChildRecord; parentId: string }>();
  for (const record of records) {
    if (!isDelegateChildOrigin(record) || record.archivedAt !== null) continue;
    const parentId = delegateChildParentId(record);
    if (parentId === null || parentId === record.id) continue;
    candidates.set(record.id, { record, parentId });
  }

  const reachesHostRoot = (startId: string): boolean => {
    const seen = new Set<string>();
    let currentId: string | undefined = startId;
    while (currentId !== undefined && !seen.has(currentId)) {
      seen.add(currentId);
      const hostThread = hostById.get(currentId);
      if (hostThread !== undefined && !candidates.has(currentId)) return !hostThread.isArchived;
      currentId = candidates.get(currentId)?.parentId ?? hostThread?.parentThreadId ?? undefined;
    }
    return false;
  };

  const merged = hostThreads.map((thread) => {
    const candidate = candidates.get(thread.id);
    if (candidate === undefined || thread.parentThreadId !== null || !reachesHostRoot(candidate.parentId))
      return thread;
    return { ...thread, parentThreadId: candidate.parentId };
  });
  for (const { record, parentId } of candidates.values()) {
    if (hostById.has(record.id) || !reachesHostRoot(parentId)) continue;
    merged.push(delegateChildToSidebarThread(record, parentId));
  }
  return merged;
}
