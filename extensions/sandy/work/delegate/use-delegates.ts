import { useEffect } from "react";
import { experimental_useRpcQuery } from "@sandy-sdk/plugin-sdk/app";
import { rpcContract } from "./contract.ts";
import { statusTone } from "./panel-view.ts";

export const POLL_ACTIVE_MS = 3000;
export const POLL_IDLE_MS = 30_000;

type Consumer = { refetch: () => Promise<unknown>; intervalMs: number };
type Poller = { consumers: Set<Consumer>; timer: ReturnType<typeof setInterval> | null; intervalMs: number };

const pollers = new Map<string, Poller>();

const documentVisible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

function tick(poller: Poller) {
  if (!documentVisible()) return;
  const [leader] = poller.consumers;
  if (leader !== undefined) void leader.refetch();
}

function schedule(poller: Poller) {
  if (poller.timer !== null) clearInterval(poller.timer);
  poller.timer = null;
  if (poller.consumers.size === 0) return;
  poller.intervalMs = Math.min(...[...poller.consumers].map((consumer) => consumer.intervalMs));
  poller.timer = setInterval(() => tick(poller), poller.intervalMs);
}

function onVisibilityChange() {
  if (!documentVisible()) return;
  for (const poller of pollers.values()) tick(poller);
}

function register(threadId: string, consumer: Consumer): () => void {
  let poller = pollers.get(threadId);
  if (poller === undefined) {
    poller = { consumers: new Set(), timer: null, intervalMs: 0 };
    pollers.set(threadId, poller);
  }
  if (pollers.size === 1 && poller.consumers.size === 0 && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
  poller.consumers.add(consumer);
  schedule(poller);
  const owner = poller;
  return () => {
    owner.consumers.delete(consumer);
    schedule(owner);
    if (owner.consumers.size === 0) {
      pollers.delete(threadId);
      if (pollers.size === 0 && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

export function useDelegates(threadId: string, enabled = true) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "listDelegates", input: { threadId }, enabled });
  const { refetch } = query;
  const running = query.data === undefined || query.data.rows.some((row) => statusTone(row) === "running");
  const intervalMs = running ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  useEffect(() => {
    if (!enabled) return;
    return register(threadId, { refetch, intervalMs });
  }, [threadId, enabled, refetch, intervalMs]);
  return query;
}
