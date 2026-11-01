import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import {
  openPortSchema,
  ownedPortTargetSchema,
  closePortsResultSchema,
  portCloseScopeSchema,
  threadPullRequestSchema,
} from "./contract";

const rootSchema = z.object({ environmentId: z.string(), path: z.string().min(1) });
export type PortRoot = z.infer<typeof rootSchema>;
export const portScanContract = defineRpcContract({
  resolveRoots: {
    input: z.object({ roots: z.array(rootSchema).max(10000) }),
    output: z.object({ roots: z.array(z.object({ environmentId: z.string(), path: z.string().min(1).nullable() })) }),
  },
  closeOwnedPorts: {
    // Optional so an older host, which drops the field, falls back to the
    // stricter thread-owned check instead of failing the call.
    input: z.object({
      root: rootSchema,
      threadId: z.string().min(1),
      ports: z.array(ownedPortTargetSchema).min(1).max(1000),
      scope: portCloseScopeSchema.optional(),
    }),
    output: closePortsResultSchema,
  },
  // The plugin's only host entry, so it also runs `gh` where the thread's
  // workspace (and its GitHub sign-in) lives.
  pullRequests: {
    input: z.object({ urls: z.array(z.string().url()).min(1).max(200) }),
    output: z.object({ pullRequests: z.array(threadPullRequestSchema) }),
  },
  scan: {
    input: z.object({ roots: z.array(rootSchema).max(10000) }),
    output: z.object({
      ports: z.array(
        openPortSchema.extend({
          environmentId: z.string(),
        }),
      ),
    }),
  },
});
