import { useCallback, type RefObject } from "react";
import type { PluginSidebarThread, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";

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
  const parkActiveThread = useCallback(
    async (thread: PluginSidebarThread, mutation: () => Promise<boolean>) => {
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
    },
    [activeThreadIdRef, navigate, nextThreadCandidatesRef, onNavigate],
  );

  const parkThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.park(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const settleThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.settle(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const snoozeThread = useCallback(
    (thread: PluginSidebarThread, until: number, deferredInteractionId?: string) =>
      void parkActiveThread(thread, () => lifecycle.snooze(thread.id, until, deferredInteractionId)),
    [parkActiveThread, lifecycle],
  );
  return { parkThread, settleThread, snoozeThread };
}
