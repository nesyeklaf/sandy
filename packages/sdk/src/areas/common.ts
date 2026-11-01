import type {
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
} from "@sandy/server-contract";
import type { SandySdkTransport } from "../transport.js";

export interface CreateSdkAreaArgs {
  transport: SandySdkTransport;
}

type SignalRequestOptions = { init: { signal: AbortSignal } };

export function signalRequestArgs(
  signal: AbortSignal | undefined,
): [] | [SignalRequestOptions] {
  return signal === undefined ? [] : [{ init: { signal } }];
}

export async function readExecutionOptions(
  transport: SandySdkTransport,
  input: SystemExecutionOptionsQuery & { signal?: AbortSignal },
): Promise<SystemExecutionOptionsResponse> {
  return transport.readJson(
    transport.api.v1.system["execution-options"].$get(
      {
        query: {
          environmentId: input.environmentId,
          hostId: input.hostId,
          projectId: input.projectId,
          providerId: input.providerId,
          selectedModel: input.selectedModel,
        },
      },
      ...signalRequestArgs(input.signal),
    ),
  );
}
