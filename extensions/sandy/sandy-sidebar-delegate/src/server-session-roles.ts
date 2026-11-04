import { z } from "zod";
import type { ServerContext } from "./server-context";
import type { ThreadMarks } from "./server-thread-marks";

export const SESSION_ROLES_TOOL = "session_roles";

const THREADS_PER_LOOKUP = 100;

export const ORCHESTRATOR_INSTRUCTIONS = [
  "The owner marked this session as an orchestrator session in the sidebar.",
  "Idea sessions generate ideas: tickets, issues, files and notes. Your job is to ingest those ideas and hand them to worker sessions, then follow the workers until their work is done.",
  `Call ${SESSION_ROLES_TOOL} to list the idea sessions and orchestrator sessions with their ids, titles and status. Read an idea session with \`sandy thread messages <thread id>\`; see \`sandy guide\` for starting and messaging threads.`,
  "The orchestrator mark is the owner's standing request to start worker sessions and message them for these ideas.",
].join("\n");

export const IDEA_INSTRUCTIONS = [
  "The owner marked this session as an idea session in the sidebar.",
  "It exists to generate ideas: tickets, issues, files and notes. An orchestrator session ingests them and hands them to worker sessions.",
  "Write each idea so an orchestrator can pick it up without this chat: a title, the problem, and what done looks like. Do not implement the ideas in this session unless the owner asks.",
].join("\n");

export async function releaseIdleRuntimes(ctx: ServerContext, threadIds: readonly string[]) {
  if (threadIds.length === 0) return;
  const threads = await ctx.sandy.sdk.threads.list({
    threadIds: [...threadIds],
    includeHidden: true,
    archived: false,
    limit: threadIds.length,
  });
  for (const thread of threads) {
    if (thread.status !== "idle") continue;
    await ctx.sandy.sdk.threads.stop({ threadId: thread.id }).catch((error: unknown) => {
      ctx.sandy.log.warn(`Could not release ${thread.id} after a role change: ${String(error)}`);
    });
  }
}

export function sessionRoleConfiguration(threadId: string, ideas: ThreadMarks, orchestrators: ThreadMarks) {
  if (orchestrators.has(threadId)) {
    return { tools: [SESSION_ROLES_TOOL], skills: [], instructions: ORCHESTRATOR_INSTRUCTIONS };
  }
  if (ideas.has(threadId)) return { tools: [], skills: [], instructions: IDEA_INSTRUCTIONS };
  return { tools: [], skills: [] };
}

export function registerSessionRoles(ctx: ServerContext, ideas: ThreadMarks, orchestrators: ThreadMarks) {
  const describe = async (ids: readonly string[]) => {
    const rows: Array<{ id: string; title: string; status: string }> = [];
    for (let start = 0; start < ids.length; start += THREADS_PER_LOOKUP) {
      const chunk = ids.slice(start, start + THREADS_PER_LOOKUP);
      const threads = await ctx.sandy.sdk.threads.list({
        threadIds: [...chunk],
        includeHidden: true,
        archived: false,
        limit: chunk.length,
      });
      for (const thread of threads) {
        rows.push({ id: thread.id, title: thread.title ?? "", status: thread.status });
      }
    }
    return rows;
  };

  ctx.sandy.agents.registerTool({
    name: SESSION_ROLES_TOOL,
    description:
      "List the sessions the owner marked as idea sessions and as orchestrator sessions, with id, title and status.",
    parameters: z.object({}).strict(),
    async execute() {
      const [ideaSessions, orchestratorSessions] = await Promise.all([
        describe(ideas.list()),
        describe(orchestrators.list()),
      ]);
      return JSON.stringify({ ideaSessions, orchestratorSessions }, null, 2);
    },
  });

  ctx.sandy.agents.configure(({ thread }) => sessionRoleConfiguration(thread.id, ideas, orchestrators));
}
