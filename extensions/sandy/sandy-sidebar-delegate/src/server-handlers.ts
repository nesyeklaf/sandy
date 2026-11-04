import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle } from "./server-lifecycle";
import type { createThreadPortActions } from "./thread-ports";
import type { createServerProjectIcons } from "./server-project-icons";
import type { createServerProjectColors } from "./server-project-colors";
import type { createServerProjectManagement } from "./server-project-management";
import type { createServerSettleActions } from "./server-settle-actions";
import type { createServerDelegateChildren } from "./server-delegate-children";
import type { createServerSessionSearch } from "./server-session-search";
import type { createServerLastMessages } from "./server-last-messages";
import type { createServerTopics } from "./server-topics";
import type { createServerAnchors } from "./server-anchors";
import type { createServerBulkActions } from "./server-bulk-actions";
import type { createServerSettings } from "./server-settings";
import type { createServerPolicy } from "./server-policy";
import type { createServerSettleCleanup } from "./server-settle-cleanup";
import type { createPortDiscovery } from "./port-discovery";
import type { createThreadPullRequests } from "./thread-pull-requests";
import type { createTitleRegenerator } from "./regenerate-title";
import { SIDEBAR_SETTINGS_CHANNEL, INBOX_ORDER_CHANNEL } from "./contract";
import { runThreadTasks } from "./thread-tasks";

const CATALOG_TTL_MS = 5 * 60_000;

