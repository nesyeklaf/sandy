import { z } from "zod";

export const SEARCH_SCOPES = ["both", "name", "content"] as const;
export const searchScopeSchema = z.enum(SEARCH_SCOPES);
export type SearchScope = z.infer<typeof searchScopeSchema>;

export const searchRpcShape = {
  searchSessions: {
    input: z.object({ query: z.string().trim().min(1).max(200), scope: searchScopeSchema }).strict(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
};
