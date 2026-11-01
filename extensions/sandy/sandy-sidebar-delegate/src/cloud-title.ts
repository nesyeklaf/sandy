import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { cloudOverviewSchema, accountFetchSchema, completionSchema, failureSchema } from "./cloud-title-schemas";

/** Use the same authenticated gateway as sandy-ai, without reading credentials. */
export async function completeCloudTitle(sandy: SandyPluginApi, prompt: string, signal: AbortSignal) {
  const overview = await sandy.sdk.plugins.callRpc({
    pluginId: "sandy-ai",
    method: "overview",
    input: null,
    outputSchema: cloudOverviewSchema,
    signal,
  });
  if (!overview.enabled) throw new Error("sandy cloud is off. Turn it on with `sandy ai on`.");
  if (!overview.status.ready) throw new Error(overview.status.message);
  signal.throwIfAborted();
  const response = await sandy.sdk.plugins.callRpc({
    pluginId: "sandy-account",
    method: "sandy-account.v1.fetch",
    input: {
      target: "api",
      method: "POST",
      path: "/api/ai/v1/complete",
      body: { prompt },
      timeoutMs: 5_000,
    },
    outputSchema: accountFetchSchema,
    signal,
  });
  if (response.status !== 200) {
    const failure = failureSchema.safeParse(response.body);
    throw new Error(failure.success ? failure.data.error.message : `sandy cloud request failed (${response.status})`);
  }
  const completion = completionSchema.safeParse(response.body);
  if (!completion.success) throw new Error("sandy cloud returned an invalid reply");
  return completion.data.text;
}
