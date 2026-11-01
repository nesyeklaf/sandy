import type { ServerContext, ServerHandlers } from "./server-context";
import { DELEGATE_CHILDREN_CHANNEL } from "./contract";
import { DELEGATE_CHILD_ORIGIN_PLUGIN_IDS, type DelegateChildRecord } from "./delegate-children";

const PAGE_SIZE = 100;
// A bound on one listing: a runaway origin must not hold the RPC open forever.
const MAX_PAGES = 50;
// Events arrive in bursts (a worker fan-out creates dozens of threads); one
// publish per burst is enough for the app to refetch.
const PUBLISH_DEBOUNCE_MS = 250;

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

/**
 * Hidden delegate children and workflows-plus workers, which the host's
 * sidebar thread array does not carry. Lists each origin plugin's unarchived
 * threads including hidden ones, and tells the app to refetch when such a
 * thread changes.
 */
export function createServerDelegateChildren(ctx: ServerContext) {
  async function list(): Promise<DelegateChildRecord[]> {
    const records: DelegateChildRecord[] = [];
    for (const originPluginId of DELEGATE_CHILD_ORIGIN_PLUGIN_IDS) {
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
    }
    return records;
  }

  let pending: ReturnType<typeof setTimeout> | null = null;
  const publishSoon = () => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      ctx.sandy.realtime.publish(DELEGATE_CHILDREN_CHANNEL, {});
    }, PUBLISH_DEBOUNCE_MS);
  };
  const isChildOrigin = (thread: { originPluginId: string | null }) =>
    (DELEGATE_CHILD_ORIGIN_PLUGIN_IDS as readonly (string | null)[]).includes(thread.originPluginId);
  const watch = ({ thread }: { thread: { originPluginId: string | null } }) => {
    if (isChildOrigin(thread)) publishSoon();
  };

  ctx.sandy.events.on("thread.created", watch);
  ctx.sandy.events.on("thread.active", watch);
  ctx.sandy.events.on("thread.idle", watch);
  ctx.sandy.events.on("thread.failed", watch);
  ctx.sandy.events.on("thread.archived", watch);
  ctx.sandy.events.on("thread.unarchived", watch);
  ctx.sandy.events.on("thread.deleted", watch);
  ctx.sandy.events.on("interaction.pending", watch);
  ctx.sandy.events.on("experimental_thread.parentChanged", watch);

  const handlers = {
    async listDelegateChildren() {
      return { children: await list() };
    },
  } satisfies Pick<ServerHandlers, "listDelegateChildren">;

  return { handlers, list };
}
