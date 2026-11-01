import { DEFAULTS } from "./defaults.js";
import {
  readEnvVarWithDefault,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import { SANDY_APP_VERSION_ENV, SANDY_OTLP_ENDPOINT_ENV } from "./env-vars.js";

export interface OtlpConfig {
  SANDY_APP_VERSION: string;
  SANDY_OTLP_ENDPOINT: string | null;
}

export function loadOtlpConfig(args: EnvLoaderArgs = {}): OtlpConfig {
  const loader = resolveEnvLoader(args);
  return {
    SANDY_APP_VERSION: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULTS.appVersion,
      definition: SANDY_APP_VERSION_ENV,
      env: loader.env,
    }),
    SANDY_OTLP_ENDPOINT: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: null,
      definition: SANDY_OTLP_ENDPOINT_ENV,
      env: loader.env,
    }),
  };
}

export function otlpServiceName(component: string): string {
  return `sandy-${component}`;
}

export function otlpSignalUrl(
  endpoint: string,
  signal: "logs" | "metrics" | "traces",
): string {
  return `${endpoint}/v1/${signal}`;
}
