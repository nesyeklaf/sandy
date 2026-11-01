import { loadServerPortValue, type RuntimePortLoaderArgs } from "./ports.js";

export interface ServerPortConfig {
  SANDY_SERVER_PORT: number;
}

type LoadServerPortConfigArgs = RuntimePortLoaderArgs;

export function loadServerPortConfig(
  args: LoadServerPortConfigArgs = {},
): ServerPortConfig {
  return {
    SANDY_SERVER_PORT: loadServerPortValue(args),
  };
}
