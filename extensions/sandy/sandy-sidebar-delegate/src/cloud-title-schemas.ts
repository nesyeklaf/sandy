import { z } from "zod";

export const cloudOverviewSchema = z.object({
  enabled: z.boolean(),
  status: z.discriminatedUnion("ready", [
    z.object({ ready: z.literal(true) }),
    z.object({ ready: z.literal(false), message: z.string() }),
  ]),
});
export const accountFetchSchema = z.object({ status: z.number().int(), body: z.json().nullable() });
export const completionSchema = z.object({ text: z.string() });
export const failureSchema = z.object({ error: z.object({ message: z.string() }) });
