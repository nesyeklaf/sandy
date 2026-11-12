import type { ServerContext } from "./server-context";
import { assert } from "./assert";
import type { SpaceDeps } from "./server-space-deps";
import type { SpaceRolesService } from "./server-space-roles-service";

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

const REPORT_TOOL_NAME = "space_report";

const SECTION_CACHE_ENTRIES_MAX = 5000;
const SPACES_WARMED_MAX = 1000;

const ORCHESTRATOR_INSTRUCTIONS = [
  "The owner made this session an orchestrator of its Space.",
  "Call space_context to see the members, their status, environments and branches, the ideas and the scratchpad revision.",
  "You may start sessions with space_start_session, and message, stop or archive members the owner marked Managed. Independent members are refused: only the owner can switch a member to Managed.",
  "Keep the plan in the Space scratchpad and the work items in Space ideas. Do not start sessions or ideas the owner did not ask for.",
  "Managed members report to you with messages that start with [Space <name>] Report. Check-ins and failure notices from the Space also arrive as messages; read space_context before acting on them.",
].join("\n");

const REPORT_INSTRUCTIONS = [
  "The owner made this session a managed member: the orchestrators of its Space coordinate it.",
  "When you finish the task you were given, are blocked, or need a decision, call space_report once with the outcome (done, blocked, question or progress) and a short summary of the result or what you need. Do not report every small step.",
].join("\n");

const MEMBER_INSTRUCTIONS = [
  "This session belongs to a Space shared with other sessions.",
  "space_context shows the other members and the ideas; space_ideas_list, space_idea_create and space_idea_update keep the Space's ideas; space_scratchpad_read and space_scratchpad_write share a revisioned Markdown scratchpad.",
  "Write each idea so someone without this chat can pick it up: a title, the problem and what done looks like.",
].join("\n");

export function createAgentView(ctx: ServerContext, deps: SpaceDeps, rolesService: SpaceRolesService) {
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

  function learnInBackground(threadId: string): void {
    deps.membership.spaceOf(threadId).then(
      (spaceId) => remember({ id: threadId, sectionId: spaceId }),
      (error: unknown) => {
        ctx.sandy.log.warn(`Could not look up the Space of ${threadId}: ${String(error)}`);
      },
    );
  }

  async function warmCache(): Promise<void> {
    const names = await deps.membership.sectionNames();
    assert(names.size <= SPACES_WARMED_MAX, "more Spaces than the warm-up bound");
    for (const spaceId of names.keys()) {
      const { threads } = await deps.membership.listMembers(spaceId);
      for (const thread of threads) remember(thread);
    }
  }

  warmCache().catch((error: unknown) => {
    ctx.sandy.log.warn(`Could not warm the Space cache: ${String(error)}`);
  });

  function stillOrchestrator(threadId: string, knownSpaceId: string | null | undefined): boolean {
    const storedSpaceId = deps.roles.orchestratorSpaceOf(threadId);
    if (storedSpaceId === null) return false;
    if (knownSpaceId === storedSpaceId) return true;
    learnInBackground(threadId);
    rolesService.orchestratorSpaceOf(threadId).catch((error: unknown) => {
      ctx.sandy.log.warn(`Could not verify the orchestrator role of ${threadId}: ${String(error)}`);
    });
    return false;
  }

  ctx.sandy.agents.configure(({ thread }) => {
    assert(thread.id.length > 0, "configured thread needs an id");
    const knownSpaceId = sectionByThread.get(thread.id);
    if (stillOrchestrator(thread.id, knownSpaceId)) {
      return {
        tools: [...MEMBER_TOOL_NAMES, ...ORCHESTRATOR_TOOL_NAMES],
        skills: [],
        instructions: ORCHESTRATOR_INSTRUCTIONS,
      };
    }
    if (knownSpaceId === undefined) {
      learnInBackground(thread.id);
      return { tools: [], skills: [] };
    }
    if (knownSpaceId === null) return { tools: [], skills: [] };
    const reports =
      deps.roles.modeIn(thread.id, knownSpaceId) === "managed" && deps.roles.settingsOf(knownSpaceId).selfReports;
    if (reports) {
      return {
        tools: [...MEMBER_TOOL_NAMES, REPORT_TOOL_NAME],
        skills: [],
        instructions: `${MEMBER_INSTRUCTIONS}\n${REPORT_INSTRUCTIONS}`,
      };
    }
    return { tools: [...MEMBER_TOOL_NAMES], skills: [], instructions: MEMBER_INSTRUCTIONS };
  });
}
