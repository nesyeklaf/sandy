import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { SPACE_SHELVES } from "./spaces-model";

const spaceSignalsSchema = z.object({
  needs: z.boolean(),
  failed: z.boolean(),
  working: z.boolean(),
  openPr: z.boolean(),
  dormant: z.boolean(),
});
const spaceOverviewSchema = z.object({
  pullRequests: z.enum(["available", "unavailable"]),
  spaces: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string(),
      total: z.number().int(),
      counts: z.object({
        needs: z.number().int(),
        failed: z.number().int(),
        working: z.number().int(),
        openPr: z.number().int(),
        dormant: z.number().int(),
      }),
      idle: z.number().int(),
      repositories: z.number().int(),
      roots: z.array(
        z.object({
          rootId: z.string(),
          projectId: z.string(),
          shelf: z.enum(SPACE_SHELVES),
          signals: spaceSignalsSchema,
        }),
      ),
    }),
  ),
});

export const spaceOverviewRpcContract = defineRpcContract({
  getSpaceOverview: {
    input: z.object({ projectId: z.string().min(1).optional() }).strict(),
    output: spaceOverviewSchema,
  },
});
