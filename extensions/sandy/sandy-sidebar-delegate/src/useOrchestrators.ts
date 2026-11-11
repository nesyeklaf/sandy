import { useCallback } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { ORCHESTRATORS_CHANNEL } from "./realtime-channels";
import { RemoteStore } from "./remote-store";
import { useRemoteStore } from "./useRemoteStore";

const NO_ORCHESTRATORS: ReadonlySet<string> = new Set();

const store = new RemoteStore<ReadonlySet<string>>(
  NO_ORCHESTRATORS,
  async (rpc) => new Set((await rpc.call("listOrchestrators", {})).threadIds),
);

export function useOrchestratorIds(): ReadonlySet<string> {
  return useRemoteStore(store, ORCHESTRATORS_CHANNEL, (orchestrators) => orchestrators);
}

export function useIsOrchestrator(threadId: string): boolean {
  return useRemoteStore(store, ORCHESTRATORS_CHANNEL, (orchestrators) => orchestrators.has(threadId));
}

export function useMarkOrchestrators(): (threadIds: readonly string[], orchestrator: boolean) => Promise<string[]> {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  return useCallback(
    async (threadIds, orchestrator) => {
      const changed: string[] = [];
      for (const threadId of threadIds) {
        const result = await rpc.call("setOrchestrator", { threadId, orchestrator });
        if (result.changed) changed.push(threadId);
      }
      if (changed.length > 0) {
        const next = new Set(store.getState());
        for (const threadId of changed) {
          if (orchestrator) next.add(threadId);
          else next.delete(threadId);
        }
        store.set(next);
      }
      return changed;
    },
    [rpc],
  );
}
