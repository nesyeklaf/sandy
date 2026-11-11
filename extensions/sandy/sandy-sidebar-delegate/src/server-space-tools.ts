import { z } from "zod";
import { SpaceCoordinationError } from "./space-coordination-error";
import { spaceCoordinationRpcShape } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";
import type { ServerSpace } from "./server-space";

const { createIdea, updateIdea, writeScratchpad } = spaceCoordinationRpcShape;

const emptyParameters = z.object({}).strict();
const threadParameters = z.object({ threadId: z.string().trim().min(1) }).strict();
const startEnvironmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal("host"),
      hostId: z.string().trim().min(1).optional(),
      workspace: z.discriminatedUnion("type", [
        z.object({ type: z.literal("personal") }).strict(),
        z
          .object({
            type: z.literal("managed-worktree"),
            baseBranch: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("default") }).strict(),
              z.object({ kind: z.literal("named"), name: z.string().trim().min(1) }).strict(),
            ]),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const startParameters = z
  .object({
    projectId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1),
    environment: startEnvironmentSchema.default({ type: "project-default" }),
    ideaId: z.string().trim().min(1).optional(),
  })
  .strict();
const messageParameters = z.object({ threadId: z.string().trim().min(1), text: z.string().trim().min(1) }).strict();
const scratchpadWriteParameters = writeScratchpad.input.omit({ spaceId: true });

type ToolResult = string | { content: Array<{ type: "text"; text: string }>; isError: true };

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return json(await run());
  } catch (error) {
    if (error instanceof SpaceCoordinationError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    throw error;
  }
}

export function registerSpaceTools(ctx: ServerContext, space: ServerSpace): void {
  const { rolesService, notes } = space;
  const agents = ctx.sandy.agents;
  const actorOf = (threadId: string) => ({ kind: "session", threadId }) as const;

  async function requireManagedTarget(orchestratorId: string, targetId: string): Promise<void> {
    await rolesService.requireOrchestrator(orchestratorId);
    const decision = await rolesService.decideManagedTarget(orchestratorId, targetId);
    if (!decision.allowed) throw new SpaceCoordinationError("independent_member", decision.reason);
  }

  agents.registerTool({
    name: "space_context",
    description:
      "Read the Space of this session: members with status, environment and branch, orchestrators, ideas, scratchpad revision.",
    parameters: emptyParameters,
    execute: ({}, { threadId }) =>
      guarded(async () => space.contextReader.read(await rolesService.requireMember(threadId))),
  });
  agents.registerTool({
    name: "space_ideas_list",
    description: "List the ideas of this session's Space.",
    parameters: emptyParameters,
    execute: ({}, { threadId }) => guarded(async () => notes.listIdeas(await rolesService.requireMember(threadId))),
  });
  agents.registerTool({
    name: "space_idea_create",
    description: "Record an idea in this session's Space: a title, the problem and what done looks like.",
    parameters: createIdea.input.omit({ spaceId: true }),
    execute: (input, { threadId }) =>
      guarded(async () => {
        const spaceId = await rolesService.requireMember(threadId);
        return notes.createIdea(actorOf(threadId), { ...input, spaceId });
      }),
  });
  agents.registerTool({
    name: "space_idea_update",
    description:
      "Change the title, body, status (open, planned, in-progress, done, dropped) or linked sessions of an idea.",
    parameters: updateIdea.input,
    execute: (input, { threadId }) =>
      guarded(async () => {
        await rolesService.requireMember(threadId);
        return notes.updateIdea(actorOf(threadId), input);
      }),
  });
  agents.registerTool({
    name: "space_idea_delete",
    description: "Delete an idea of this Space. Orchestrators only.",
    parameters: z.object({ ideaId: z.string().trim().min(1) }).strict(),
    execute: ({ ideaId }, { threadId }) =>
      guarded(async () => ({ deleted: await notes.deleteIdea(actorOf(threadId), ideaId) })),
  });
  agents.registerTool({
    name: "space_scratchpad_read",
    description: "Read the shared Markdown scratchpad of this Space with its revision.",
    parameters: emptyParameters,
    execute: ({}, { threadId }) =>
      guarded(async () => notes.readScratchpad(actorOf(threadId), await rolesService.requireMember(threadId))),
  });
  agents.registerTool({
    name: "space_scratchpad_write",
    description:
      "Replace the scratchpad when baseRevision equals the current revision; otherwise the current text comes back as a conflict.",
    parameters: scratchpadWriteParameters,
    execute: (input, { threadId }) =>
      guarded(async () => {
        const spaceId = await rolesService.requireMember(threadId);
        return notes.writeScratchpad(actorOf(threadId), { ...input, spaceId });
      }),
  });
  registerManagementTools(ctx, space, requireManagedTarget);
}

