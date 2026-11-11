import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "../useLifecycle";
import { threadAsksForInput } from "../child-status";
import { threadFailed } from "../thread-status";
import { isWorkingTree } from "../working-tree";
import type { SpacePrState, SpaceThreadFacts } from "../spaces-model";

interface SpaceFactSources {
  lifecycle: Pick<LifecycleApi, "shelfFor">;
  outcomes: ReadonlyMap<string, SpacePrState>;
  orchestratorIds: ReadonlySet<string>;
}

export function spaceFactsOf(thread: PluginSidebarThread, sources: SpaceFactSources): SpaceThreadFacts {
  const environmentId = thread.environment?.id;
  return {
    lifecycle: sources.lifecycle.shelfFor(thread),
    asks: threadAsksForInput(thread),
    failed: threadFailed(thread),
    working: isWorkingTree(thread, [], new Map()),
    pr: environmentId ? (sources.outcomes.get(environmentId) ?? "unknown") : "none",
    idea: false,
    orchestrator: sources.orchestratorIds.has(thread.id),
    activityAt: Math.max(thread.latestAttentionAt, thread.updatedAt),
  };
}
