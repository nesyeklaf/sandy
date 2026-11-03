import { describe, expect, it } from "vitest";
import type { ServerContext } from "./server-context";
import { createServerSessionSearch } from "./server-session-search";

const result = (id: string, ...kinds: string[]) => ({
  thread: { id },
  matches: kinds.map((sourceKind) => ({ sourceKind, text: "", highlightRanges: [], sourceSeq: null })),
});

function setup() {
  const calls: Array<{ query: string; limitPerGroup: string }> = [];
  const ctx = {
    sandy: {
      sdk: {
        threads: {
          search: async (args: { query: string; limitPerGroup: string }) => {
            calls.push(args);
            return {
              active: {
                total: 3,
                results: [
                  result("named", "title"),
                  result("said", "user_message", "assistant_message"),
                  result("both", "title_fallback", "system_message"),
                ],
              },
              archived: { total: 1, results: [result("old", "title")] },
            };
          },
        },
      },
    },
  } as unknown as ServerContext;
  return { handlers: createServerSessionSearch(ctx).handlers, calls };
}

describe("searchSessions", () => {
  it("keeps sessions whose name matched when searching names", async () => {
    const { handlers, calls } = setup();
    expect(await handlers.searchSessions({ query: "x", scope: "name" })).toEqual({ threadIds: ["named", "both"] });
    expect(calls).toEqual([{ query: "x", limitPerGroup: "50" }]);
  });

  it("keeps sessions whose messages matched when searching content", async () => {
    const { handlers } = setup();
    expect(await handlers.searchSessions({ query: "x", scope: "content" })).toEqual({ threadIds: ["said", "both"] });
  });

  it("keeps every active match for both and leaves archived sessions out", async () => {
    const { handlers } = setup();
    expect(await handlers.searchSessions({ query: "x", scope: "both" })).toEqual({
      threadIds: ["named", "said", "both"],
    });
  });
});
