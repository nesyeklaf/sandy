import type { SearchScope } from "./search-contract";
import type { ServerContext, ServerHandlers } from "./server-context";

const NAME_KINDS: ReadonlySet<string> = new Set(["title", "title_fallback"]);
const CONTENT_KINDS: ReadonlySet<string> = new Set(["user_message", "assistant_message", "system_message"]);
const RESULT_LIMIT = "50";

function kindsFor(scope: SearchScope): ReadonlySet<string> {
  if (scope === "name") return NAME_KINDS;
  if (scope === "content") return CONTENT_KINDS;
  return new Set([...NAME_KINDS, ...CONTENT_KINDS]);
}

export function createServerSessionSearch(ctx: ServerContext) {
  const handlers = {
    async searchSessions({ query, scope }) {
      const wanted = kindsFor(scope);
      const found = await ctx.sandy.sdk.threads.search({ query, limitPerGroup: RESULT_LIMIT });
      const threadIds = found.active.results
        .filter((result) => result.matches.some((match) => wanted.has(match.sourceKind)))
        .map((result) => result.thread.id);
      return { threadIds };
    },
  } satisfies Pick<ServerHandlers, "searchSessions">;
  return { handlers };
}
