import type { RefObject } from "react";
import type { PluginSidebarThread, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";
import { useLatestCallback } from "./lib/stable-identity";

export function useParkActions({
  lifecycle,
  navigate,
  onNavigate,
  activeThreadIdRef,
  nextThreadCandidatesRef,
}: {
  lifecycle: LifecycleApi;
  navigate: ReturnType<typeof useSandyNavigate>;
  onNavigate: () => void;
  activeThreadIdRef: RefObject<string | null | undefined>;
  nextThreadCandidatesRef: RefObject<readonly PluginSidebarThread[]>;
}) {
  const parkActiveThread = async (thread: PluginSidebarThread, mutation: () => Promise<boolean>) => {
    const parked = await mutation();
    if (!parked || activeThreadIdRef.current !== thread.id) return;
    const nextThread = nextThreadCandidatesRef.current.find((candidate) => candidate.id !== thread.id);
    if (nextThread) {
      navigate.toThread(nextThread.id);
    } else {
      navigate.toCompose({
        projectId: thread.projectId,
        focusPrompt: true,
      });
    }
    onNavigate();
  };
  const parkThread = useLatestCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.park(thread.id)),
  );
  const settleThread = useLatestCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.settle(thread.id)),
  );
  const snoozeThread = useLatestCallback(
    (thread: PluginSidebarThread, until: number, deferredInteractionId?: string) =>
      void parkActiveThread(thread, () => lifecycle.snooze(thread.id, until, deferredInteractionId)),
  );
  return { parkThread, settleThread, snoozeThread };
}
