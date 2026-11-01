import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

const PROVIDER_ID = "codex";
const PREFERRED_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 45_000;

interface HelperTarget {
  projectId: string;
  environmentId: string | null;
}

/**
 * Runs one prompt on a hidden Codex thread in the caller's workspace and returns its answer.
 * The plugin SDK has no direct model call, and an AI service only gets five seconds, so a hidden
 * helper thread is the way to ask a model something longer. Helpers are always stopped and deleted.
 */
export function createHiddenHelper(sandy: SandyPluginApi) {
  const helpers = new Set<string>();
  const running = new Set<Promise<unknown>>();
  const controller = new AbortController();

  async function cleanup(threadId: string) {
    try {
      await sandy.sdk.threads.stop({ threadId });
      await sandy.sdk.threads.delete({ threadId, childThreadsConfirmed: true });
      helpers.delete(threadId);
    } catch {
      sandy.log.warn("Could not clean up a hidden helper thread");
    }
  }

  sandy.onDispose(async () => {
    controller.abort();
    // A spawn already in flight must finish and reap its helper before this
    // plugin's SDK handle becomes stale.
    await Promise.allSettled([...running]);
    await Promise.all([...helpers].map(cleanup));
  });

  async function execute(target: HelperTarget, title: string, prompt: string, timeoutMs: number) {
    const environmentId = target.environmentId;
    if (!environmentId) throw new Error("This thread needs a workspace before a helper can run");
    const providers = await sandy.sdk.providers.list({ environmentId });
    if (!providers.some((provider) => provider.id === PROVIDER_ID && provider.available))
      throw new Error("The helper needs the " + PROVIDER_ID + " provider to be available");
    const catalog = await sandy.sdk.providers.models({ providerId: PROVIDER_ID, environmentId });
    const selected =
      catalog.models.find((entry) => entry.id === PREFERRED_MODEL) ?? catalog.models.find((entry) => entry.isDefault);
    if (!selected) throw new Error("Codex has no available model for the helper");
    controller.signal.throwIfAborted();
    let helperId: string | undefined;
    try {
      const helper = await sandy.sdk.threads.spawn({
        projectId: target.projectId,
        // Reusing the ready workspace avoids provisioning a personal workspace
        // per helper, which can stall before its turn even starts.
        environment: { type: "reuse", environmentId },
        providerId: PROVIDER_ID,
        model: selected.model,
        reasoningLevel: "low",
        permissionMode: "accept-edits",
        visibility: "hidden",
        title,
        // No parent/source thread: no inherited conversation or completion
        // message injected into the user's thread.
        prompt,
      });
      helperId = helper.id;
      helpers.add(helperId);
      controller.signal.throwIfAborted();
      await sandy.sdk.threads.wait({ threadId: helperId, status: "idle", timeoutMs, signal: controller.signal });
      return (await sandy.sdk.threads.output({ threadId: helperId })).output;
    } finally {
      if (helperId) await cleanup(helperId);
    }
  }

  return {
    signal: controller.signal,
    run(target: HelperTarget, title: string, prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const task = execute(target, title, prompt, timeoutMs);
      running.add(task);
      return task.finally(() => running.delete(task));
    },
  };
}

export type HiddenHelper = ReturnType<typeof createHiddenHelper>;
