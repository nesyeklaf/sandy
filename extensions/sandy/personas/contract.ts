import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const preset = z.object({ id: z.string(), name: z.string(), icon: z.string(), skill: z.string().nullable() });
const selection = z.object({ persona: z.string().nullable(), skills: z.array(z.string()).max(32) });

const presetState = z.object({
      dir: z.string(),
      personas: z.array(preset),
      skills: z.array(preset),
      problems: z.array(z.string()),
      selection,
      length: z.number(),
      limit: z.number(),
      warnings: z.array(z.string()),
});
export type PresetState = z.infer<typeof presetState>;

export const rpcContract = defineRpcContract({
  /** Library, current selection and the assembled block's size for one scope. */
  state: {
    input: z.object({ scope: z.string() }),
    output: presetState,
  },
  select: {
    input: z.object({ scope: z.string(), selection }),
    output: z.object({ ok: z.boolean() }),
  },
});
