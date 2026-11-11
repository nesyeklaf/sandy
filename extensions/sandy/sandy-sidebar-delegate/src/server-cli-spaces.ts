import { cliCommand, defineCli, PluginCliError } from "@sandy-sdk/plugin-sdk";
import { COORDINATION_MODES } from "./space-coordination-contract";
import { actorOf, attempt, JSON_OPTION, render, requireOwner, resolveSpaceId } from "./server-cli-spaces-support";
import { createSpaceHandlers } from "./server-space-handlers";
import type { ServerContext } from "./server-context";
import type { ServerSpace } from "./server-space";
import { createSpaceIdeaCommands } from "./server-cli-spaces-notes";

const SPACE_POSITIONAL = { name: "space", description: "Space id or exact name", required: true } as const;
const THREAD_POSITIONAL = { name: "thread", description: "Session id", required: true } as const;

export function registerSpacesCli(ctx: ServerContext, space: ServerSpace): void {
  const handlers = createSpaceHandlers(space);
  ctx.sandy.cli.register(
    defineCli({
      name: "spaces",
      summary: "Coordinate sessions inside a Space: orchestrators, member modes, ideas and the scratchpad",
      commands: {
        ...createSpaceRoleCommands(space, handlers),
        ...createSpaceIdeaCommands(space, handlers),
      },
    }),
  );
}

type Handlers = ReturnType<typeof createSpaceHandlers>;

function createSpaceRoleCommands(space: ServerSpace, handlers: Handlers) {
  return {
    show: cliCommand({
      summary: "Show members, orchestrators, ideas and the scratchpad revision of a Space",
      positionals: [SPACE_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          await space.notes.authorize(actorOf(ctx), spaceId);
          const context = await handlers.getSpaceCoordination({ spaceId });
          const lines = [
            `${context.spaceName} (${context.spaceId}) wake-ups ${context.wakeEnabled ? "on" : "off"}`,
            `Orchestrators: ${context.orchestratorThreadIds.join(", ") || "none"}`,
            ...context.members.map((member) => `- ${member.threadId} ${member.mode} ${member.status} ${member.title}`),
            ...(context.membersTruncated ? ["(member list truncated)"] : []),
            `Ideas: ${context.ideas.length}  Scratchpad revision: ${context.scratchpadRevision}`,
          ];
          return render(input.options.json, context, lines);
        }),
    }),
    "orchestrator add": cliCommand({
      summary: "Make a member session an orchestrator of its Space",
      positionals: [THREAD_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          const result = await handlers.setOrchestrator({ threadId: input.positionals.thread, orchestrator: true });
          return render(input.options.json, result, [
            result.changed ? "Orchestrator added." : "Already an orchestrator.",
          ]);
        }),
    }),
    "orchestrator remove": cliCommand({
      summary: "Take the orchestrator role from a session",
      positionals: [THREAD_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          const result = await handlers.setOrchestrator({ threadId: input.positionals.thread, orchestrator: false });
          return render(input.options.json, result, [
            result.changed ? "Orchestrator removed." : "Not an orchestrator.",
          ]);
        }),
    }),
    "member mode": cliCommand({
      summary: "Set a member's coordination mode: independent (default) or managed",
      positionals: [THREAD_POSITIONAL, { name: "mode", description: COORDINATION_MODES.join(" or "), required: true }],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          const mode = COORDINATION_MODES.find((candidate) => candidate === input.positionals.mode);
          if (mode === undefined) {
            throw new PluginCliError(`Mode must be ${COORDINATION_MODES.join(" or ")}.`, { code: "invalid_value" });
          }
          const result = await handlers.setMemberMode({ threadId: input.positionals.thread, mode });
          return render(input.options.json, result, [`Mode is ${result.mode}.`]);
        }),
    }),
    wake: cliCommand({
      summary: "Switch the wake digest of a Space on or off",
      positionals: [SPACE_POSITIONAL, { name: "state", description: "on or off", required: true }],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          if (input.positionals.state !== "on" && input.positionals.state !== "off") {
            throw new PluginCliError("State must be on or off.", { code: "invalid_value" });
          }
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const result = await handlers.setSpaceWake({ spaceId, enabled: input.positionals.state === "on" });
          return render(input.options.json, result, [`Wake digest is ${result.wakeEnabled ? "on" : "off"}.`]);
        }),
    }),
    orphans: cliCommand({
      summary: "List ideas and scratchpads whose Space was deleted",
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          const result = await handlers.listOrphanSpaces();
          const lines = result.orphans.map(
            (orphan) => `${orphan.spaceId} ideas=${orphan.ideaCount} scratchpad=${orphan.hasScratchpad ? "yes" : "no"}`,
          );
          return render(input.options.json, result, lines.length === 0 ? ["No orphaned Space data."] : lines);
        }),
    }),
    adopt: cliCommand({
      summary: "Move the ideas and scratchpad of a deleted Space into a live Space",
      positionals: [{ name: "old-space", description: "Id of the deleted Space", required: true }, SPACE_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input, ctx) =>
        attempt(async () => {
          requireOwner(ctx);
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const result = await handlers.adoptOrphanSpace({ oldSpaceId: input.positionals["old-space"], spaceId });
          return render(input.options.json, result, [
            `Moved ${result.ideasMoved} ideas; scratchpad ${result.scratchpadAppended ? "appended" : "unchanged"}.`,
          ]);
        }),
    }),
  };
}
