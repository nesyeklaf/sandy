import { createBrowserSandySdk } from "@sandy/sdk/browser";
import { appSurfaceRequestInit } from "@/lib/app-surface";

type FetchLike = typeof fetch;

export function createPluginsClient(fetchImpl: FetchLike) {
  const fetchWithAppSurface: FetchLike = (input, init) =>
    fetchImpl.call(globalThis, input, appSurfaceRequestInit(init));
  return createBrowserSandySdk({ fetch: fetchWithAppSurface }).plugins;
}
