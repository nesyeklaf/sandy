import type { createServerLifecycle } from "./server-lifecycle";
import type { PluginRpcHandlers } from "@sandy-sdk/plugin-sdk";
import type { ServerContext } from "./server-context";
import type { spaceOverviewRpcContract } from "./contract-spaces";
import { lookUpPullRequestOutcomes } from "./server-space-pull-requests";
import { resolveShelf } from "./lifecycle";
import { blocksWorking, type OwnAttention } from "./working-fact";
import { buildSpaces, type SpaceThreadFacts } from "./spaces-model";

type ListedThread = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

function descendantsWhere(threads: readonly ListedThread[], matches: (thread: ListedThread) => boolean): Set<string> {
  const result = new Set<string>();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const thread of threads) {
    if (thread.parentThreadId === null || !matches(thread)) continue;
    const visited = new Set([thread.id]);
    let parent = byId.get(thread.parentThreadId);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      result.add(parent.id);
      parent = parent.parentThreadId === null ? undefined : byId.get(parent.parentThreadId);
    }
  }
  return result;
}

function ownAttention(thread: ListedThread): OwnAttention {
  const unread = thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt;
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    waitingForInput: thread.hasPendingInteraction,
    unreadError: thread.parentThreadId === null && thread.status === "error" && unread,
    queuedWork: thread.queuedWork,
  };
}

export function createServerSpaceOverview(
  ctx: ServerContext,
  lifecycle: Pick<ReturnType<typeof createServerLifecycle>, "readAll" | "threadSignals">,
  roles: { orchestratorSpaceOf(threadId: string): string | null },
) {
  async function listThreads(): Promise<ListedThread[]> {
    const threads: ListedThread[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await ctx.sandy.sdk.threads.list({
        includeHidden: true,
        archived: false,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      threads.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return threads;
  }

  const handlers = {
    async getSpaceOverview({ projectId }) {
      const now = Date.now();
      const [threads, sections] = await Promise.all([listThreads(), ctx.sandy.sdk.threadSections.list()]);
      const environmentIds = [
        ...new Set(threads.flatMap((thread) => (thread.environmentId ? [thread.environmentId] : []))),
      ];
      const pullRequests = await lookUpPullRequestOutcomes(ctx, environmentIds);
      const rows = new Map(lifecycle.readAll().map((row) => [row.threadId, row]));
      const orchestrators = new Set(
        threads
          .filter((thread) => {
            const storedSpaceId = roles.orchestratorSpaceOf(thread.id);
            return storedSpaceId !== null && storedSpaceId === thread.sectionId;
          })
          .map((thread) => thread.id),
      );
      const askingParents = descendantsWhere(threads, (thread) => thread.hasPendingInteraction);
      const unblockedParents = descendantsWhere(threads, (thread) => lifecycle.threadSignals(thread).hasUnblockedWork);
      const shelfOf = (thread: ListedThread) => {
        const row = rows.get(thread.id);
        if (
          thread.pinnedAt !== null &&
          row?.settledOverride !== "settled" &&
          row?.snoozedUntil == null &&
          row?.parkedAt == null
        ) {
          return "active";
        }
        const signals = lifecycle.threadSignals(thread);
        return resolveShelf(
          row,
          {
            ...signals,
            hasPendingInteraction: signals.hasPendingInteraction || askingParents.has(thread.id),
            hasUnblockedWork: signals.hasUnblockedWork || unblockedParents.has(thread.id),
          },
          now,
        );
      };
      const facts = ({ thread }: { thread: ListedThread }): SpaceThreadFacts => ({
        lifecycle: shelfOf(thread),
        asks: thread.hasPendingInteraction,
        failed: thread.status === "error" || thread.queuedWork === "failed",
        working: lifecycle.threadSignals(thread).isWorking && !blocksWorking(ownAttention(thread)),
        pr: thread.environmentId === null ? "none" : (pullRequests.outcomes.get(thread.environmentId) ?? "unknown"),
        orchestrator: orchestrators.has(thread.id),
        activityAt: Math.max(thread.latestAttentionAt, thread.updatedAt),
      });
      const spaces = buildSpaces({
        threads: threads.map((thread) => ({
          id: thread.id,
          parentThreadId: thread.parentThreadId,
          projectId: thread.projectId,
          sectionId: thread.sectionId,
          isArchived: thread.archivedAt !== null,
          isHidden: thread.visibility !== "visible",
          thread,
        })),
        sections: sections.map(({ id, name }) => ({ id, name })),
        facts,
        matches: projectId === undefined ? undefined : (thread) => thread.projectId === projectId,
        now,
        unassignedName: "No Space",
      });
      return { pullRequests: pullRequests.availability, spaces };
    },
  } satisfies PluginRpcHandlers<typeof spaceOverviewRpcContract>;
  return { handlers };
}
