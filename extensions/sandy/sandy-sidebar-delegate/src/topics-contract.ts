import { z } from "zod";

const threadId = z.string().trim().min(1);
const seq = z.number().int().min(0);
const tag = z.string().trim().min(1).max(40);

export const topicMessageSchema = z.object({
  seq,
  role: z.enum(["user", "assistant"]),
  preview: z.string(),
  lines: z.number().int(),
  words: z.number().int(),
  tokens: z.number().int(),
});
export type TopicMessage = z.infer<typeof topicMessageSchema>;

export const topicSegmentSchema = z.object({
  id: z.string(),
  threadId,
  fromSeq: seq,
  toSeq: seq,
  title: z.string(),
  tags: z.array(z.string()),
});
export type TopicSegment = z.infer<typeof topicSegmentSchema>;

/** Merged into the sidebar RPC contract; kept apart to stay inside the file budget. */
export const topicsRpcShape = {
  getThreadMessages: {
    input: z.object({ threadId }).strict(),
    output: z.object({ messages: z.array(topicMessageSchema) }),
  },
  listTopics: {
    input: z.object({ threadId }).strict(),
    output: z.object({ segments: z.array(topicSegmentSchema), threadTags: z.array(z.string()) }),
  },
  saveTopic: {
    input: z
      .object({
        threadId,
        id: z.string().optional(),
        fromSeq: seq,
        toSeq: seq,
        title: z.string().trim().min(1).max(120),
      })
      .strict(),
    output: topicSegmentSchema,
  },
  deleteTopic: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  setTopicTags: {
    input: z
      .object({ kind: z.enum(["thread", "segment"]), ownerId: z.string().min(1), tags: z.array(tag).max(20) })
      .strict(),
    output: z.object({ tags: z.array(z.string()) }),
  },
  suggestTopics: {
    input: z.object({ threadId }).strict(),
    output: z.object({
      suggestions: z.array(z.object({ fromSeq: seq, toSeq: seq, title: z.string(), tags: z.array(z.string()) })),
    }),
  },
  listAllTags: {
    input: z.object({}).strict(),
    output: z.object({
      threadTags: z.record(z.string(), z.array(z.string())),
      segments: z.array(topicSegmentSchema),
    }),
  },
};
