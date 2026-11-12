import type { ServerContext } from "./server-context";
import type { SpaceIdeasStore } from "./server-space-ideas-store";
import type { SpaceMembership } from "./server-space-membership";
import type { SpaceReportsStore } from "./server-space-reports-store";
import type { SpaceRolesStore } from "./server-space-roles-store";
import type { SpaceScratchpadStore } from "./server-space-scratchpad-store";

export type SpaceActor = { kind: "owner" } | { kind: "session"; threadId: string };

export interface SpaceDeps {
  ctx: ServerContext;
  roles: SpaceRolesStore;
  ideas: SpaceIdeasStore;
  scratchpads: SpaceScratchpadStore;
  reports: SpaceReportsStore;
  membership: SpaceMembership;
  publishSpace(spaceId: string): void;
  publishOrchestrators(): void;
}
