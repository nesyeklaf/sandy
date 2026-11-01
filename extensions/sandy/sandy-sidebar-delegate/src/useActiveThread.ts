import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { childSubtree } from "./child-status";

/**
 * The open thread, held outside the inbox contexts. Opening another thread
 * changes one or two rows; a row subscribes to its own answer, so only the
 * rows whose answer changed render again.
 */
export interface ActiveThreadStore {
  get: () => string | null;
  subscribe: (listener: () => void) => () => void;
}

export function useActiveThreadStore(activeThreadId: string | null): ActiveThreadStore {
  const [store] = useState(() => {
    let current = activeThreadId;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      set: (next: string | null) => {
        if (next === current) return;
        current = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
  useLayoutEffect(() => store.set(activeThreadId), [store, activeThreadId]);
  return store;
}

export const ActiveThreadContext = createContext<ActiveThreadStore | null>(null);

const NO_STORE: ActiveThreadStore = { get: () => null, subscribe: () => () => {} };

function useActiveThreadSelection<T>(select: (activeThreadId: string | null) => T): T {
  const store = useContext(ActiveThreadContext) ?? NO_STORE;
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(null),
  );
}

export function useIsActiveThread(threadId: string): boolean {
  return useActiveThreadSelection((activeThreadId) => activeThreadId === threadId);
}

/** The open thread when it is one of threads or below them, else null. */
export function useActiveThreadWithin(
  threads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
): string | null {
  return useActiveThreadSelection((activeThreadId) =>
    activeThreadId !== null && childSubtree(threads, childrenByParent).some((thread) => thread.id === activeThreadId)
      ? activeThreadId
      : null,
  );
}
