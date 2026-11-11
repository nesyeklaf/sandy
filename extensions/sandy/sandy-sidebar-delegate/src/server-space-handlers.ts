import { experimental_PluginRpcRefusal } from "@sandy-sdk/plugin-sdk";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { spaceCoordinationRpcShape } from "./space-coordination-contract";
import type { ServerHandlers } from "./server-context";
import type { ServerSpace } from "./server-space";

const OWNER = { kind: "owner" } as const;

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SpaceCoordinationError) {
      throw new experimental_PluginRpcRefusal({ code: "invalid", message: error.message });
    }
    throw error;
  }
}

export function createSpaceHandlers(space: ServerSpace) {
  return {
    async getSpaceCoordination({ spaceId }) {
      return space.contextReader.read(spaceId);
    },
    async listOrchestrators() {
      const verified = await space.rolesService.verifiedAllOrchestrators();
      return { threadIds: verified.map((entry) => entry.threadId) };
    },
    async setOrchestrator({ threadId, orchestrator }) {
      return refusing(() => space.rolesService.setOrchestrator(threadId, orchestrator));
    },
    async setOrchestrators({ threadIds, orchestrator }) {
      return refusing(() => space.rolesService.setOrchestrators(threadIds, orchestrator));
    },
    async setMemberMode({ threadId, mode }) {
      return space.rolesService.setMemberMode(threadId, mode);
    },
    async setSpaceWake({ spaceId, enabled }) {
      return space.rolesService.setWake(spaceId, enabled);
    },
    async listIdeas({ spaceId }) {
      return { ideas: space.notes.listIdeas(spaceId) };
    },
    async createIdea(input) {
      return space.notes.createIdea(OWNER, input);
    },
    async updateIdea(input) {
      return space.notes.updateIdea(OWNER, input);
    },
    async deleteIdea({ ideaId }) {
      return { deleted: await space.notes.deleteIdea(OWNER, ideaId) };
    },
    async getScratchpad({ spaceId }) {
      return space.notes.readScratchpad(OWNER, spaceId);
    },
    async writeScratchpad(input) {
      return space.notes.writeScratchpad(OWNER, input);
    },
    async listOrphanSpaces() {
      return { orphans: await space.orphans.list() };
    },
    async adoptOrphanSpace({ oldSpaceId, spaceId }) {
      return space.orphans.adopt(oldSpaceId, spaceId);
    },
  } satisfies Pick<ServerHandlers, keyof typeof spaceCoordinationRpcShape>;
}
