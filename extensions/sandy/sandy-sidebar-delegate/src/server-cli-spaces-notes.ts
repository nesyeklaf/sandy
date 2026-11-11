import { cliCommand } from "@sandy-sdk/plugin-sdk";
import { IDEA_STATUSES } from "./space-coordination-contract";
import { attempt, JSON_OPTION, jsonResult, render, resolveSpaceId } from "./server-cli-spaces-support";
import type { createSpaceHandlers } from "./server-space-handlers";
import type { ServerSpace } from "./server-space";

type Handlers = ReturnType<typeof createSpaceHandlers>;

const SPACE_POSITIONAL = { name: "space", description: "Space id or exact name", required: true } as const;
const IDEA_POSITIONAL = { name: "idea", description: "Idea id", required: true } as const;
const THREADS_OPTION = {
  type: "string",
  repeatable: true,
  split: ",",
  placeholder: "id",
  description: "Linked session ids, comma separated; replaces the links",
} as const;

export function createSpaceIdeaCommands(space: ServerSpace, handlers: Handlers) {
  return {
    "ideas list": cliCommand({
      summary: "List the ideas of a Space",
      positionals: [SPACE_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const result = await handlers.listIdeas({ spaceId });
          const lines = result.ideas.map((idea) => `${idea.id} [${idea.status}] ${idea.title}`);
          return render(input.options.json, result, lines.length === 0 ? ["No ideas."] : lines);
        }),
    }),
    "ideas add": cliCommand({
      summary: "Add an idea to a Space",
      positionals: [SPACE_POSITIONAL],
      options: {
        title: { type: "string", required: true, description: "Idea title, up to 200 characters" },
        body: { type: "string", stdin: true, description: "Idea body, up to 16384 bytes" },
        thread: THREADS_OPTION,
        json: JSON_OPTION,
      },
      run: (input) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const idea = await handlers.createIdea({
            spaceId,
            title: input.options.title,
            body: input.options.body ?? "",
            threadIds: input.options.thread ?? [],
          });
          return render(input.options.json, idea, [`Created idea ${idea.id}.`]);
        }),
    }),
    "ideas update": cliCommand({
      summary: "Change an idea",
      positionals: [IDEA_POSITIONAL],
      options: {
        title: { type: "string", description: "New title" },
        body: { type: "string", stdin: true, description: "New body" },
        status: { type: "enum", values: IDEA_STATUSES, description: "New status" },
        thread: THREADS_OPTION,
        unlink: { type: "boolean", description: "Remove every linked session" },
        json: JSON_OPTION,
      },
      constraints: [{ kind: "at-most-one", options: ["thread", "unlink"] }],
      run: (input) =>
        attempt(async () => {
          const threadIds = input.options.unlink ? [] : input.options.thread;
          const idea = await handlers.updateIdea({
            ideaId: input.positionals.idea,
            ...(input.options.title === undefined ? {} : { title: input.options.title }),
            ...(input.options.body === undefined ? {} : { body: input.options.body }),
            ...(input.options.status === undefined
              ? {}
              : { status: input.options.status as (typeof IDEA_STATUSES)[number] }),
            ...(threadIds === undefined || (threadIds.length === 0 && !input.options.unlink) ? {} : { threadIds }),
          });
          return render(input.options.json, idea, [`Updated idea ${idea.id} [${idea.status}].`]);
        }),
    }),
    "ideas remove": cliCommand({
      summary: "Delete an idea",
      positionals: [IDEA_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const result = await handlers.deleteIdea({ ideaId: input.positionals.idea });
          return render(input.options.json, result, [result.deleted ? "Idea deleted." : "No such idea."]);
        }),
    }),
    ...createScratchpadCommands(space, handlers),
  };
}

function createScratchpadCommands(space: ServerSpace, handlers: Handlers) {
  return {
    "scratchpad show": cliCommand({
      summary: "Print the scratchpad of a Space",
      positionals: [SPACE_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const pad = await handlers.getScratchpad({ spaceId });
          return render(input.options.json, pad, [`Revision ${pad.revision}`, pad.body]);
        }),
    }),
    "scratchpad write": cliCommand({
      summary: "Replace the scratchpad when --base-revision equals the current revision",
      positionals: [SPACE_POSITIONAL],
      options: {
        body: { type: "string", required: true, stdin: true, description: "New Markdown text, up to 65536 bytes" },
        "base-revision": {
          type: "integer",
          min: 0,
          max: 2_000_000_000,
          required: true,
          description: "Revision this text was based on; 0 for a new scratchpad",
        },
        json: JSON_OPTION,
      },
      run: (input) =>
        attempt(async () => {
          const spaceId = await resolveSpaceId(space, input.positionals.space);
          const result = await handlers.writeScratchpad({
            spaceId,
            body: input.options.body,
            baseRevision: input.options["base-revision"],
          });
          if (result.status === "conflict") {
            const conflict = input.options.json
              ? jsonResult(result)
              : {
                  exitCode: 0,
                  stdout: `Conflict: revision is ${result.scratchpad.revision}.\n${result.scratchpad.body}\n`,
                };
            return { ...conflict, exitCode: 1 };
          }
          return render(input.options.json, result, [`Written, revision ${result.scratchpad.revision}.`]);
        }),
    }),
  };
}
