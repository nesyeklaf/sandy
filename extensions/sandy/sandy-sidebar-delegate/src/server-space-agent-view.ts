import type { ServerContext } from "./server-context";
import type { SpaceDeps } from "./server-space-deps";

const ORCHESTRATOR_TOOL_NAMES = [
  "space_start_session",
  "space_message_session",
  "space_stop_session",
  "space_archive_session",
  "space_idea_delete",
] as const;

const MEMBER_TOOL_NAMES = [
  "space_context",
  "space_ideas_list",
  "space_idea_create",
  "space_idea_update",
  "space_scratchpad_read",
  "space_scratchpad_write",
] as const;

const SECTION_CACHE_ENTRIES_MAX = 5000;

const ORCHESTRATOR_INSTRUCTIONS = [
  "The owner made this session an orchestrator of its Space.",
  "Call space_context to see the members, their status, environments and branches, the ideas and the scratchpad revision.",
  "You may start sessions with space_start_session, and message, stop or archive members the owner marked Managed. Independent members are refused: only the owner can switch a member to Managed.",
  "Keep the plan in the Space scratchpad and the work items in Space ideas. Do not start sessions or ideas the owner did not ask for.",
].join("\n");

const MEMBER_INSTRUCTIONS = [
  "This session belongs to a Space shared with other sessions.",
  "space_context shows the other members and the ideas; space_ideas_list, space_idea_create and space_idea_update keep the Space's ideas; space_scratchpad_read and space_scratchpad_write share a revisioned Markdown scratchpad.",
  "Write each idea so someone without this chat can pick it up: a title, the problem and what done looks like.",
].join("\n");

export function createAgentView(ctx: ServerContext, deps: SpaceDeps) {
  const sectionByThread = new Map<string, string | null>();

  function remember(thread: { id: string; sectionId: string | null }): void {
    sectionByThread.delete(thread.id);
    sectionByThread.set(thread.id, thread.sectionId);
    if (sectionByThread.size > SECTION_CACHE_ENTRIES_MAX) {
      const oldest = sectionByThread.keys().next();
      if (oldest.done !== true) sectionByThread.delete(oldest.value);
    }
  }

  const rememberEvent = ({ thread }: { thread: { id: string; sectionId: string | null } }) => remember(thread);
  ctx.sandy.events.on("thread.created", rememberEvent);
  ctx.sandy.events.on("thread.active", rememberEvent);
  ctx.sandy.events.on("thread.idle", rememberEvent);
  ctx.sandy.events.on("thread.failed", rememberEvent);
  ctx.sandy.events.on("thread.unarchived", rememberEvent);
  ctx.sandy.events.on("thread.deleted", ({ thread }) => {
    sectionByThread.delete(thread.id);
  });

  ctx.sandy.agents.configure(({ thread }) => {
    if (deps.roles.orchestratorSpaceOf(thread.id) !== null) {
      return {
        tools: [...MEMBER_TOOL_NAMES, ...ORCHESTRATOR_TOOL_NAMES],
        skills: [],
        instructions: ORCHESTRATOR_INSTRUCTIONS,
      };
    }
    if (sectionByThread.get(thread.id) === null) return { tools: [], skills: [] };
    return { tools: [...MEMBER_TOOL_NAMES], skills: [], instructions: MEMBER_INSTRUCTIONS };
  });
}
