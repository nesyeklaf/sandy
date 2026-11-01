import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export interface QueuedRetry {
  id: string;
  threadId: string;
  sendAt: number | null;
}

export async function listQueuedRetries(
  sandy: SandyPluginApi,
  threadId?: string,
): Promise<QueuedRetry[]> {
  const rows = await sandy.sdk.threads.queue.list(
    threadId === undefined ? {} : { threadId },
  );
  return rows
    .filter((row) => row.payload.kind === "retry")
    .map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sendAt: row.sendAt,
    }));
}

export async function findQueuedRetry(
  sandy: SandyPluginApi,
  threadId: string,
): Promise<QueuedRetry | null> {
  const rows = await listQueuedRetries(sandy, threadId);
  return rows[0] ?? null;
}
