import { z } from "zod";

export const SANDY_DESKTOP_MAX_FIND_TEXT_LENGTH = 1024;
export const SANDY_DESKTOP_MAX_FIND_TOP_OFFSET = 400;

export const sandyDesktopWindowFindRequestSchema = z
  .object({
    topOffset: z.number().int().min(0).max(SANDY_DESKTOP_MAX_FIND_TOP_OFFSET),
  })
  .strict();
export type SandyDesktopWindowFindRequest = z.infer<
  typeof sandyDesktopWindowFindRequestSchema
>;
