import {
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  SANDY_SERVER_HEADERS_ENV,
  SANDY_BRIDGE_DIR_ENV,
  SANDY_CLI_DIR_ENV,
  SANDY_HOST_ENROLL_KEY_ENV,
  SANDY_HOST_DAEMON_AUTO_UPDATE_ENV,
  SANDY_HOST_DAEMON_SUPERVISED_ENV,
  SANDY_HOST_ID_ENV,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

export interface HostDaemonEntrypointConfig {
  SANDY_BRIDGE_DIR?: string;
  SANDY_CLI_DIR?: string;
  SANDY_SERVER_HEADERS?: Record<string, string>;
  SANDY_HOST_ENROLL_KEY?: string;
  SANDY_HOST_DAEMON_AUTO_UPDATE?: boolean;
  SANDY_HOST_DAEMON_SUPERVISED?: boolean;
  SANDY_HOST_ID?: string;
}

type LoadHostDaemonEntrypointConfigArgs = EnvLoaderArgs;

export function loadHostDaemonEntrypointConfig(
  args: LoadHostDaemonEntrypointConfigArgs = {},
): HostDaemonEntrypointConfig {
  const loader = resolveEnvLoader(args);
  const config: HostDaemonEntrypointConfig = {};
  const bridgeDir = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_BRIDGE_DIR_ENV,
    env: loader.env,
  });
  const cliDir = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_CLI_DIR_ENV,
    env: loader.env,
  });
  const enrollKey = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_HOST_ENROLL_KEY_ENV,
    env: loader.env,
  });
  const autoUpdate = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_HOST_DAEMON_AUTO_UPDATE_ENV,
    env: loader.env,
  });
  const supervised = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_HOST_DAEMON_SUPERVISED_ENV,
    env: loader.env,
  });
  const serverHeaders = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_SERVER_HEADERS_ENV,
    env: loader.env,
  });
  const hostId = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_HOST_ID_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "SANDY_BRIDGE_DIR",
    target: config,
    value: bridgeDir,
  });
  assignIfDefined({
    key: "SANDY_CLI_DIR",
    target: config,
    value: cliDir,
  });
  assignIfDefined({
    key: "SANDY_SERVER_HEADERS",
    target: config,
    value: serverHeaders,
  });
  assignIfDefined({
    key: "SANDY_HOST_DAEMON_AUTO_UPDATE",
    target: config,
    value: autoUpdate,
  });
  assignIfDefined({
    key: "SANDY_HOST_DAEMON_SUPERVISED",
    target: config,
    value: supervised,
  });
  assignIfDefined({
    key: "SANDY_HOST_ENROLL_KEY",
    target: config,
    value: enrollKey,
  });
  assignIfDefined({
    key: "SANDY_HOST_ID",
    target: config,
    value: hostId,
  });
  return config;
}
