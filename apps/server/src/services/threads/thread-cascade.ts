import { getThread, listThreadDeletionTree } from "@sandy/db";
import type {
  ThreadCascadeAction,
  ThreadCascadeListResponse,
} from "@sandy/server-contract";
import type { AppDeps } from "../../types.js";
import { listArchiveCascadeThreadIds } from "./thread-archive.js";

export function listThreadCascades(
  db: AppDeps["db"],
  threadIds: readonly string[],
  action: ThreadCascadeAction,
): ThreadCascadeListResponse["threads"] {
  return [...new Set(threadIds)].flatMap((threadId) => {
    const thread = getThread(db, threadId);
    if (thread === null || thread.deletedAt !== null) return [];
    const cascadeThreadIds =
      action === "archive"
        ? listArchiveCascadeThreadIds(db, thread)
        : listThreadDeletionTree(db, thread.id)
            .filter(
              (candidate) =>
                candidate.id !== thread.id &&
                candidate.visibility === "visible" &&
                candidate.deletedAt === null,
            )
            .map((candidate) => candidate.id);
    return [{ threadId, cascadeThreadIds }];
  });
}
