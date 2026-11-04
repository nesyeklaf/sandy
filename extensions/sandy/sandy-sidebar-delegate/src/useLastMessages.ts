import { useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { LAST_MESSAGE_CHANNEL } from "./realtime-channels";

type Rpc = ReturnType<typeof useRpc<typeof sandySidebarRpcContract>>;

const NO_MESSAGES: ReadonlyMap<string, string> = new Map();

/**
 * One batched read per RPC client, shared by every row that shows a last
 * message, so a hundred mounted rows still cost one request. It fetches only
 * while a row is mounted.
 */
class LastMessagesStore {
  private messages = NO_MESSAGES;
  private readonly listeners = new Set<() => void>();
  private requestSeq = 0;
  private refreshScheduled = false;

  constructor(private readonly rpc: Rpc) {}

  readonly messageFor = (threadId: string): string | null => this.messages.get(threadId) ?? null;

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

  private async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    try {
      const result = await this.rpc.call("listLastMessages", {});
      if (seq !== this.requestSeq) return;
      this.messages = new Map(result.messages.map((message) => [message.threadId, message.text]));
      for (const listener of this.listeners) listener();
    } catch {
      // The next realtime signal or remount tries again.
    }
  }
}

const stores = new WeakMap<object, LastMessagesStore>();

function storeFor(rpc: Rpc): LastMessagesStore {
  let store = stores.get(rpc);
  if (store === undefined) {
    store = new LastMessagesStore(rpc);
    stores.set(rpc, store);
  }
  return store;
}

export function useLastMessage(threadId: string): string | null {
  const store = storeFor(useRpc<typeof sandySidebarRpcContract>());
  useRealtime(LAST_MESSAGE_CHANNEL, store.refreshSoon);
  return useSyncExternalStore(store.subscribe, () => store.messageFor(threadId));
}
