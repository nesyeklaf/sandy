import { envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const noChat = (): never => { throw new Error("Jev supplies typed judgments, not chat generation"); };

/** Auth-only native provider: /login support without advertising a chat API.
 * Pi 0.99's createProvider requires an operation API, so use the native contract
 * directly instead of inventing a chat model or an empty API implementation.
 */
export const createJevAuthProvider = (): Provider => ({
  id: "jev",
  name: "Jev (TypeSafe System One)",
  baseUrl: "https://api.typesafe.ai/v1",
  auth: { apiKey: envApiKeyAuth("TypeSafe API key", ["TYPESAFE_API_KEY"]) },
  getModels: () => [],
  stream: noChat,
  streamSimple: noChat,
});
/** The same auth-only contract for SubQ's System One route: `/login subq`. */
export const createSubqAuthProvider = (): Provider => ({
  id: "subq",
  name: "SubQ Snap (System One)",
  baseUrl: "https://api.subq.ai/v1",
  auth: { apiKey: envApiKeyAuth("SubQ API key", ["SUBQ_API_KEY"]) },
  getModels: () => [],
  stream: noChat,
  streamSimple: noChat,
});
export function registerJevAuth(pi: ExtensionAPI): void {
  // Keep lightweight test/managed adapters without provider registration usable.
  if (typeof pi.registerProvider !== "function") return;
  pi.registerProvider(createJevAuthProvider());
  pi.registerProvider(createSubqAuthProvider());
}
