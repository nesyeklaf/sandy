import { z } from "zod";

const threadId = z.string().trim().min(1);
const tag = z.string().trim().min(1).max(40);

const ANCHOR_KINDS = ["note", "comment", "tag", "link", "bookmark"] as const;

/**
 * One mark in a session: a message, optionally a quoted piece of its text.
 * Notes are for the user, comments for agents (an agent may write one too),
 * tags and bookmarks carry a label, a link points at another anchor.
 */
export const anchorSchema = z.object({
  id: z.string(),
  threadId,
  kind: z.enum(ANCHOR_KINDS),
  messageId: z.string(),
  seq: z.number().int().min(0).nullable(),
  quote: z.string(),
  offset: z.number().int().min(0).nullable(),
  body: z.string(),
  tags: z.array(z.string()),
  targetId: z.string().nullable(),
  author: z.enum(["user", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Anchor = z.infer<typeof anchorSchema>;

/** Merged into the sidebar RPC contract, like the topics shape. */
export const anchorsRpcShape = {
  listAnchors: {
    input: z.object({ threadId }).strict(),
    output: z.object({ anchors: z.array(anchorSchema) }),
  },
  saveAnchor: {
    input: z
      .object({
        id: z.string().optional(),
        threadId,
        kind: z.enum(ANCHOR_KINDS),
        messageId: z.string().min(1),
        seq: z.number().int().min(0).nullable().optional(),
        quote: z.string().max(4000).optional(),
        offset: z.number().int().min(0).nullable().optional(),
        body: z.string().max(20000).optional(),
        tags: z.array(tag).max(20).optional(),
        targetId: z.string().nullable().optional(),
        author: z.enum(["user", "agent"]).optional(),
      })
      .strict(),
    output: anchorSchema,
  },
  deleteAnchor: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  explainSelection: {
    input: z.object({ threadId, quote: z.string().trim().min(1).max(20000) }).strict(),
    output: z.object({ text: z.string() }),
  },
  searchAnchors: {
    input: z
      .object({
        query: z.string().max(200).optional(),
        kind: z.enum(ANCHOR_KINDS).optional(),
        threadId: threadId.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: z.object({ anchors: z.array(anchorSchema) }),
  },
};
