// The plugin's adapters to SANDY: the LaunchHost of sandy_delegate and the WatchdogHost of the sweep, over the
// plugin API. They share the set of delegation ids whose spawn is in flight in this process, so the
// watchdog never releases a reservation whose spawn may still create a thread.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { DELEGATE_PROVIDER, type LaunchHost } from "./launch.ts";
import { metadataDelegationId } from "./protocol.ts";
import { QUESTION_RENDERER, type FormResult, type QuestionHost } from "./ask.ts";
import type { FailureRecord, StatusHost, UsageSnapshot } from "./status.ts";
import type { WaitHost } from "./wait.ts";
import type { SpawnCandidate, TurnEvent, WatchdogHost } from "./watchdog.ts";
import type { WorkerCandidate, WorkerSweepHost } from "./workers.ts";
import type { WorkersLink } from "../../workers-link.ts";
import { findProject } from "../../project-target.ts";

export const BIND_DELAY_KEY = "debug.bindDelayMs";

// The SDK's batch limit for thread id lists.
const THREAD_BATCH = 200;
// The reconcile lists at most this many pages (THREAD_BATCH each) of the project's live workflows-plus
// threads; past it the listing is incomplete and the reservation keeps its slot.
const WORKER_LIST_PAGES = 10;

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

// The part of the plugin API the adapters use.
export type SandyHostApi = {
  readonly pluginId: string;
  readonly sdk: {
    providers: Pick<SandyPluginApi["sdk"]["providers"], "list">;
    environments: Pick<SandyPluginApi["sdk"]["environments"], "get">;
    projects: Pick<SandyPluginApi["sdk"]["projects"], "list">;
    threads: Pick<
      SandyPluginApi["sdk"]["threads"],
      "get" | "list" | "spawn" | "send" | "stop" | "update" | "output" | "defaultExecutionOptions" | "experimental_listAncestors" | "experimental_listDescendants" | "experimental_listPluginMetadata"
    > & { events: Pick<SandyPluginApi["sdk"]["threads"]["events"], "list"> };
  };
  readonly storage: { kv: Pick<SandyPluginApi["storage"]["kv"], "get"> };
  readonly log: Pick<SandyPluginApi["log"], "warn">;
  readonly ui: Pick<SandyPluginApi["ui"], "requestInput">;
};