export function createServerHandlers(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  settings: Awaited<ReturnType<typeof createServerSettings>>,
  policy: ReturnType<typeof createServerPolicy>,
  cleanup: ReturnType<typeof createServerSettleCleanup>,
  threadPortActions: ReturnType<typeof createThreadPortActions>,
  getOpenPorts: ReturnType<typeof createPortDiscovery>,
  threadPullRequests: ReturnType<typeof createThreadPullRequests>,
  regenerateTitle: ReturnType<typeof createTitleRegenerator>,
  modules: {
    icons: ReturnType<typeof createServerProjectIcons>;
    colors: ReturnType<typeof createServerProjectColors>;
    projects: ReturnType<typeof createServerProjectManagement>;
    settle: ReturnType<typeof createServerSettleActions>;
    delegateChildren: ReturnType<typeof createServerDelegateChildren>;
    topics: ReturnType<typeof createServerTopics>;
    sessionSearch: ReturnType<typeof createServerSessionSearch>;
    lastMessages: ReturnType<typeof createServerLastMessages>;
    anchors: ReturnType<typeof createServerAnchors>;
    bulk: ReturnType<typeof createServerBulkActions>;
  },
) {
  const { readSidebarSettings, writeSidebarSettings } = settings;
  const { evaluatePolicies } = policy;
  const { reclaimThreadResources } = cleanup;
  const {
    readOne,
    readAll,
    serializeThreads,
    withPinParentChange,
    write,
    clear,
    readInboxOrder,
    replaceInboxOrder,
    wakeAncestors,
  } = lifecycle;

  const catalogs = new Map<string, { expiresAt: number; catalog: ReturnType<typeof ctx.sandy.sdk.providers.models> }>();
  const providerCatalog = (environmentId: string, providerId: string) => {
    const now = Date.now();
    for (const [key, entry] of catalogs) if (entry.expiresAt <= now) catalogs.delete(key);
    const key = JSON.stringify([environmentId, providerId]);
    const cached = catalogs.get(key);
    if (cached) return cached.catalog;
    const catalog = ctx.sandy.sdk.providers.models({ environmentId, providerId });
    catalogs.set(key, { expiresAt: now + CATALOG_TTL_MS, catalog });
    catalog.catch(() => {
      if (catalogs.get(key)?.catalog === catalog) catalogs.delete(key);
    });
    return catalog;
  };

  const handlers = {
    getOpenPorts,
    getThreadPorts: threadPortActions.getThreadPorts,
    getThreadPullRequests: threadPullRequests.getThreadPullRequests,
    async closeThreadPorts(input) {
      if (readOne(input.threadId)?.settledOverride !== "settled") {
        throw new Error("Thread is no longer settled");
      }
      try {
        return await threadPortActions.closeThreadPorts(input);
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async stopWorkspacePort({ threadId, port }) {
      try {
        return await threadPortActions.closeThreadPorts({ threadId, ports: [port], scope: "workspace" });
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async getThreadExecutionDetails({ threadId }) {
      const options = await ctx.sandy.sdk.threads.defaultExecutionOptions({ threadId });
      if (!options) return null;
      const details = { model: options.model, reasoningLevel: options.reasoningLevel };
      try {
        const thread = await ctx.sandy.sdk.threads.get({ threadId });
        if (!thread.environmentId) return details;
        const catalog = await providerCatalog(thread.environmentId, thread.providerId);
        const models = [...catalog.models, ...catalog.selectedOnlyModels];
        const model =
          models.find((entry) => entry.id === options.model) ?? models.find((entry) => entry.model === options.model);
        const modelDisplayName = model?.displayName.trim();
        const reasoningLabel = model?.supportedReasoningEfforts
          ?.find((effort) => effort.reasoningEffort === options.reasoningLevel)
          ?.label?.trim();
        return {
          ...details,
          ...(modelDisplayName ? { modelDisplayName } : {}),
          ...(reasoningLabel ? { reasoningLabel } : {}),
        };
      } catch {
        return details;
      }
    },
    async setThreadParent({ threadId, parentThreadId }) {
      return withPinParentChange(threadId, async () => {
        const thread = await ctx.sandy.sdk.threads.get({ threadId });
        if (parentThreadId === thread.parentThreadId) return { ok: true };
        await ctx.sandy.sdk.threads.update({ threadId, parentThreadId });
        const parentRow = parentThreadId == null ? null : readOne(parentThreadId);
        if (
          parentThreadId != null &&
          parentRow &&
          (parentRow.settledAt !== null || parentRow.parkedAt != null || parentRow.snoozedUntil !== null)
        )
          await wakeAncestors({ id: threadId, parentThreadId });
        if (parentThreadId != null && thread.pinnedAt != null) {
          try {
            await ctx.sandy.sdk.threads.unpin({ threadId });
          } catch (error) {
            ctx.sandy.log.error(
              `Parent updated but unpinning failed for thread ${threadId}, parent ${parentThreadId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { ok: true, unpinFailed: true as const };
          }
        }
        return { ok: true };
      });
    },
    async deleteThread({ threadId, childThreadsConfirmed }) {
      await ctx.sandy.sdk.threads.delete({ threadId, childThreadsConfirmed });
      return { ok: true };
    },
    regenerateTitle: ({ threadId }) => regenerateTitle(threadId),
    async getSidebarSettings() {
      return readSidebarSettings();
    },
    async updateSidebarSettings(values) {
      const stored = readSidebarSettings();
      const next = { ...stored, ...values };
      if (values.threadDensity !== undefined) next.compactWorkingThreads = values.threadDensity !== "comfortable";
      else if (values.compactWorkingThreads !== undefined)
        next.threadDensity = values.compactWorkingThreads ? "auto" : "comfortable";
      writeSidebarSettings(next);
      ctx.sandy.realtime.publish(SIDEBAR_SETTINGS_CHANNEL, {});
      if (
        next.autoSettleInactive !== stored.autoSettleInactive ||
        next.autoSettleAfterDays !== stored.autoSettleAfterDays ||
        next.autoSettleOnMerge !== stored.autoSettleOnMerge
      ) {
        policy.settingsChanged();
        void evaluatePolicies().catch((error) => {
          ctx.sandy.log.error(
            `Automatic settle evaluation failed after a settings change: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return readSidebarSettings();
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    async pin({ threadId }) {
      await modules.bulk.pinThread(threadId);
      return { ok: true };
    },
    async park({ threadId }) {
      await serializeThreads([threadId], async () => {
        await ctx.sandy.sdk.threads.unpin({ threadId });
        write({
          threadId,
          parkedAt: Date.now(),
          settledAt: null,
          settledOverride: null,
          snoozedUntil: null,
          snoozedAt: null,
        });
      });
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async resume({ threadId }) {
      await serializeThreads([threadId], async () =>
        write({
          threadId,
          settledAt: null,
          settledOverride: "active",
          snoozedUntil: null,
          snoozedAt: null,
        }),
      );
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil, deferredInteractionId }) {
      return { ok: true, reclaim: await modules.bulk.snoozeThread(threadId, snoozedUntil, deferredInteractionId) };
    },
    async releaseRuntimes({ threadIds }) {
      await runThreadTasks(
        threadIds,
        async (threadId) => {
          await ctx.sandy.sdk.threads.stop({ threadId });
        },
        4,
      );
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      await serializeThreads([threadId], async () => clear(threadId));
      return { ok: true };
    },
    async acknowledgeWake({ threadId }) {
      await serializeThreads([threadId], async () => clear(threadId));
      return { ok: true };
    },
    async reorderPinned({ threadId, previousThreadId, nextThreadId }) {
      const reordered = await ctx.sandy.sdk.threads.reorderPinned({
        threadId,
        previousThreadId,
        nextThreadId,
      });
      return {
        pinnedThreadIds: reordered.filter((thread) => thread.pinnedAt !== null).map((thread) => thread.id),
      };
    },
    async listInboxOrder() {
      return { inboxThreadIds: readInboxOrder() };
    },
    async reorderInbox({ inboxThreadIds }) {
      replaceInboxOrder(inboxThreadIds);
      ctx.sandy.realtime.publish(INBOX_ORDER_CHANNEL, {});
      return { inboxThreadIds: readInboxOrder() };
    },
    async evaluateAutoSettle() {
      return { changedThreadIds: await evaluatePolicies() };
    },
  } satisfies Pick<
    ServerHandlers,
    | "getOpenPorts"
    | "getThreadPorts"
    | "getThreadPullRequests"
    | "closeThreadPorts"
    | "stopWorkspacePort"
    | "getThreadExecutionDetails"
    | "setThreadParent"
    | "deleteThread"
    | "regenerateTitle"
    | "getSidebarSettings"
    | "updateSidebarSettings"
    | "listLifecycle"
    | "pin"
    | "park"
    | "resume"
    | "snooze"
    | "releaseRuntimes"
    | "unsnooze"
    | "acknowledgeWake"
    | "reorderPinned"
    | "listInboxOrder"
    | "reorderInbox"
    | "evaluateAutoSettle"
  >;

  return {
    ...cleanup.handlers,
    ...modules.settle.handlers,
    ...modules.colors.handlers,
    ...modules.icons.handlers,
    ...modules.projects.handlers,
    ...modules.delegateChildren.handlers,
    ...modules.topics.handlers,
    ...modules.sessionSearch.handlers,
    ...modules.lastMessages.handlers,
    ...modules.anchors.handlers,
    ...modules.bulk.handlers,
    ...handlers,
  } satisfies ServerHandlers;
}
