import { useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import type { DelegateChildRecord } from "./delegate-children";
import { DELEGATE_CHILDREN_CHANNEL } from "./realtime-channels";

// Realtime tells the app when a child changes. The poll covers what no event
// announces: a pending question that was answered or expired.
const POLL_MS = 20_000;

interface DelegateChildrenState {
  children: readonly DelegateChildRecord[];
  loaded: boolean;
}

const NOT_LOADED: DelegateChildrenState = { children: [], loaded: false };

type Rpc = ReturnType<typeof useRpc<typeof sandySidebarRpcContract>>;

/**
 * One list per RPC client, shared by every component that reads the sidebar
 * threads, so a dozen mounted readers still cost one request and one timer.
 * The timer runs only while a reader is mounted.
 */
class DelegateChildrenStore {
  private state = NOT_LOADED;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // Only the newest request may write: responses can land out of order.
  private requestSeq = 0;

  constructor(private readonly rpc: Rpc) {}

  readonly getState = (): DelegateChildrenState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
        this.requestSeq += 1;
      }
    };
  };

  private refreshScheduled = false;

  /** Every mounted reader hears one realtime event; they share a single refresh. */
  readonly refreshSoon = (): void => {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      void this.refresh();
    });
  };

  /** A failed refresh keeps the last rows: a hiccup must not make every child vanish and return. */
  readonly refresh = async (): Promise<void> => {
    const seq = ++this.requestSeq;
    try {
      const result = await this.rpc.call("listDelegateChildren", {});
      if (seq !== this.requestSeq) return;
      this.state = { children: result.children, loaded: true };
      for (const listener of this.listeners) listener();
    } catch {
      // The next event or poll tries again.
    }
  };
}

const stores = new WeakMap<object, DelegateChildrenStore>();

function storeFor(rpc: Rpc): DelegateChildrenStore {
  let store = stores.get(rpc);
  if (store === undefined) {
    store = new DelegateChildrenStore(rpc);
    stores.set(rpc, store);
  }
  return store;
}

/**
 * The hidden delegate children and workers the plugin server lists.
 *
 * `loaded` turns true after the first successful answer and stays true.
 */
export function useDelegateChildren(): DelegateChildrenState {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const store = storeFor(rpc);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useRealtime(DELEGATE_CHILDREN_CHANNEL, store.refreshSoon);
  return state;
}
