import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { migrations } from "./data.js";
import { createWorkflowService } from "./service.js";

/**
 * A fake SANDY host for characterization tests of the workflow service: every spawn, send, stop and archive is recorded
 * with its full input, and a worker thread's status is driven by the test. Test support only, not shipped behavior.
 */

export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** SANDY's answer to a plugin rpc call when the target plugin is not installed (live, plugin-side callRpc). */
export async function pluginNotInstalled(args: { pluginId: string }): Promise<never> {
  throw Object.assign(new Error(`HTTP 404: unknown plugin "${args.pluginId}"`), { status: 404, code: null });
}

export function workflowSource(body: string, name = "characterization"): string {
  return `export const meta = { name: "${name}", description: "Characterization" };\n${body}`;
}

function modelEntry(id: string) {
  return {
    id,
    model: id,
    displayName: id,
    description: "test",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "test" }],
    defaultReasoningEffort: "medium",
    isDefault: id === "model-a",
  };
}

export interface WorkerTestHostOptions {
  /** The environment the origin thread runs in; the run snapshots it at start. */
  originEnvironmentId?: string;
  /** Models the pi provider offers besides the default `model-a`. */
  extraModels?: string[];
  /** The delegate part's worker methods (workers.admit/attach/release, slice 18); absent means delegate is not linked. */
  delegate?: (method: string, input: Record<string, unknown>) => unknown;
  /** The origin environment's checkout; a writer worker needs a branch. */
  originCheckout?: { isGitRepo: boolean; branchName: string | null };
  /** What projects.list returns: the targets of agent option project. */
  projects?: { id: string; name: string; kind: "personal" | "standard"; sources: { hostId: string; isDefault: boolean }[] }[];
  /** SANDY's answer to a stop of a worker (recorded before it is asked); resolves at once by default. */
  stopThread?: (threadId: string) => Promise<void>;
}

export function createWorkerTestHost(options: WorkerTestHostOptions = {}) {
  const originEnvironmentId = options.originEnvironmentId ?? "environment-1";
  const status = new Map<string, string>();
  const spawned: Array<{ id: string; prompt: string; input: Record<string, unknown> }> = [];
  const sent: Array<{ threadId: string; text: string; input: Record<string, unknown> }> = [];
  const archived: string[] = [];
  const stopped: string[] = [];
  const files = new Map<string, string>();
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  /** A writer's own managed worktree: the environment of a thread spawned on the host. */
  const threadEnvironments = new Map<string, string>();
  const { sandy, harness } = createFakePluginHost({
    pluginId: "workflows-plus",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          ({
            id: threadId,
            environmentId: threadEnvironments.get(threadId) ?? originEnvironmentId,
            providerId: "pi",
            status: threadId === "origin" ? "idle" : (status.get(threadId) ?? "active"),
          }) as never,
        defaultExecutionOptions: async () => ({
          model: "model-a",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async (input: { prompt: string; environment?: { type: string } }) => {
          const id = `child-${spawned.length + 1}`;
          if (input.environment?.type === "host") threadEnvironments.set(id, `worktree-${id}`);
          spawned.push({ id, prompt: input.prompt, input: input as never });
          status.set(id, "active");
          return { id } as never;
        },
        send: async (input: { threadId: string; input: Array<{ text: string }> }) => {
          sent.push({ threadId: input.threadId, text: input.input[0]!.text, input: input as never });
          status.set(input.threadId, "active");
          return { ok: true } as never;
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          await options.stopThread?.(threadId);
          return { ok: true } as never;
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archived.push(threadId);
          return { ok: true } as never;
        },
        storageLocation: async ({ threadId }: { threadId: string }) =>
          ({ hostId: "worker-host", storageRootPath: `/storage/${threadId}` }) as never,
      },
      plugins: { callRpc: pluginNotInstalled },
      projects: { list: async () => (options.projects ?? []) as never },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) =>
          ({
            id: environmentId,
            hostId: "worker-host",
            isGitRepo: options.originCheckout?.isGitRepo ?? true,
            branchName: options.originCheckout === undefined ? "main" : options.originCheckout.branchName,
          }) as never,
      },
      files: {
        write: async (input: { hostId?: string; path: string; content: string }) => {
          files.set(`${input.hostId}:${input.path}`, input.content);
          return { outcome: "written" } as never;
        },
        remove: async (input: { hostId?: string; path: string }) => {
          files.delete(`${input.hostId}:${input.path}`);
          return { ok: true } as never;
        },
      },
      providers: {
        list: async () => [
          {
            id: "pi",
            displayName: "Pi",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: false,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["auto"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          models: ["model-a", ...(options.extraModels ?? [])].map(modelEntry),
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
    } as never,
  });
  const db = sandy.storage.database();
  sandy.storage.migrate(db, migrations);
  // The delegate side of the in-process link, recorded per method like the former rpc calls.
  const delegateMethod = (method: string) => async (input: object) => {
    rpcCalls.push({ method, input: { ...input } as Record<string, unknown> });
    return (await options.delegate!(method, { ...input } as Record<string, unknown>)) as never;
  };
  const workers = {
    delegate: options.delegate === undefined
      ? null
      : { admit: delegateMethod("workers.admit"), attach: delegateMethod("workers.attach"), release: delegateMethod("workers.release") },
  };
  const service = createWorkflowService(sandy, db, undefined, workers);
  const controller = new AbortController();
  const done = service.runWorker(controller.signal);

  return {
    db,
    service,
    spawned,
    rpcCalls,
    sent,
    archived,
    stopped,
    files,
    status,
    start: (source: string, resumedFromRunId: string | null = null, args: unknown = null) =>
      service.start({
        projectId: "project-test",
        originThreadId: "origin",
        source,
        args: args as never,
        resumedFromRunId,
      }),
    /** The worker's turn ends: the thread goes idle with this last text. */
    finish(threadId: string, output: string) {
      status.set(threadId, "idle");
      service.onThreadIdle(threadId, output);
    },
    async dispose() {
      controller.abort();
      await done.catch(() => undefined);
      await harness.dispose();
    },
  };
}
