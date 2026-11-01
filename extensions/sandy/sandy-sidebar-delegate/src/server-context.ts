import type { SandyPluginApi, PluginRpcHandlers } from "@sandy-sdk/plugin-sdk";
import type { sandySidebarRpcContract } from "./contract";

export interface ServerContext {
  sandy: SandyPluginApi;
  db: ReturnType<SandyPluginApi["storage"]["database"]>;
}

export type ServerHandlers = PluginRpcHandlers<typeof sandySidebarRpcContract>;
