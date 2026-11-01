import type { Thread, ThreadListEntry } from "@sandy/domain";
import { isThreadRead } from "@sandy/client-core";
import type { PluginThreadActionTarget } from "@sandy-sdk/plugin-sdk";

export function toThreadActionTarget(
  thread: Thread,
  environment: PluginThreadActionTarget["environment"],
): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: !isThreadRead(thread),
    status: thread.status,
    environment,
  };
}

export function threadListEntryActionTarget(
  entry: ThreadListEntry,
): PluginThreadActionTarget {
  return toThreadActionTarget(
    entry,
    entry.environmentId === null
      ? null
      : { id: entry.environmentId, path: entry.environmentPath },
  );
}
