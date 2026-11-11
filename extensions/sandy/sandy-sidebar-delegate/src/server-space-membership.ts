import { assert } from "./assert";
import { SPACE_MEMBERS_LISTED_MAX, THREAD_IDS_PER_LOOKUP_MAX } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";

export type MemberThread = Awaited<ReturnType<ServerContext["sandy"]["sdk"]["threads"]["list"]>>[number];

interface SpaceMembers {
  threads: MemberThread[];
  truncated: boolean;
}

export function createSpaceMembership(ctx: ServerContext) {
  async function listByIds(threadIds: readonly string[], archived: boolean): Promise<MemberThread[]> {
    const found: MemberThread[] = [];
    const batchCount = Math.ceil(threadIds.length / THREAD_IDS_PER_LOOKUP_MAX);
    for (let batch = 0; batch < batchCount; batch += 1) {
      const start = batch * THREAD_IDS_PER_LOOKUP_MAX;
      const ids = threadIds.slice(start, start + THREAD_IDS_PER_LOOKUP_MAX);
      const threads = await ctx.sandy.sdk.threads.list({
        threadIds: ids,
        includeHidden: true,
        archived,
        limit: ids.length,
      });
      found.push(...threads);
    }
    return found;
  }

  async function threadsById(threadIds: readonly string[]): Promise<Map<string, MemberThread>> {
    const unique = [...new Set(threadIds)];
    const found = new Map<string, MemberThread>();
    for (const thread of await listByIds(unique, false)) found.set(thread.id, thread);
    const missing = unique.filter((threadId) => !found.has(threadId));
    for (const thread of await listByIds(missing, true)) found.set(thread.id, thread);
    return found;
  }

  return {
    threadsById,

    async spaceOf(threadId: string): Promise<string | null> {
      assert(threadId.length > 0, "threadId must not be empty");
      const thread = (await threadsById([threadId])).get(threadId);
      return thread === undefined ? null : thread.sectionId;
    },

    async spacesOf(threadIds: readonly string[]): Promise<Map<string, string | null>> {
      const threads = await threadsById(threadIds);
      return new Map(threadIds.map((threadId) => [threadId, threads.get(threadId)?.sectionId ?? null]));
    },

    async listMembers(spaceId: string): Promise<SpaceMembers> {
      assert(spaceId.length > 0, "spaceId must not be empty");
      const threads: MemberThread[] = [];
      const pageCount = Math.ceil(SPACE_MEMBERS_LISTED_MAX / THREAD_IDS_PER_LOOKUP_MAX);
      let truncated = false;
      for (let page = 0; page < pageCount; page += 1) {
        const batch = await ctx.sandy.sdk.threads.list({
          sectionId: spaceId,
          includeHidden: true,
          archived: false,
          limit: THREAD_IDS_PER_LOOKUP_MAX,
          offset: page * THREAD_IDS_PER_LOOKUP_MAX,
        });
        threads.push(...batch);
        if (batch.length < THREAD_IDS_PER_LOOKUP_MAX) break;
        if (page === pageCount - 1) {
          const probe = await ctx.sandy.sdk.threads.list({
            sectionId: spaceId,
            includeHidden: true,
            archived: false,
            limit: 1,
            offset: SPACE_MEMBERS_LISTED_MAX,
          });
          truncated = probe.length > 0;
        }
      }
      assert(threads.length <= SPACE_MEMBERS_LISTED_MAX, "listed members stay within the limit");
      return { threads, truncated };
    },

    async sectionNames(): Promise<Map<string, string>> {
      const sections = await ctx.sandy.sdk.threadSections.list();
      return new Map(sections.map((section) => [section.id, section.name]));
    },
  };
}

export type SpaceMembership = ReturnType<typeof createSpaceMembership>;
