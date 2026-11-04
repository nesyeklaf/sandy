import { z } from "zod";

export const orchestratorsRpcShape = {
  listOrchestrators: {
    input: z.object({}).strict(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
  setOrchestrator: {
    input: z
      .object({ threadIds: z.array(z.string().trim().min(1)).min(1).max(500), orchestrator: z.boolean() })
      .strict(),
    output: z.object({ changed: z.array(z.string()) }),
  },
};
