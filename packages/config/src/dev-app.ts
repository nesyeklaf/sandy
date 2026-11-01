import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  SANDY_DEV_APP_HOST_ENV,
  SANDY_DEV_APP_PORT_ENV,
  DEFAULT_SANDY_DEV_APP_HOST,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

interface DevAppConfig {
  SANDY_DEV_APP_HOST: string;
  SANDY_DEV_APP_PORT?: number;
}

type LoadDevAppConfigArgs = EnvLoaderArgs;

export function loadDevAppConfig(
  args: LoadDevAppConfigArgs = {},
): DevAppConfig {
  const loader = resolveEnvLoader(args);
  const config: DevAppConfig = {
    SANDY_DEV_APP_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_DEV_APP_HOST,
      definition: SANDY_DEV_APP_HOST_ENV,
      env: loader.env,
    }),
  };
  const appPort = readOptionalEnvVar({
    context: loader.context,
    definition: SANDY_DEV_APP_PORT_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "SANDY_DEV_APP_PORT",
    target: config,
    value: appPort,
  });

  return config;
}