function registerManagementTools(
  ctx: ServerContext,
  space: ServerSpace,
  requireManagedTarget: (orchestratorId: string, targetId: string) => Promise<void>,
): void {
  const { rolesService, notes, deps } = space;
  const sdk = ctx.sandy.sdk;
  const agents = ctx.sandy.agents;

  async function requireReusableEnvironment(callerId: string, spaceId: string, environmentId: string): Promise<void> {
    const caller = (await deps.membership.threadsById([callerId])).get(callerId);
    if (caller?.environmentId === environmentId) return;
    const { threads } = await deps.membership.listMembers(spaceId);
    const managedOwner = threads.find(
      (member) => member.environmentId === environmentId && deps.roles.modeIn(member.id, spaceId) === "managed",
    );
    if (managedOwner === undefined) {
      throw new SpaceCoordinationError(
        "independent_member",
        "That environment belongs to a session that is not a managed member of this Space. Reuse your own environment or one of a managed member, or start with a new environment.",
      );
    }
  }

  agents.registerTool({
    name: "space_start_session",
    description:
      "Start a managed session in this Space (no parent, not owned by this session). Optionally reuse an environment and link an idea.",
    parameters: startParameters,
    execute: (input, { threadId }) =>
      guarded(async () => {
        const spaceId = await rolesService.requireOrchestrator(threadId);
        if (input.ideaId !== undefined) await notes.requireLinkableIdea(input.ideaId, spaceId);
        if (input.environment.type === "reuse") {
          await requireReusableEnvironment(threadId, spaceId, input.environment.environmentId);
        }
        const spawned = await sdk.threads.spawn({
          projectId: input.projectId,
          title: input.title,
          prompt: input.prompt,
          sectionId: spaceId,
          environment: input.environment,
        });
        try {
          deps.roles.setMode(spawned.id, spaceId, "managed", Date.now());
          if (input.ideaId !== undefined) await notes.linkSessionToIdea(input.ideaId, spawned.id);
        } catch (error) {
          throw new SpaceCoordinationError(
            "invalid_request",
            `Session ${spawned.id} was started in the Space but could not be finished: ${String(error)}. Do not start it again; use space_context to find it.`,
          );
        }
        deps.publishSpace(spaceId);
        return { threadId: spawned.id, spaceId, mode: "managed" };
      }),
  });
  agents.registerTool({
    name: "space_message_session",
    description: "Send a message to a managed member of this Space.",
    parameters: messageParameters,
    execute: (input, { threadId }) =>
      guarded(async () => {
        await requireManagedTarget(threadId, input.threadId);
        const result = await sdk.threads.send({
          threadId: input.threadId,
          input: [{ type: "text", text: input.text, mentions: [] }],
          mode: "queue-if-active",
          senderThreadId: threadId,
        });
        return { delivery: result.delivery };
      }),
  });
  agents.registerTool({
    name: "space_stop_session",
    description: "Stop the running turn of a managed member of this Space.",
    parameters: threadParameters,
    execute: ({ threadId: targetId }, { threadId }) =>
      guarded(async () => {
        await requireManagedTarget(threadId, targetId);
        await sdk.threads.stop({ threadId: targetId });
        return { stopped: targetId };
      }),
  });
  agents.registerTool({
    name: "space_archive_session",
    description: "Archive a managed member of this Space.",
    parameters: threadParameters,
    execute: ({ threadId: targetId }, { threadId }) =>
      guarded(async () => {
        await requireManagedTarget(threadId, targetId);
        await sdk.threads.archive({ threadId: targetId });
        return { archived: targetId };
      }),
  });
}
