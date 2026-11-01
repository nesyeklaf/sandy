import {
  createSandySdk,
  createBuiltinPlanCommandTextInput,
  type SandySdk,
  type SandySdkAreas,
} from "./core.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  SandyRealtimeSocketFactory,
  SandySdkContext,
  SandySdkTransport,
} from "./transport.js";

export interface CreateBrowserTransportArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
  realtimeUrl?: string;
  websocket?: SandyRealtimeSocketFactory;
}

export interface CreateBrowserSandySdkArgs extends CreateBrowserTransportArgs {
  context?: SandySdkContext;
}

export type BrowserSandySdk = SandySdkAreas;

export function createBrowserTransport(
  args: CreateBrowserTransportArgs = {},
): SandySdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    realtimeUrl: args.realtimeUrl,
    runtime: "browser",
    websocket: args.websocket,
  });
}

export function createBrowserSandySdk(
  args: CreateBrowserSandySdkArgs = {},
): BrowserSandySdk {
  return createSandySdk({
    context: args.context,
    transport: createBrowserTransport(args),
  });
}

export { SandyHttpError, SandyRequestTimeoutError } from "./response.js";
export type { SandyHttpErrorArgs } from "./response.js";
export { createSandySdk, createBuiltinPlanCommandTextInput, createHttpTransport };
export type { SandySdk, SandySdkAreas, SandySdkContext, SandySdkTransport };
export type * from "./areas/skills.js";
export type * from "./public-types.js";
