import { useCallback, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import type { RemoteStore } from "./remote-store";

export function useRemoteStore<State, Selected>(
  store: RemoteStore<State>,
  channel: string,
  select: (state: State) => Selected,
): Selected {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const subscribe = useCallback(
    (listener: () => void) => {
      store.bind(rpc);
      return store.subscribe(listener);
    },
    [store, rpc],
  );
  useRealtime(channel, store.invalidate);
  return useSyncExternalStore(subscribe, () => select(store.getState()));
}
