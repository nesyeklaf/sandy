import { createSpaceContextReader, createSpaceOrphans } from "./server-space-context";
import type { ServerContext } from "./server-context";
import { createSpaceIdeasStore } from "./server-space-ideas-store";
import { createSpaceMembership } from "./server-space-membership";
import { createSpaceNotesService, type SpaceNotesService } from "./server-space-notes-service";
import { createSpaceRolesService, type SpaceRolesService } from "./server-space-roles-service";
import { createSpaceRolesStore } from "./server-space-roles-store";
import { createSpaceScratchpadStore } from "./server-space-scratchpad-store";
import type { SpaceDeps } from "./server-space-deps";
import { createAgentView } from "./server-space-agent-view";
import { registerSpaceEnforcement } from "./server-space-enforcement";
import { registerSpacesCli } from "./server-cli-spaces";
import { registerSpaceTools } from "./server-space-tools";
import { registerFailureFallback } from "./server-space-fallback";
import { registerCheckIn } from "./server-space-check-in";
import { createActivityTracker } from "./server-space-activity";
import { createSpaceReportsStore } from "./server-space-reports-store";
import { createSpaceReportsService, type SpaceReportsService } from "./server-space-reports-service";
import { ORCHESTRATORS_CHANNEL, spaceChannel } from "./realtime-channels";

export function createServerSpace(ctx: ServerContext): ServerSpace {
  const deps: SpaceDeps = {
    ctx,
    roles: createSpaceRolesStore(ctx.db),
    ideas: createSpaceIdeasStore(ctx.db),
    scratchpads: createSpaceScratchpadStore(ctx.db),
    reports: createSpaceReportsStore(ctx.db),
    membership: createSpaceMembership(ctx),
    publishSpace: (spaceId) => ctx.sandy.realtime.publish(spaceChannel(spaceId), {}),
    publishOrchestrators: () => ctx.sandy.realtime.publish(ORCHESTRATORS_CHANNEL, {}),
  };
  const rolesService = createSpaceRolesService(deps);
  const notes = createSpaceNotesService(deps, rolesService);
  const contextReader = createSpaceContextReader(deps, rolesService);
  const orphans = createSpaceOrphans(deps);
  const reportsService = createSpaceReportsService(deps, rolesService);
  const activity = createActivityTracker(ctx);

  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    rolesService.forgetThread(thread.id);
  });

  ctx.sandy.events.on("thread.created", async ({ thread }) => {
    if (thread.parentThreadId === null) return;
    try {
      await rolesService.restrictChild(thread.id, thread.parentThreadId);
    } catch (error) {
      ctx.sandy.log.warn(`Could not restrict ${thread.id} as a descendant: ${String(error)}`);
    }
  });

  const space = { deps, rolesService, notes, contextReader, orphans, reportsService };
  registerSpaceEnforcement(ctx, rolesService);
  registerFailureFallback(ctx, deps, rolesService);
  registerCheckIn(ctx, deps, rolesService, activity);
  createAgentView(ctx, deps, rolesService);
  registerSpaceTools(ctx, space);
  registerSpacesCli(ctx, space);
  return space;
}

export interface ServerSpace {
  deps: SpaceDeps;
  rolesService: SpaceRolesService;
  notes: SpaceNotesService;
  contextReader: ReturnType<typeof createSpaceContextReader>;
  orphans: ReturnType<typeof createSpaceOrphans>;
  reportsService: SpaceReportsService;
}
