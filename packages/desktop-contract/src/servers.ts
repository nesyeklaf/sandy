import { z } from "zod";

export const sandyDesktopServerChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1),
    origin: z.url(),
    kind: z.enum(["local", "account", "custom"]),
    active: z.boolean(),
  })
  .strict();
export const sandyDesktopServerChoicesSchema = z.array(
  sandyDesktopServerChoiceSchema,
);
export type SandyDesktopServerChoice = z.infer<typeof sandyDesktopServerChoiceSchema>;
