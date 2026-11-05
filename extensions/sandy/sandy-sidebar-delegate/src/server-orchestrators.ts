import { ORCHESTRATORS_CHANNEL } from "./realtime-channels";
import type { ServerContext, ServerHandlers } from "./server-context";
import { releaseIdleRuntimes } from "./server-session-roles";
import { createThreadMarks, threadMarksMigration } from "./server-thread-marks";

export const ORCHESTRATORS_MIGRATIONS = [threadMarksMigration("thread_orchestrators")];

export function createServerOrchestrators(ctx: ServerContext) {
  const marks = createThreadMarks(ctx, "thread_orchestrators", ORCHESTRATORS_CHANNEL);
  const handlers = {
    async listOrchestrators() {
      return { threadIds: marks.list() };
    },
    async setOrchestrator({ threadIds, orchestrator }) {
      const changed = marks.set(threadIds, orchestrator);
      void releaseIdleRuntimes(ctx, changed).catch(() => undefined);
      return { changed };
    },
  } satisfies Pick<ServerHandlers, "listOrchestrators" | "setOrchestrator">;
  return { handlers, marks };
}
