import type { DelegateChildRecord } from "./delegate-children";
import { DELEGATE_CHILDREN_CHANNEL } from "./realtime-channels";
import { RemoteStore } from "./remote-store";
import { useRemoteStore } from "./useRemoteStore";

const POLL_MS = 20_000;

interface DelegateChildrenState {
  children: readonly DelegateChildRecord[];
  loaded: boolean;
}

const NOT_LOADED: DelegateChildrenState = { children: [], loaded: false };

const store = new RemoteStore<DelegateChildrenState>(
  NOT_LOADED,
  async (rpc) => ({ children: (await rpc.call("listDelegateChildren", {})).children, loaded: true }),
  POLL_MS,
);

export function useDelegateChildren(): DelegateChildrenState {
  return useRemoteStore(store, DELEGATE_CHILDREN_CHANNEL, (state) => state);
}
