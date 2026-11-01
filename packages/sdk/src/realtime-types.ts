import type { ChangedMessage } from "@sandy/domain";

export type SandyRealtimeUnsubscribe = () => void;

export type SandyRealtimeEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed"
  | "system:changed"
  | "system:config-changed"
  | "realtime:connection";

export type ThreadRealtimeEvent = Extract<ChangedMessage, { entity: "thread" }>;
export type ProjectRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "project" }
>;
export type EnvironmentRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "environment" }
>;
export type HostRealtimeEvent = Extract<ChangedMessage, { entity: "host" }>;
export type SystemRealtimeEvent = Extract<ChangedMessage, { entity: "system" }>;

export type SandyRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface SandyRealtimeConnectionEvent {
  reconnectDelayMs: number | null;
  reconnected: boolean;
  state: SandyRealtimeConnectionState;
}

export interface SandyRealtimeEventMap {
  "thread:changed": ThreadRealtimeEvent;
  "project:changed": ProjectRealtimeEvent;
  "environment:changed": EnvironmentRealtimeEvent;
  "host:changed": HostRealtimeEvent;
  "system:changed": SystemRealtimeEvent;
  "system:config-changed": SystemRealtimeEvent;
  "realtime:connection": SandyRealtimeConnectionEvent;
}

export type SandyRealtimeCallback<TEventName extends SandyRealtimeEventName> = (
  event: SandyRealtimeEventMap[TEventName],
) => void;

export interface ThreadRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"thread:changed">;
  event: "thread:changed";
  threadId?: string;
}

export interface ProjectRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"project:changed">;
  event: "project:changed";
  projectId?: string;
}

export interface EnvironmentRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"environment:changed">;
  environmentId?: string;
  event: "environment:changed";
}

export interface HostRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"host:changed">;
  event: "host:changed";
  hostId?: string;
}

export interface SystemRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"system:changed">;
  event: "system:changed";
}

export interface SystemConfigRealtimeSubscribeArgs {
  callback: SandyRealtimeCallback<"system:config-changed">;
  event: "system:config-changed";
}

export interface RealtimeConnectionSubscribeArgs {
  callback: SandyRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

export type SandyRealtimeSubscribeArgsUnion =
  | ThreadRealtimeSubscribeArgs
  | ProjectRealtimeSubscribeArgs
  | EnvironmentRealtimeSubscribeArgs
  | HostRealtimeSubscribeArgs
  | SystemRealtimeSubscribeArgs
  | SystemConfigRealtimeSubscribeArgs
  | RealtimeConnectionSubscribeArgs;

export type SandyRealtimeSubscribeArgs<
  TEventName extends SandyRealtimeEventName = SandyRealtimeEventName,
> = Extract<SandyRealtimeSubscribeArgsUnion, { event: TEventName }>;

export interface SandyRealtime {
  subscribe<TEventName extends SandyRealtimeEventName>(
    args: SandyRealtimeSubscribeArgs<TEventName>,
  ): SandyRealtimeUnsubscribe;
}
