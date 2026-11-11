import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { assert } from "./assert";
import { sortActiveThreads, type ActiveSortMode } from "./inbox-layout";

function groupByProject(threads: readonly PluginSidebarThread[]): PluginSidebarThread[] {
  const groups = new Map<string, PluginSidebarThread[]>();
  for (const thread of sortActiveThreads(threads, "activity")) {
    const group = groups.get(thread.projectId);
    if (group) group.push(thread);
    else groups.set(thread.projectId, [thread]);
  }
  const grouped = [...groups.values()].flat();
  assert(grouped.length === threads.length, "grouping by project must keep every thread");
  return grouped;
}

export function sortSpaceShelfThreads(
  threads: readonly PluginSidebarThread[],
  mode: ActiveSortMode,
): PluginSidebarThread[] {
  switch (mode) {
    case "manual":
    case "activity":
    case "created":
      return sortActiveThreads(threads, mode);
    case "project":
      return groupByProject(threads);
    default: {
      const unreachable: never = mode;
      throw new Error(`Unknown sort mode ${String(unreachable)}`);
    }
  }
}
