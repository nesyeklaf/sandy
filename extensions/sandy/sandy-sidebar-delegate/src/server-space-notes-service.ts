import { assert } from "./assert";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { Idea, IdeaStatus, Scratchpad, ScratchpadWrite } from "./space-coordination-contract";
import type { SpaceActor, SpaceDeps } from "./server-space-deps";
import type { IdeaAuthor } from "./server-space-ideas-store";
import type { SpaceRolesService } from "./server-space-roles-service";

export interface IdeaCreateInput {
  spaceId: string;
  title: string;
  body: string;
  threadIds: readonly string[];
}

export interface IdeaUpdateInput {
  ideaId: string;
  title?: string;
  body?: string;
  status?: IdeaStatus;
  threadIds?: readonly string[];
}

export function createSpaceNotesService(deps: SpaceDeps, rolesService: SpaceRolesService) {
  const { ideas, scratchpads, membership } = deps;

  function authorOf(actor: SpaceActor): IdeaAuthor {
    switch (actor.kind) {
      case "owner":
        return { kind: "owner", threadId: null };
      case "session":
        return { kind: "session", threadId: actor.threadId };
      default:
        return assertNever(actor);
    }
  }

  async function requireAccess(actor: SpaceActor, spaceId: string): Promise<void> {
    if (actor.kind === "owner") return;
    const memberSpaceId = await membership.spaceOf(actor.threadId);
    if (memberSpaceId !== spaceId) {
      throw new SpaceCoordinationError("not_member", "Only members of this Space can use its ideas and scratchpad.");
    }
  }

  async function requireLiveSpace(spaceId: string): Promise<void> {
    const names = await membership.sectionNames();
    if (!names.has(spaceId)) {
      throw new SpaceCoordinationError("space_missing", `Space ${spaceId} does not exist.`);
    }
  }

  async function requireLinkMembers(spaceId: string, threadIds: readonly string[]): Promise<void> {
    const spaces = await membership.spacesOf(threadIds);
    for (const threadId of threadIds) {
      if (spaces.get(threadId) !== spaceId) {
        throw new SpaceCoordinationError("not_member", `Session ${threadId} is not a member of Space ${spaceId}.`);
      }
    }
  }

  async function ideaOrFail(ideaId: string): Promise<Idea> {
    const idea = ideas.get(ideaId);
    if (idea === null) throw new SpaceCoordinationError("not_found", `No idea ${ideaId}.`);
    return idea;
  }

  return {
    listIdeas(spaceId: string): Idea[] {
      return ideas.list(spaceId);
    },

    async createIdea(actor: SpaceActor, input: IdeaCreateInput): Promise<Idea> {
      await requireAccess(actor, input.spaceId);
      await requireLiveSpace(input.spaceId);
      await requireLinkMembers(input.spaceId, input.threadIds);
      const created = ideas.create({ ...input, author: authorOf(actor) }, Date.now());
      deps.publishSpace(input.spaceId);
      return created;
    },

    async updateIdea(actor: SpaceActor, input: IdeaUpdateInput): Promise<Idea> {
      const current = await ideaOrFail(input.ideaId);
      await requireAccess(actor, current.spaceId);
      if (input.threadIds !== undefined) await requireLinkMembers(current.spaceId, input.threadIds);
      const updated = ideas.update(input.ideaId, input, Date.now());
      deps.publishSpace(current.spaceId);
      return updated;
    },

    async deleteIdea(actor: SpaceActor, ideaId: string): Promise<boolean> {
      const current = await ideaOrFail(ideaId);
      if (actor.kind === "session") {
        const orchestratorSpaceId = await rolesService.orchestratorSpaceOf(actor.threadId);
        if (orchestratorSpaceId !== current.spaceId) {
          throw new SpaceCoordinationError("not_orchestrator", "Only an orchestrator of this Space can delete ideas.");
        }
      }
      const removed = ideas.remove(ideaId);
      deps.publishSpace(current.spaceId);
      return removed;
    },

    async linkSessionToIdea(ideaId: string, threadId: string): Promise<Idea> {
      const current = await ideaOrFail(ideaId);
      await requireLinkMembers(current.spaceId, [threadId]);
      ideas.linkThread(ideaId, threadId);
      const updated = ideas.update(ideaId, { status: "in-progress" }, Date.now());
      deps.publishSpace(current.spaceId);
      return updated;
    },

    async readScratchpad(actor: SpaceActor, spaceId: string): Promise<Scratchpad> {
      await requireAccess(actor, spaceId);
      return scratchpads.read(spaceId);
    },

    async writeScratchpad(
      actor: SpaceActor,
      input: { spaceId: string; body: string; baseRevision: number },
    ): Promise<ScratchpadWrite> {
      await requireAccess(actor, input.spaceId);
      await requireLiveSpace(input.spaceId);
      const result = scratchpads.write(input.spaceId, input.body, input.baseRevision, authorOf(actor), Date.now());
      assert(result.scratchpad.spaceId === input.spaceId, "written scratchpad must belong to the Space");
      if (result.status === "written") deps.publishSpace(input.spaceId);
      return result;
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled actor: ${JSON.stringify(value)}`);
}

export type SpaceNotesService = ReturnType<typeof createSpaceNotesService>;
