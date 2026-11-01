import type { ApiClient } from "@sandy/server-contract";
import type {
  FetchImplementation,
  JsonBodyOf,
  SdkResponseLike,
} from "./response.js";

export type SandySdkRuntime = "node" | "browser";

export interface SandySdkTransport {
  api: ApiClient["api"];
  baseUrl: string;
  fetch: FetchImplementation;
  realtimeUrl?: string;
  runtime: SandySdkRuntime;
  readJson<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<JsonBodyOf<TResponse>>;
  readVoid<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<void>;
  resolve<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<TResponse>;
  websocket?: SandyRealtimeSocketFactory;
}

export interface SandyRealtimeSocketMessageEvent {
  data: unknown;
}

export interface SandyRealtimeSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: SandyRealtimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: string): void;
}

export type SandyRealtimeSocketFactory = (url: string) => SandyRealtimeSocket;

export interface SandySdkContext {}

export interface CreateHttpTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  runtime: SandySdkRuntime;
  websocket?: SandyRealtimeSocketFactory;
}
