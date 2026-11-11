import { useMemo } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";
import { useIdeaIds } from "./useIdeas";
import { useOrchestratorIds } from "./useOrchestrators";
import { useThreadPullRequestOutcomes } from "./sandy-sdk";
import { spaceFactsOf } from "./lib/space-facts";
import { buildSpaces, type SpaceView } from "./spaces-model";
import { useQuantizedNow } from "./useQuantizedNow";

export function useSpaceViews({
  threads,
  sections,
  lifecycle,
  scope,
  includeArchived,
}: {
  threads: readonly PluginSidebarThread[];
  sections: readonly { id: string; name: string }[];
  lifecycle: LifecycleApi;
  scope: readonly string[];
  includeArchived: boolean;
}): SpaceView[] {
  const outcomes = useThreadPullRequestOutcomes(threads);
  const ideaIds = useIdeaIds();
  const orchestratorIds = useOrchestratorIds();
  const now = useQuantizedNow();
  return useMemo(() => {
    const scoped = scope.length > 0 ? new Set(scope) : null;
    return buildSpaces({
      threads,
      sections,
      facts: (thread) => spaceFactsOf(thread, { lifecycle, outcomes, ideaIds, orchestratorIds }),
      matches: (thread) => scoped === null || scoped.has(thread.projectId),
      includeArchived,
      now,
      unassignedName: "No Space",
    });
  }, [threads, sections, lifecycle, scope, includeArchived, outcomes, ideaIds, orchestratorIds, now]);
}
