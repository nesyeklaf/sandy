import { z } from "zod";

export const orderedThreadIdsSchema = z
  .array(z.string().trim().min(1))
  .max(10_000)
  .superRefine((threadIds, context) => {
    if (new Set(threadIds).size !== threadIds.length) {
      context.addIssue({
        code: "custom",
        message: "Thread ids must be unique",
      });
    }
  });
export const threadIdsSchema = orderedThreadIdsSchema.min(1);
const bulkChangeSchema = z
  .object({ changed: z.array(z.string()), failed: z.array(z.string()), undoToken: z.string().uuid() })
  .strict();

/** Merged into the sidebar RPC contract; kept apart to stay inside the file budget. */
export const bulkRpcShape = {
  pinThreads: {
    input: z.object({ threadIds: threadIdsSchema, pinned: z.boolean() }).strict(),
    output: bulkChangeSchema,
  },
  snoozeThreads: {
    input: z.object({ threadIds: threadIdsSchema, snoozedUntil: z.number().int().positive() }).strict(),
    output: bulkChangeSchema,
  },
  undoBulkAction: {
    input: z.object({ undoToken: z.string().uuid() }).strict(),
    output: z.object({ restored: z.array(z.string()), failed: z.array(z.string()) }).strict(),
  },
};
