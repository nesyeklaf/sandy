import type { ServerContext } from "./server-context";
import { loadPlugin, projectThread } from "./test-server";
import type { SpaceView } from "./spaces-model";

export type Listed = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];
export type PullRequestRows = Record<string, unknown>;

export const DAY = 24 * 60 * 60 * 1000;

export function listed(id: string, overrides: Partial<Listed> = {}): Listed {
  const now = Date.now();
  return {
    ...projectThread({ id }),
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    sectionId: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    status: "idle",
    runtime: { displayStatus: "idle" },
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    visibility: "visible",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    lastReadAt: null,
    latestAttentionAt: now,
    environmentId: null,
    ...overrides,
  } as Listed;
}

export async function overview(
  threads: Listed[],
  input: { projectId?: string } = {},
  pullRequests: PullRequestRows | Error = {},
) {
  const harness = await loadPlugin();
  harness.inspection.sdk.stub("threads.list", async () => threads);
  harness.inspection.sdk.stub("threadSections.list", async () => [
    { id: "sec_a", name: "Launch", createdAt: 0, updatedAt: 0 },
  ]);
  harness.inspection.sdk.stub("plugins.callRpc", async () => {
    if (pullRequests instanceof Error) throw pullRequests;
    return pullRequests;
  });
  const result = await harness.behavior.callRpc("getSpaceOverview", input);
  return result as { pullRequests: "available" | "unavailable"; spaces: SpaceView[] };
}
