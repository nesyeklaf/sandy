import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { getAnchors, setAnchors, subscribeAnchors } from "./anchor-store";
import type { Anchor } from "./anchors-contract";
import type { sandySidebarRpcContract } from "./contract";
import { ANCHORS_CHANNEL } from "./realtime-channels";

/** One request per session at a time, however many cards ask. */
const inflight = new Map<string, Promise<void>>();

/** The saved marks of one session, kept fresh by the server's realtime channel. */
export function useAnchors(threadId: string): readonly Anchor[] {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const refresh = useCallback(() => {
    let pending = inflight.get(threadId);
    if (!pending) {
      pending = rpc
        .call("listAnchors", { threadId })
        .then((result) => setAnchors(threadId, result.anchors))
        .catch(() => {
          // The cards just stay as they were until the next signal.
        })
        .finally(() => inflight.delete(threadId));
      inflight.set(threadId, pending);
    }
    return pending;
  }, [rpc, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime(ANCHORS_CHANNEL, (event) => {
    const changed = (event as { threadId?: string } | undefined)?.threadId;
    if (changed === undefined || changed === threadId) void refresh();
  });
  return useSyncExternalStore(subscribeAnchors, () => getAnchors(threadId));
}
