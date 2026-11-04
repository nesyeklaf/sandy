import type { ServerContext, ServerHandlers } from "./server-context";
import { DELEGATE_CHILDREN_CHANNEL } from "./contract";
import { DELEGATE_CHILD_ORIGIN_PLUGIN_IDS, type DelegateChildRecord } from "./delegate-children";

const PAGE_SIZE = 100;
// A bound on one listing: a runaway origin must not hold the RPC open forever.
const MAX_PAGES = 50;
// Events arrive in bursts (a worker fan-out creates dozens of threads); one
// publish per burst is enough for the app to refetch.
const PUBLISH_DEBOUNCE_MS = 250;
const STALE_AFTER_MS = 20_000;
const THREAD_IDS_PER_LOOKUP = 200;
const MAX_SYNC_ROUNDS = 3;

type ListedThread = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];

function toDelegateChildRecord(thread: ListedThread): DelegateChildRecord {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    parentThreadId: thread.parentThreadId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    sourceThreadId: thread.sourceThreadId,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    providerId: thread.providerId,
    status: thread.status,
    runtimeDisplayStatus: thread.runtime.displayStatus,
    queuedWork: thread.queuedWork,
    hasPendingInteraction: thread.hasPendingInteraction,
    activity: {
      workflows: thread.activity.activeWorkflowCount,
      backgroundAgents: thread.activity.activeBackgroundAgentCount,
      backgroundCommands: thread.activity.activeBackgroundCommandCount,
      planMode: thread.activity.activePlanModeCount,
      goals: thread.activity.activeGoalCount,
    },
    visibility: thread.visibility,
    archivedAt: thread.archivedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    environment:
      thread.environmentId === null
        ? null
        : {
            id: thread.environmentId,
            name: thread.environmentName,
            branchName: thread.environmentBranchName,
            path: thread.environmentPath,
            isWorktree: thread.environmentIsWorktree,
            providerId: thread.environmentProviderId,
            workspaceDisplayKind: thread.environmentWorkspaceDisplayKind,
          },
  };
}

export function createServerDelegateChildren(ctx: ServerContext) {
  const listOrigin = async (originPluginId: string): Promise<DelegateChildRecord[]> => {
    const records: DelegateChildRecord[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const threads = await ctx.sandy.sdk.threads.list({
        originPluginId,
        includeHidden: true,
        archived: false,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      records.push(...threads.map(toDelegateChildRecord));
      if (threads.length < PAGE_SIZE) break;
    }
    return records;
  };

  async function list(): Promise<DelegateChildRecord[]> {
    return (await Promise.all(DELEGATE_CHILD_ORIGIN_PLUGIN_IDS.map(listOrigin))).flat();
  }

  const isChildOrigin = (thread: { originPluginId: string | null }) =>
    (DELEGATE_CHILD_ORIGIN_PLUGIN_IDS as readonly (string | null)[]).includes(thread.originPluginId);

  let cache: Map<string, DelegateChildRecord> | null = null;
  let listedAt = 0;
  const dirty = new Set<string>();
  let running: Promise<void> | null = null;

  const run = (task: () => Promise<void>): Promise<void> => {
    const current: Promise<void> = task().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  };

  const takeDirty = (): string[] => {
    const ids = [...dirty];
    dirty.clear();
    return ids;
  };

  const relist = async (ids = takeDirty()) => {
    try {
      const records = await list();
      cache = new Map(records.map((record) => [record.id, record]));
      listedAt = Date.now();
    } catch (error) {
      for (const id of ids) dirty.add(id);
      if (cache !== null) listedAt = Date.now();
      throw error;
    }
  };

  const lookUp = async (target: Map<string, DelegateChildRecord>, ids: readonly string[]): Promise<boolean> => {
    for (let start = 0; start < ids.length; start += THREAD_IDS_PER_LOOKUP) {
      const chunk = ids.slice(start, start + THREAD_IDS_PER_LOOKUP);
      const requested = new Set(chunk);
      const threads = await ctx.sandy.sdk.threads.list({
        threadIds: chunk,
        includeHidden: true,
        archived: false,
        limit: chunk.length,
      });
      if (threads.some((thread) => !requested.has(thread.id))) return false;
      const found = new Map(
        threads.filter(isChildOrigin).map((thread) => [thread.id, toDelegateChildRecord(thread)] as const),
      );
      for (const id of chunk) {
        const record = found.get(id);
        if (record) target.set(id, record);
        else target.delete(id);
      }
    }
    return true;
  };

  const refreshDirty = async () => {
    const ids = takeDirty();
    try {
      if (cache === null || !(await lookUp(cache, ids))) await relist(ids);
    } catch (error) {
      for (const id of ids) dirty.add(id);
      throw error;
    }
  };

  const snapshot = () => JSON.stringify(cache === null ? null : [...cache.values()]);

  const revalidate = () => {
    const before = snapshot();
    void run(async () => {
      await relist();
      if (snapshot() !== before) publishSoon();
    }).catch((error) => {
      ctx.sandy.log.warn(
        `Delegate children relist failed; serving the last list: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const read = async (): Promise<DelegateChildRecord[]> => {
    for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
      if (running !== null) {
        if (cache === null) await running;
        else await running.catch(() => {});
      } else if (cache === null) await run(relist);
      else if (dirty.size > 0) await run(refreshDirty);
      else break;
    }
    if (cache === null) throw new Error("Delegate children are not listed yet");
    if (running === null && Date.now() - listedAt >= STALE_AFTER_MS) revalidate();
    return [...cache.values()];
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  function publishSoon() {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      ctx.sandy.realtime.publish(DELEGATE_CHILDREN_CHANNEL, {});
    }, PUBLISH_DEBOUNCE_MS);
  }
  const markDirty = (thread: { id: string }) => {
    if (cache !== null || running !== null) dirty.add(thread.id);
    publishSoon();
  };
  const watch = ({ thread }: { thread: { id: string; originPluginId: string | null } }) => {
    if (isChildOrigin(thread)) markDirty(thread);
  };
  const drop = ({ thread }: { thread: { id: string; originPluginId: string | null } }) => {
    if (!isChildOrigin(thread)) return;
    cache?.delete(thread.id);
    markDirty(thread);
  };

  ctx.sandy.events.on("thread.created", watch);
  ctx.sandy.events.on("thread.active", watch);
  ctx.sandy.events.on("thread.idle", watch);
  ctx.sandy.events.on("thread.failed", watch);
  ctx.sandy.events.on("thread.archived", drop);
  ctx.sandy.events.on("thread.unarchived", watch);
  ctx.sandy.events.on("thread.deleted", drop);
  ctx.sandy.events.on("interaction.pending", watch);
  ctx.sandy.events.on("experimental_thread.parentChanged", watch);

  const handlers = {
    async listDelegateChildren() {
      return { children: await read() };
    },
  } satisfies Pick<ServerHandlers, "listDelegateChildren">;

  return { handlers, list };
}
