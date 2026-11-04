import { z } from "zod";

export const lastMessageRpcShape = {
  listLastMessages: {
    input: z.object({ threadIds: z.array(z.string()) }).strict(),
    output: z.object({ messages: z.array(z.object({ threadId: z.string(), text: z.string() })) }),
  },
};
