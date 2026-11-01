import { createBrowserSandySdk } from "@sandy/sdk/browser";
import { fetchWithAppSurface } from "./app-surface";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const sdk = createBrowserSandySdk({
  baseUrl: BASE_URL,
  fetch: fetchWithAppSurface,
});

export { SandyHttpError } from "@sandy/sdk/browser";
