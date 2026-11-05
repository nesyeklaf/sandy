import { IDEAS_CHANNEL } from "./realtime-channels";
import type { ServerContext, ServerHandlers } from "./server-context";
import { releaseIdleRuntimes } from "./server-session-roles";
import { createThreadMarks, threadMarksMigration } from "./server-thread-marks";

export const IDEAS_MIGRATIONS = [threadMarksMigration("thread_ideas")];

export function createServerIdeas(ctx: ServerContext) {
  const marks = createThreadMarks(ctx, "thread_ideas", IDEAS_CHANNEL);
  const handlers = {
    async listIdeas() {
      return { threadIds: marks.list() };
    },
    async setIdea({ threadIds, idea }) {
      const changed = marks.set(threadIds, idea);
      void releaseIdleRuntimes(ctx, changed).catch(() => undefined);
      return { changed };
    },
  } satisfies Pick<ServerHandlers, "listIdeas" | "setIdea">;
  return { handlers, marks };
}
