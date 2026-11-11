import { assert } from "./assert";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { SpaceCoordination, SpaceMember } from "./space-coordination-contract";
import type { SpaceDeps } from "./server-space-deps";
import type { MemberThread } from "./server-space-membership";
import type { SpaceRolesService } from "./server-space-roles-service";
import { lookUpPullRequestOutcomes } from "./server-space-pull-requests";

function toMember(
  thread: MemberThread,
  projectNames: ReadonlyMap<string, string>,
  pullRequests: ReadonlyMap<string, string>,
  deps: SpaceDeps,
  orchestratorIds: ReadonlySet<string>,
): SpaceMember {
  return {
    threadId: thread.id,
    title: thread.title ?? thread.titleFallback ?? "",
    status: thread.status,
    projectId: thread.projectId,
    projectName: projectNames.get(thread.projectId) ?? null,
    environmentId: thread.environmentId ?? null,
    environmentName: thread.environmentName ?? null,
    environmentHostId: thread.environmentHostId ?? null,
    environmentPath: thread.environmentPath ?? null,
    environmentIsWorktree: thread.environmentIsWorktree ?? null,
    branchName: thread.environmentBranchName ?? null,
    pullRequest: thread.environmentId === null ? "none" : (pullRequests.get(thread.environmentId) ?? "unknown"),
    hasPendingQuestion: thread.hasPendingInteraction,
    latestAttentionAt: thread.latestAttentionAt,
    updatedAt: thread.updatedAt,
    mode: deps.roles.modeOf(thread.id),
    isOrchestrator: orchestratorIds.has(thread.id),
  };
}

export function createSpaceContextReader(deps: SpaceDeps, rolesService: SpaceRolesService) {
  return {
    async read(spaceId: string): Promise<SpaceCoordination> {
      assert(spaceId.length > 0, "spaceId must not be empty");
      const names = await deps.membership.sectionNames();
      const spaceName = names.get(spaceId);
      if (spaceName === undefined) {
        throw new SpaceCoordinationError("space_missing", `Space ${spaceId} does not exist.`);
      }
      const [members, orchestratorThreadIds, projects] = await Promise.all([
        deps.membership.listMembers(spaceId),
        rolesService.verifiedOrchestrators(spaceId),
        deps.ctx.sandy.sdk.projects.list({ includePersonal: true }),
      ]);
      const environmentIds = [
        ...new Set(members.threads.flatMap((thread) => (thread.environmentId === null ? [] : [thread.environmentId]))),
      ];
      const lookup = await lookUpPullRequestOutcomes(deps.ctx, environmentIds);
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const orchestratorIds = new Set(orchestratorThreadIds);
      const context: SpaceCoordination = {
        spaceId,
        spaceName,
        wakeEnabled: deps.roles.wakeEnabled(spaceId),
        orchestratorThreadIds,
        members: members.threads.map((thread) =>
          toMember(thread, projectNames, lookup.outcomes, deps, orchestratorIds),
        ),
        membersTruncated: members.truncated,
        ideas: deps.ideas.list(spaceId),
        scratchpadRevision: deps.scratchpads.read(spaceId).revision,
      };
      assert(
        context.members.every((member) => orchestratorIds.has(member.threadId) === member.isOrchestrator),
        "member orchestrator flags must match the orchestrator list",
      );
      return context;
    },
  };
}

export function createSpaceOrphans(deps: SpaceDeps) {
  return {
    async list(): Promise<Array<{ spaceId: string; ideaCount: number; hasScratchpad: boolean }>> {
      const names = await deps.membership.sectionNames();
      const counts = new Map(deps.ideas.spaceIdsWithIdeas().map((entry) => [entry.spaceId, entry.ideaCount]));
      const scratchpadSpaceIds = new Set(deps.scratchpads.spaceIdsWithScratchpads());
      const spaceIds = [...new Set([...counts.keys(), ...scratchpadSpaceIds])].filter((spaceId) => !names.has(spaceId));
      return spaceIds.sort().map((spaceId) => ({
        spaceId,
        ideaCount: counts.get(spaceId) ?? 0,
        hasScratchpad: scratchpadSpaceIds.has(spaceId),
      }));
    },

    async adopt(oldSpaceId: string, spaceId: string): Promise<{ ideasMoved: number; scratchpadAppended: boolean }> {
      assert(oldSpaceId !== spaceId, "adopt needs two different Spaces");
      const names = await deps.membership.sectionNames();
      if (!names.has(spaceId)) {
        throw new SpaceCoordinationError("space_missing", `Target Space ${spaceId} does not exist.`);
      }
      if (names.has(oldSpaceId)) {
        throw new SpaceCoordinationError(
          "invalid_request",
          `Space ${oldSpaceId} still exists; only deleted Spaces can be adopted.`,
        );
      }
      const result = deps.ctx.db.transaction(() => {
        const old = deps.scratchpads.read(oldSpaceId);
        const appended = old.revision > 0 && old.body.trim().length > 0;
        const ideasMoved = deps.ideas.moveSpace(oldSpaceId, spaceId);
        if (appended) {
          deps.scratchpads.appendUnderHeading(
            spaceId,
            `Adopted from deleted Space ${oldSpaceId}`,
            old.body,
            { kind: "owner", threadId: null },
            Date.now(),
          );
        }
        deps.scratchpads.remove(oldSpaceId);
        return { ideasMoved, scratchpadAppended: appended };
      })();
      deps.publishSpace(spaceId);
      return result;
    },
  };
}
