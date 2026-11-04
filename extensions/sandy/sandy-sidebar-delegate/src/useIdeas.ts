import { useCallback, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { IDEAS_CHANNEL } from "./realtime-channels";

type Rpc = ReturnType<typeof useRpc<typeof sandySidebarRpcContract>>;

const NO_IDEAS: ReadonlySet<string> = new Set();

class IdeasStore {
  private ideas = NO_IDEAS;
  private readonly listeners = new Set<() => void>();
  private requestSeq = 0;
  private refreshScheduled = false;

  constructor(private readonly rpc: Rpc) {}

  readonly snapshot = (): ReadonlySet<string> => this.ideas;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.requestSeq += 1;
    };
  };

  readonly refreshSoon = (): void => {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      void this.refresh();
    });
  };

  readonly mark = async (threadIds: readonly string[], idea: boolean): Promise<string[]> => {
    const { changed } = await this.rpc.call("setIdea", { threadIds: [...threadIds], idea });
    if (changed.length > 0) {
      const next = new Set(this.ideas);
      for (const threadId of changed) {
        if (idea) next.add(threadId);
        else next.delete(threadId);
      }
      this.publish(next);
    }
    return changed;
  };

  private publish(next: ReadonlySet<string>): void {
    this.requestSeq += 1;
    this.ideas = next;
    for (const listener of this.listeners) listener();
  }

  private async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    try {
      const result = await this.rpc.call("listIdeas", {});
      if (seq !== this.requestSeq) return;
      this.ideas = new Set(result.threadIds);
      for (const listener of this.listeners) listener();
    } catch {
      return;
    }
  }
}

const stores = new WeakMap<object, IdeasStore>();

function useIdeasStore(): IdeasStore {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  let store = stores.get(rpc);
  if (store === undefined) {
    store = new IdeasStore(rpc);
    stores.set(rpc, store);
  }
  useRealtime(IDEAS_CHANNEL, store.refreshSoon);
  return store;
}

export function useIdeaIds(): ReadonlySet<string> {
  const store = useIdeasStore();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

export function useIsIdea(threadId: string): boolean {
  const store = useIdeasStore();
  return useSyncExternalStore(store.subscribe, () => store.snapshot().has(threadId));
}

export function useMarkIdeas(): (threadIds: readonly string[], idea: boolean) => Promise<string[]> {
  const store = useIdeasStore();
  return useCallback((threadIds, idea) => store.mark(threadIds, idea), [store]);
}
