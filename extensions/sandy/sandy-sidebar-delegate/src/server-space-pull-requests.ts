import { z } from "zod";
import type { ServerContext } from "./server-context";
import { GITHUB_PR_STATUS_PLUGIN_ID, MAX_PULL_REQUEST_KEYS } from "./github-pr-status";
import { spacePrOfRow, type SpacePrState } from "./spaces-model";

const LOOKUP_TIMEOUT_MS = 20_000;

export async function lookUpPullRequestOutcomes(
  ctx: ServerContext,
  environmentIds: readonly string[],
): Promise<{ availability: "available" | "unavailable"; outcomes: Map<string, SpacePrState> }> {
  const outcomes = new Map<string, SpacePrState>();
  let failed = false;
  const batches: string[][] = [];
  for (let start = 0; start < environmentIds.length; start += MAX_PULL_REQUEST_KEYS) {
    batches.push(environmentIds.slice(start, start + MAX_PULL_REQUEST_KEYS));
  }
  await Promise.all(
    batches.map(async (keys) => {
      let rows: Record<string, unknown>;
      try {
        rows = await ctx.sandy.sdk.plugins.callRpc({
          pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
          method: "pullRequests",
          input: { keys },
          outputSchema: z.record(z.string(), z.unknown()),
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
      } catch {
        failed = true;
        return;
      }
      for (const key of keys) {
        outcomes.set(key, spacePrOfRow(rows[key]));
      }
    }),
  );
  const incomplete = failed || [...outcomes.values()].includes("unknown");
  return { availability: incomplete ? "unavailable" : "available", outcomes };
}
