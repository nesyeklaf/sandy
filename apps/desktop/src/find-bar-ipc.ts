import { z } from "zod";
import { SANDY_DESKTOP_MAX_FIND_TEXT_LENGTH } from "@sandy/desktop-contract";

export const SANDY_DESKTOP_FIND_BAR_QUERY_CHANNEL = "sandy-desktop:find-bar:query";
export const SANDY_DESKTOP_FIND_BAR_STEP_CHANNEL = "sandy-desktop:find-bar:step";
export const SANDY_DESKTOP_FIND_BAR_CLOSE_CHANNEL = "sandy-desktop:find-bar:close";
export const SANDY_DESKTOP_FIND_BAR_RESULT_CHANNEL = "sandy-desktop:find-bar:result";
export const SANDY_DESKTOP_FIND_BAR_ACTIVATE_CHANNEL =
  "sandy-desktop:find-bar:activate";

export const findBarQueryRequestSchema = z
  .object({
    text: z.string().max(SANDY_DESKTOP_MAX_FIND_TEXT_LENGTH),
  })
  .strict();
export type FindBarQueryRequest = z.infer<typeof findBarQueryRequestSchema>;

export const findBarStepRequestSchema = z
  .object({
    forward: z.boolean(),
  })
  .strict();
export type FindBarStepRequest = z.infer<typeof findBarStepRequestSchema>;

export const findBarResultSchema = z
  .object({
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
  })
  .strict();
export type FindBarResult = z.infer<typeof findBarResultSchema>;
