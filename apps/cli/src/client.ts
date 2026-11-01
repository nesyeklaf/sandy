import { createNodeSandySdk, type SandySdk } from "@sandy/sdk/node";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, init);
}

export function createCliSandySdk(baseUrl: string): SandySdk {
  return createNodeSandySdk({ baseUrl, fetch: cliFetch });
}
