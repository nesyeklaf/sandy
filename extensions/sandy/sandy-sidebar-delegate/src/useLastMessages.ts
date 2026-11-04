import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { LAST_MESSAGE_CHANNEL } from "./realtime-channels";
import { RemoteStore } from "./remote-store";

const NO_MESSAGES: ReadonlyMap<string, string> = new Map();

function createLastMessagesStore() {
  const requested = new Map<string, number>();
  const remote: RemoteStore<ReadonlyMap<string, string>> = new RemoteStore(NO_MESSAGES, async (rpc) => {
    if (requested.size === 0) return NO_MESSAGES;
    const result = await rpc.call("listLastMessages", { threadIds: [...requested.keys()].sort() });
    return new Map(result.messages.map((message) => [message.threadId, message.text]));
  });
  const subscribe = (threadId: string, listener: () => void): (() => void) => {
    requested.set(threadId, (requested.get(threadId) ?? 0) + 1);
    const unsubscribe = remote.subscribe(listener);
    remote.invalidate();
    return () => {
      unsubscribe();
      const remaining = (requested.get(threadId) ?? 1) - 1;
      if (remaining === 0) requested.delete(threadId);
      else requested.set(threadId, remaining);
    };
  };
  return { remote, subscribe };
}

type LastMessagesStore = ReturnType<typeof createLastMessagesStore>;

const LastMessagesContext = createContext<LastMessagesStore | null>(null);

function LastMessagesRealtime({ store }: { store: LastMessagesStore }) {
  useRealtime(LAST_MESSAGE_CHANNEL, store.remote.invalidate);
  return null;
}

export function LastMessagesProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [store] = useState(() => {
    const created = createLastMessagesStore();
    created.remote.bind(rpc);
    return created;
  });
  return createElement(
    LastMessagesContext.Provider,
    { value: store },
    children,
    enabled ? createElement(LastMessagesRealtime, { store }) : null,
  );
}

const noSubscription = (): (() => void) => () => {};

export function useLastMessage(threadId: string): string | null {
  const store = useContext(LastMessagesContext);
  const subscribe = useCallback(
    (listener: () => void) => (store === null ? noSubscription() : store.subscribe(threadId, listener)),
    [store, threadId],
  );
  return useSyncExternalStore(subscribe, () => store?.remote.getState().get(threadId) ?? null);
}