const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function createSandyHosts(sandy: SandyHostApi, workers: Pick<WorkersLink, "workflows"> = { workflows: null }): { launchHost: LaunchHost; watchdogHost: WatchdogHost & WorkerSweepHost; waitHost: WaitHost; controlHost: QuestionHost; statusHost: StatusHost } {
  const spawnsInFlight = new Set<string>();
  const waitsInFlight = new Map<string, number>();
  const setParentNotifications = async (threadId: string, mode: "auto" | "off") => {
    await sandy.sdk.threads.update({ threadId, parentNotifications: mode });
  };

  // The top of the thread's parent chain (the thread itself when it has no parent).
  const rootOf = async (threadId: string): Promise<string> => {
    const { threads } = await sandy.sdk.threads.experimental_listAncestors({ threadIds: [threadId] });
    const ancestors = threads.find((entry) => entry.threadId === threadId)?.ancestorIds ?? [];
    return ancestors.length === 0 ? threadId : ancestors[ancestors.length - 1];
  };

  // SANDY's thread, or null when SANDY answers 404 (unknown or deleted thread).
  const threadOrNull = async (threadId: string) => {
    try {
      return await sandy.sdk.threads.get({ threadId });
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  };

  // One listing of the thread's turn/started and turn/completed events; null when SANDY answers 404.
  const turnEventList = async (threadId: string, page: { order: "asc" | "desc"; limit: string; afterSeq?: string }): Promise<TurnEvent[] | null> => {
    try {
      const rows = await sandy.sdk.threads.events.list({ threadId, types: ["turn/started", "turn/completed"], ...page });
      return rows.map((event): TurnEvent => {
        if (event.type !== "turn/completed") return { seq: event.seq, type: "started", at: event.createdAt };
        const data = event.data as { status?: unknown; error?: { message?: unknown } };
        return {
          seq: event.seq, type: "completed", at: event.createdAt,
          ...(typeof data.status === "string" ? { outcome: data.status } : {}),
          ...(typeof data.error?.message === "string" ? { error: data.error.message } : {}),
        };
      });
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  };

  const launchHost: LaunchHost = {
    spawnsInFlight,
    async piProvider() {
      const provider = (await sandy.sdk.providers.list()).find((entry) => entry.id === DELEGATE_PROVIDER);
      return provider === undefined ? null : { available: provider.available, permissionModes: [...provider.capabilities.permissionModes] };
    },
    async thread(threadId) {
      const thread = await sandy.sdk.threads.get({ threadId });
      return { id: thread.id, projectId: thread.projectId, environmentId: thread.environmentId };
    },
    rootOf,
    async permissionModeOf(threadId) {
      return (await sandy.sdk.threads.defaultExecutionOptions({ threadId }))?.permissionMode ?? null;
    },
    async environment(environmentId) {
      const env = await sandy.sdk.environments.get({ environmentId });
      return { hostId: env.hostId, isGitRepo: env.isGitRepo, branchName: env.branchName };
    },
    async project(ref) {
      return findProject(await sandy.sdk.projects.list({ includePersonal: true }), ref);
    },
    async spawn(request) {
      const child = await sandy.sdk.threads.spawn(request as Parameters<typeof sandy.sdk.threads.spawn>[0]);
      return { id: child.id };
    },
    async bindDelayMs() {
      return (await sandy.storage.kv.get<number>(BIND_DELAY_KEY)) ?? 0;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const watchdogHost: WatchdogHost & WorkerSweepHost = {
    rootOf,
    workerPluginId: sandy.pluginId,
    // workflows-plus workers of the origin, with their workflows-plus metadata. A worker is a
    // hidden thread whose lifecycle owner is the origin (parentThreadId null, live SANDY 0.47), so it is not
    // among the origin's descendants: a named thread is read directly; otherwise this plugin's unarchived
    // threads of every project are listed (no SDK filter by lifecycle owner; a writer with project runs in
    // another project than its origin) and those the origin owns or parents are kept. null (unknown, never "none") when SANDY does not have the origin or the listing
    // exceeds WORKER_LIST_PAGES.
    async workerCandidates(originThreadId, threadId) {
      if (threadId !== undefined) {
        const thread = await threadOrNull(threadId);
        if (thread === null || (thread.lifecycleOwnerThreadId !== originThreadId && thread.parentThreadId !== originThreadId)) return [];
        const { threads: withMetadata } = await sandy.sdk.threads.experimental_listPluginMetadata({ pluginId: sandy.pluginId, threadIds: [threadId] });
        return withMetadata.map(({ metadata }) => ({ threadId, originPluginId: thread.originPluginId, createdAt: thread.createdAt, metadata }));
      }
      const origin = await threadOrNull(originThreadId);
      if (origin === null) return null;
      const owned = new Map<string, { originPluginId: string | null; createdAt: number }>();
      for (let page = 0; ; page += 1) {
        if (page === WORKER_LIST_PAGES) return null;
        const threads = await sandy.sdk.threads.list({
          originPluginId: sandy.pluginId, includeHidden: true, archived: false,
          limit: THREAD_BATCH, offset: page * THREAD_BATCH,
        });
        for (const thread of threads) {
          if (thread.lifecycleOwnerThreadId === originThreadId || thread.parentThreadId === originThreadId) {
            owned.set(thread.id, { originPluginId: thread.originPluginId, createdAt: thread.createdAt });
          }
        }
        if (threads.length < THREAD_BATCH) break;
      }
      const candidates: WorkerCandidate[] = [];
      for (const batch of chunks([...owned.keys()], THREAD_BATCH)) {
        const { threads: withMetadata } = await sandy.sdk.threads.experimental_listPluginMetadata({ pluginId: sandy.pluginId, threadIds: batch });
        for (const { threadId, metadata } of withMetadata) candidates.push({ threadId, ...owned.get(threadId)!, metadata });
      }
      return candidates;
    },
    pluginId: sandy.pluginId,
    async spawnCandidates(parentThreadId, delegationId) {
      const { threads } = await sandy.sdk.threads.experimental_listDescendants({ threadIds: [parentThreadId], includeHidden: true, includeArchived: true });
      const parent = threads.find((entry) => entry.threadId === parentThreadId);
      if (parent === undefined) return null;
      const named: { threadId: string; metadata: Readonly<Record<string, unknown>> }[] = [];
      for (const batch of chunks(parent.descendantIds, THREAD_BATCH)) {
        const { threads: withMetadata } = await sandy.sdk.threads.experimental_listPluginMetadata({ pluginId: sandy.pluginId, threadIds: batch });
        named.push(...withMetadata.filter((entry) => metadataDelegationId(entry.metadata) === delegationId));
      }
      const candidates: SpawnCandidate[] = [];
      for (const { threadId, metadata } of named) {
        const thread = await threadOrNull(threadId);
        if (thread === null) continue;
        candidates.push({ threadId, parentThreadId: thread.parentThreadId, originPluginId: thread.originPluginId, createdAt: thread.createdAt, metadata });
      }
      return candidates;
    },
    spawnInFlight: (delegationId) => spawnsInFlight.has(delegationId),
    waitInFlight: (delegationId) => (waitsInFlight.get(delegationId) ?? 0) > 0,
    setParentNotifications,
    async stop(threadId) {
      await sandy.sdk.threads.stop({ threadId });
    },
    async threadState(threadId) {
      const thread = await threadOrNull(threadId);
      return thread === null ? null : { status: thread.status, archived: thread.archivedAt !== null };
    },
    // The workflows part's answer through the link; null when it is not loaded.
    async workerCallRunning(call) {
      return workers.workflows === null ? null : workers.workflows.callRunning(call);
    },
    async firstTurnStartedAt(threadId) {
      try {
        const [first] = await sandy.sdk.threads.events.list({ threadId, types: ["turn/started"], order: "asc", limit: "1" });
        return first?.createdAt ?? null;
      } catch (error) {
        if ((error as { status?: unknown }).status === 404) return null;
        throw error;
      }
    },
    turnEventsAfter: (threadId, afterSeq, limit) => turnEventList(threadId, {
      order: "asc", limit: String(limit), ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
    }),
    async latestTurnEvents(threadId, count) {
      return (await turnEventList(threadId, { order: "desc", limit: String(count) }))?.reverse() ?? null;
    },
  };

  const waitHost: WaitHost = {
    threadState: watchdogHost.threadState,
    latestTurnEvents: watchdogHost.latestTurnEvents,
    async output(threadId) {
      return (await sandy.sdk.threads.output({ threadId })).output;
    },
    waitsInFlight,
    setParentNotifications,
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
  };

  const controlHost: QuestionHost = {
    stop: watchdogHost.stop,
    threadState: watchdogHost.threadState,
    latestTurnEvents: watchdogHost.latestTurnEvents,
    turnEventsAfter: watchdogHost.turnEventsAfter,
    deliveriesInFlight: new Set<string>(),
    answerWaiters: new Map(),
    questionForms: new Map(),
    warn: (line) => sandy.log.warn(line),
    async requestInput(request, signal) {
      return (await sandy.ui.requestInput({ ...request, rendererId: QUESTION_RENDERER }, { signal })) as FormResult;
    },
    async send(threadId, message, mode) {
      const sent = await sandy.sdk.threads.send({
        threadId, mode: mode === "steer" ? "steer-if-active" : "queue-if-active", input: [{ type: "text", text: message, mentions: [] }],
      });
      return { delivery: sent.delivery };
    },
  };

  // The newest event of the given types, or null (also when SANDY no longer has the thread).
  const newestEvent = async (threadId: string, types?: [string, ...string[]]) => {
    try {
      const [event] = await sandy.sdk.threads.events.list({
        threadId, order: "desc", limit: "1", ...(types === undefined ? {} : { types: types as never }),
      });
      return event ?? null;
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  };

  const statusHost: StatusHost = {
    threadState: watchdogHost.threadState,
    latestTurnEvents: watchdogHost.latestTurnEvents,
    async executionOptions(threadId) {
      const options = await sandy.sdk.threads.defaultExecutionOptions({ threadId });
      return options === null ? null : { model: options.model, reasoningLevel: options.reasoningLevel };
    },
    async usage(threadId): Promise<UsageSnapshot | null> {
      const [tokenEvent, contextEvent] = await Promise.all([
        newestEvent(threadId, ["thread/tokenUsage/updated"]), newestEvent(threadId, ["thread/contextWindowUsage/updated"]),
      ]);
      const tokenUsage = (tokenEvent?.data as { tokenUsage?: { total?: { totalTokens?: unknown }; modelContextWindow?: unknown } } | undefined)?.tokenUsage;
      const contextUsage = (contextEvent?.data as { contextWindowUsage?: { usedTokens?: unknown; modelContextWindow?: unknown } } | undefined)?.contextWindowUsage;
      return {
        totalTokens: numberOrNull(tokenUsage?.total?.totalTokens),
        contextTokens: numberOrNull(contextUsage?.usedTokens),
        contextWindow: numberOrNull(contextUsage?.modelContextWindow) ?? numberOrNull(tokenUsage?.modelContextWindow),
      };
    },
    async lastEventAt(threadId) {
      return (await newestEvent(threadId))?.createdAt ?? null;
    },
    async latestFailure(threadId): Promise<FailureRecord | null> {
      const event = await newestEvent(threadId, ["provider/error", "system/error"]);
      if (event === null) return null;
      const data = event.data as { message?: unknown; detail?: unknown };
      const text = textOrNull(data.detail) ?? textOrNull(data.message);
      return text === null ? null : { at: event.createdAt, source: event.type, message: text };
    },
    now: () => Date.now(),
  };

  return { launchHost, watchdogHost, waitHost, controlHost, statusHost };
}
