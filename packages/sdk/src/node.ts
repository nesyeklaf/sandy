import { loadCliConfig, type CliConfig } from "@sandy/config/cli";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@sandy/host-daemon-contract";
import { createGuideArea } from "./areas/guide.js";
import { createSandySdk, type SandySdk, type SandySdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_SANDY_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  SandyRealtimeSocketFactory,
  SandySdkContext,
  SandySdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  cliConfig?: CliConfig;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: SandyRealtimeSocketFactory;
}

export interface CreateNodeSandySdkArgs extends CreateNodeTransportArgs {
  context?: SandySdkContext;
}

export interface FetchLocalHostIdArgs {
  cliConfig?: CliConfig;
  hostDaemonUrl?: string;
}

function resolveCliConfig(cliConfig?: CliConfig): CliConfig {
  return cliConfig ?? loadCliConfig();
}

function resolveHostDaemonUrl(cliConfig?: CliConfig): string {
  const config = resolveCliConfig(cliConfig);
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.SANDY_HOST_DAEMON_PORT}`;
}

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): SandySdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl ?? resolveCliConfig(args.cliConfig).SANDY_SERVER_URL,
    fetch:
      args.fetch ??
      createRequestTimeoutFetch({
        timeoutMs: args.timeoutMs ?? DEFAULT_SANDY_REQUEST_TIMEOUT_MS,
      }),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket: args.websocket ?? createNodeWebsocketFactory(),
  });
}

export function createNodeSandySdk(args: CreateNodeSandySdkArgs = {}): SandySdk {
  return createSandySdk({
    context: args.context,
    guide: createGuideArea(),
    transport: createNodeTransport(args),
  });
}

export async function fetchLocalHostId(
  args: FetchLocalHostIdArgs = {},
): Promise<string | null> {
  try {
    const client = createHostDaemonLocalClient(
      args.hostDaemonUrl ?? resolveHostDaemonUrl(args.cliConfig),
    );
    const response = await client.status.$get();
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body.hostId;
  } catch {
    return null;
  }
}

export {
  createSandySdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_SANDY_REQUEST_TIMEOUT_MS,
};
export { SandyHttpError, SandyRequestTimeoutError } from "./response.js";
export {
  pluginMutationResponseSchema,
  type PluginMutationResponse,
} from "./areas/plugins.js";
export { createBuiltinPlanCommandTextInput } from "./core.js";
export { createGuideArea } from "./areas/guide.js";
export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
export type {
  SandySdk,
  SandySdkAreas,
  SandySdkContext,
  SandySdkTransport,
  FetchImplementation,
};
export type * from "./areas/skills.js";
export type {
  SandyRealtimeSocket,
  SandyRealtimeSocketFactory,
  SandyRealtimeSocketMessageEvent,
} from "./transport.js";
export type { SandyHttpErrorArgs } from "./response.js";
export type * from "./public-types.js";
