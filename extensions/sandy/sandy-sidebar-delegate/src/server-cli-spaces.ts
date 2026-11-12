import { cliCommand, defineCli, PluginCliError } from "@sandy-sdk/plugin-sdk";
import {
  CHECK_IN_MINUTES_MAX,
  COORDINATION_MODES,
  REPORT_OUTCOMES,
  type CoordinationSettings,
} from "./space-coordination-contract";
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
        ...createSpaceCoordinationCommands(space, handlers),
        ...createSpaceIdeaCommands(space, handlers),
      },
    }),
  );
}

type Handlers = ReturnType<typeof createSpaceHandlers>;

function describeSettings(settings: CoordinationSettings): string {
  const checkIn = settings.checkInMinutes === 0 ? "off" : `every ${settings.checkInMinutes} min`;
  return `self-reports ${settings.selfReports ? "on" : "off"}, check-in ${checkIn}, failure fallback ${settings.failureFallback ? "on" : "off"}`;
}

function parseSwitch(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new PluginCliError(`--${name} must be on or off.`, { code: "invalid_value" });
}

function createSpaceCoordinationCommands(space: ServerSpace, handlers: Handlers) {
  return {
    settings: cliCommand({
      summary: "Show or change how orchestrators of a Space hear from managed members",
      positionals: [SPACE_POSITIONAL],
      options: {
        "self-reports": { type: "string", description: "on or off: managed members report with space_report" },
        "check-in-minutes": {
          type: "integer",
          min: 0,
          max: CHECK_IN_MINUTES_MAX,
          description: "Minutes between check-ins, 0 to 1440; 0 turns them off",
        },
        "failure-fallback": {
          type: "string",
          description: "on or off: tell orchestrators about failures and questions",
        },
        json: JSON_OPTION,
      },
      run: (input, ctx) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const change = {
            selfReports: parseSwitch("self-reports", input.options["self-reports"]),
            checkInMinutes: input.options["check-in-minutes"],
            failureFallback: parseSwitch("failure-fallback", input.options["failure-fallback"]),
          };
          const changing = Object.values(change).some((value) => value !== undefined);
          if (changing) requireOwner(ctx);
          if (!changing) await space.notes.authorize(actorOf(ctx), spaceId);
          const result = changing
            ? await handlers.setSpaceCoordinationSettings({ spaceId, ...change })
            : space.deps.roles.settingsOf(spaceId);
          return render(input.options.json, result, [describeSettings(result)]);
        }),
    }),
    report: cliCommand({
      summary: "Report to the orchestrators of your Space (managed sessions only)",
      positionals: [{ name: "outcome", description: REPORT_OUTCOMES.join(", "), required: true }],
      options: {
        summary: {
          type: "string",
          required: true,
          stdin: true,
          description: "Short result or what you need, up to 2000 characters",
        },
        json: JSON_OPTION,
      },
      run: (input, ctx) =>
        attempt(async () => {
          if (ctx.threadId === undefined) {
            throw new PluginCliError("Only a session can report; run it from a managed session.", {
              code: "not_member",
            });
          }
          const outcome = REPORT_OUTCOMES.find((candidate) => candidate === input.positionals.outcome);
          if (outcome === undefined) {
            throw new PluginCliError(`Outcome must be one of ${REPORT_OUTCOMES.join(", ")}.`, {
              code: "invalid_value",
            });
          }
          const result = await space.reportsService.report(ctx.threadId, outcome, input.options.summary);
          return render(input.options.json, result, [
            `Reported ${result.outcome} to ${result.deliveredTo.length} orchestrators.`,
          ]);
        }),
    }),
  };
}

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
            `${context.spaceName} (${context.spaceId}) ${describeSettings(context.settings)}`,
            `Orchestrators: ${context.orchestratorThreadIds.join(", ") || "none"}`,
            ...context.members.map(
              (member) =>
                `- ${member.threadId} ${member.mode} ${member.status} ${member.title}${member.latestReport === null ? "" : ` [report: ${member.latestReport.outcome}]`}`,
            ),
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
