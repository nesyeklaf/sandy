import { z } from "zod";

export const ideasRpcShape = {
  listIdeas: {
    input: z.object({}).strict(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
  setIdea: {
    input: z.object({ threadIds: z.array(z.string().trim().min(1)).min(1).max(500), idea: z.boolean() }).strict(),
    output: z.object({ changed: z.array(z.string()) }),
  },
};
