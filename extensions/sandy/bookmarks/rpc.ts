import type {
  PluginRpcCallArgs,
  PluginRpcClient,
  PluginRpcContract,
  PluginRpcResult,
} from "@sandy-sdk/plugin-sdk/app";

interface RpcEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

function errorMessage(envelope: RpcEnvelope | null): string | null {
  const error = envelope?.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
}

/**
 * The request `useRpc` sends, for callbacks that run outside React — a message
 * action's `run` has no hook context to read the client from.
 */
export function createRpcClient<Contract extends PluginRpcContract>(
  pluginId: string,
): PluginRpcClient<Contract> {
  return {
    async call<Method extends Extract<keyof Contract, string>>(
      method: Method,
      ...args: PluginRpcCallArgs<Contract[Method]>
    ): Promise<PluginRpcResult<Contract[Method]>> {
      const response = await fetch(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args[0] ?? null),
        },
      );
      const envelope = (await response
        .json()
        .catch(() => null)) as RpcEnvelope | null;
      if (!response.ok || envelope?.ok !== true) {
        throw new Error(
          errorMessage(envelope) ??
            `rpc "${method}" failed (HTTP ${response.status})`,
        );
      }
      return envelope.result as PluginRpcResult<Contract[Method]>;
    },
  };
}
