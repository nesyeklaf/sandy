import { useEffect, useRef, useState } from "react";
import type { Thread } from "@sandy/domain";
import { isThreadRead, type ThreadReadState } from "@sandy/client-core";
import {
  useDocumentVisibilityRevision,
  useDocumentVisible,
} from "@/lib/document-visibility";
import { useUserActive } from "@/lib/user-activity";

type ThreadReadTrackingState = ThreadReadState & Pick<Thread, "id">;

interface MarkThreadReadMutation {
  mutateAsync: (input: {
    signal?: AbortSignal;
    threadId: string;
  }) => Promise<ThreadReadState>;
}

interface UseThreadReadTrackingParams {
  markThreadRead: MarkThreadReadMutation;
  thread?: ThreadReadTrackingState;
}

interface ReadTrackingSnapshot {
  isActive: boolean;
  isVisible: boolean;
  isRead: boolean | null;
  latestAttentionAt: number | null;
  threadId: string | null;
  visibilityRevision: number;
}

interface FailedRead {
  failureCount: number;
  backoffTimer: ReturnType<typeof setTimeout> | undefined;
}

const READ_RETRY_INITIAL_DELAY_MS = 1_000;
const READ_RETRY_MAX_DELAY_MS = 60_000;

function readRetryDelayMs(failureCount: number): number {
  return Math.min(
    READ_RETRY_INITIAL_DELAY_MS * 2 ** (failureCount - 1),
    READ_RETRY_MAX_DELAY_MS,
  );
}

function cancelBackoff(failedRead: FailedRead): void {
  clearTimeout(failedRead.backoffTimer);
  failedRead.backoffTimer = undefined;
}

function forgetFailedRead(
  failedReads: Map<string, FailedRead>,
  marker: string,
): void {
  const failedRead = failedReads.get(marker);
  if (failedRead) cancelBackoff(failedRead);
  failedReads.delete(marker);
}

export function useThreadReadTracking({
  markThreadRead,
  thread,
}: UseThreadReadTrackingParams) {
  const failedReadsRef = useRef<Map<string, FailedRead>>(new Map());
  const pendingReadControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const suppressedManualUnreadKeysRef = useRef<Set<string>>(new Set());
  const previousSnapshotRef = useRef<ReadTrackingSnapshot | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const visibilityRevision = useDocumentVisibilityRevision();
  const isVisible = useDocumentVisible();
  const isActive = useUserActive();

  useEffect(() => {
    const controllers = pendingReadControllersRef.current;
    const failedReads = failedReadsRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      for (const failedRead of failedReads.values()) cancelBackoff(failedRead);
    };
  }, []);

  useEffect(() => {
    const previousSnapshot = previousSnapshotRef.current;
    const threadIsRead = thread ? isThreadRead(thread) : null;
    const currentSnapshot: ReadTrackingSnapshot = {
      isActive,
      isVisible,
      isRead: threadIsRead,
      latestAttentionAt: thread?.latestAttentionAt ?? null,
      threadId: thread?.id ?? null,
      visibilityRevision,
    };
    previousSnapshotRef.current = currentSnapshot;

    if (previousSnapshot?.threadId !== currentSnapshot.threadId) {
      for (const controller of pendingReadControllersRef.current.values()) {
        controller.abort();
      }
    }

    if (!isVisible) {
      return;
    }
    if (!thread) {
      return;
    }

    const marker = `${thread.id}:${thread.latestAttentionAt}`;
    const isOpenedThread =
      previousSnapshot === null || previousSnapshot.threadId !== thread.id;
    const hasNewAttention =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.latestAttentionAt !== thread.latestAttentionAt;
    const hasVisibilityRegained =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.visibilityRevision !== visibilityRevision;
    if (isOpenedThread || hasNewAttention) {
      suppressedManualUnreadKeysRef.current.clear();
    }

    if (threadIsRead) {
      forgetFailedRead(failedReadsRef.current, marker);
      suppressedManualUnreadKeysRef.current.delete(marker);
      return;
    }

    if (hasVisibilityRegained) {
      const failedRead = failedReadsRef.current.get(marker);
      if (failedRead) {
        cancelBackoff(failedRead);
        failedRead.failureCount = 0;
      }
    }

    const isRetry = failedReadsRef.current.has(marker);
    const becameManuallyUnread =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.latestAttentionAt === thread.latestAttentionAt &&
      previousSnapshot.isVisible &&
      previousSnapshot.isRead === true &&
      !isRetry;

    if (becameManuallyUnread) {
      suppressedManualUnreadKeysRef.current.add(marker);
    }
    if (
      suppressedManualUnreadKeysRef.current.has(marker) &&
      !isOpenedThread &&
      !hasNewAttention
    ) {
      return;
    }

    if (!isActive) {
      return;
    }
    const becameActive =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.isActive === false;
    if (!isOpenedThread && !hasNewAttention && !becameActive && !isRetry) {
      return;
    }
    if (pendingReadControllersRef.current.has(marker)) {
      return;
    }
    if (failedReadsRef.current.get(marker)?.backoffTimer !== undefined) {
      return;
    }

    const failedReads = failedReadsRef.current;
    const controller = new AbortController();
    pendingReadControllersRef.current.set(marker, controller);
    void markThreadRead
      .mutateAsync({ signal: controller.signal, threadId: thread.id })
      .then(
        () => {
          forgetFailedRead(failedReads, marker);
        },
        () => {
          const failedRead = failedReads.get(marker) ?? {
            failureCount: 0,
            backoffTimer: undefined,
          };
          failedRead.failureCount += 1;
          failedReads.set(marker, failedRead);
          if (controller.signal.aborted) {
            return;
          }
          failedRead.backoffTimer = setTimeout(() => {
            failedRead.backoffTimer = undefined;
            setRetryRevision((revision) => revision + 1);
          }, readRetryDelayMs(failedRead.failureCount));
        },
      )
      .finally(() => {
        if (pendingReadControllersRef.current.get(marker) === controller) {
          pendingReadControllersRef.current.delete(marker);
        }
      });
  }, [
    isActive,
    isVisible,
    markThreadRead,
    retryRevision,
    thread,
    visibilityRevision,
  ]);
}
