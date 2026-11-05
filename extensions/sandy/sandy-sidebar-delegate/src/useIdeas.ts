import { useCallback } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { IDEAS_CHANNEL } from "./realtime-channels";
import { RemoteStore } from "./remote-store";
import { useRemoteStore } from "./useRemoteStore";

const NO_IDEAS: ReadonlySet<string> = new Set();

const store = new RemoteStore<ReadonlySet<string>>(
  NO_IDEAS,
  async (rpc) => new Set((await rpc.call("listIdeas", {})).threadIds),
);

export function useIdeaIds(): ReadonlySet<string> {
  return useRemoteStore(store, IDEAS_CHANNEL, (ideas) => ideas);
}

export function useIsIdea(threadId: string): boolean {
  return useRemoteStore(store, IDEAS_CHANNEL, (ideas) => ideas.has(threadId));
}

export function useMarkIdeas(): (threadIds: readonly string[], idea: boolean) => Promise<string[]> {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  return useCallback(
    async (threadIds, idea) => {
      const { changed } = await rpc.call("setIdea", { threadIds: [...threadIds], idea });
      if (changed.length > 0) {
        const next = new Set(store.getState());
        for (const threadId of changed) {
          if (idea) next.add(threadId);
          else next.delete(threadId);
        }
        store.set(next);
      }
      return changed;
    },
    [rpc],
  );
}
