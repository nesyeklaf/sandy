import { createSpaceContextReader, createSpaceOrphans } from "./server-space-context";
import type { ServerContext } from "./server-context";
import { createSpaceIdeasStore } from "./server-space-ideas-store";
import { createSpaceMembership } from "./server-space-membership";
import { createSpaceNotesService } from "./server-space-notes-service";
import { createSpaceRolesService } from "./server-space-roles-service";
import { createSpaceRolesStore } from "./server-space-roles-store";
import { createSpaceScratchpadStore } from "./server-space-scratchpad-store";
import type { SpaceDeps } from "./server-space-deps";
import { ORCHESTRATORS_CHANNEL, spaceChannel } from "./realtime-channels";

export function createServerSpace(ctx: ServerContext) {
  const deps: SpaceDeps = {
    ctx,
    roles: createSpaceRolesStore(ctx.db),
    ideas: createSpaceIdeasStore(ctx.db),
    scratchpads: createSpaceScratchpadStore(ctx.db),
    membership: createSpaceMembership(ctx),
    publishSpace: (spaceId) => ctx.sandy.realtime.publish(spaceChannel(spaceId), {}),
    publishOrchestrators: () => ctx.sandy.realtime.publish(ORCHESTRATORS_CHANNEL, {}),
  };
  const rolesService = createSpaceRolesService(deps);
  const notes = createSpaceNotesService(deps, rolesService);
  const contextReader = createSpaceContextReader(deps, rolesService);
  const orphans = createSpaceOrphans(deps);

  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    rolesService.forgetThread(thread.id);
  });

  return { deps, rolesService, notes, contextReader, orphans };
}

export type ServerSpace = ReturnType<typeof createServerSpace>;
