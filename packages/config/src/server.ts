import type { FeatureFlags } from "@sandy/domain";
import type { AppSurface } from "./app-surface.js";
import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import { loadDatabaseConfig, type DatabaseConfig } from "./database.js";
import { loadDevAppConfig } from "./dev-app.js";
import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
} from "./env.js";
import {
  SANDY_APP_URL_ENV,
  SANDY_APP_SURFACE_ENV,
  SANDY_APP_VERSION_ENV,
  SANDY_EXTERNAL_URL_ENV,
  SANDY_INHERITED_SKILLS_ROOTS_ENV,
  SANDY_SERVER_BIND_HOST_ENV,
  SANDY_SERVER_LAUNCH_ID_ENV,
  SANDY_CLI_LAUNCHER_ENV,
  SANDY_PERF_DIAGNOSTICS_ENV,
  SANDY_SKIP_ONBOARDING_ENV,
  DEFAULT_SANDY_APP_URL,
  DEFAULT_SANDY_APP_SURFACE,
  DEFAULT_SANDY_APP_VERSION,
  DEFAULT_SANDY_EXTERNAL_URL,
  DEFAULT_SANDY_SERVER_BIND_HOST,
} from "./env-vars.js";
import { loadFeatureFlags } from "./feature-flags.js";
import { assignIfDefined } from "./objects.js";
import { loadHostDaemonPortValue } from "./ports.js";
import { loadServerPortConfig, type ServerPortConfig } from "./server-port.js";

export interface ServerConfig
  extends CommonConfig, DatabaseConfig, ServerPortConfig {
  SANDY_APP_URL: string;
  SANDY_APP_SURFACE: AppSurface;
  SANDY_APP_VERSION: string;
  SANDY_DEV_APP_PORT?: number;
  SANDY_EXTERNAL_URL: string;
  SANDY_HOST_DAEMON_PORT: number;
  SANDY_INHERITED_SKILLS_ROOTS: string[];
  SANDY_SERVER_BIND_HOST: string[];
  SANDY_SERVER_LAUNCH_ID?: string;
  SANDY_CLI_LAUNCHER?: string;
  SANDY_PERF_DIAGNOSTICS: boolean;
  SANDY_SKIP_ONBOARDING: boolean;
  featureFlags: FeatureFlags;
}

type LoadServerConfigArgs = LoadCommonConfigArgs;

export {
  parseServerBindAddresses,
  parseServerBindAddressesOnThisHost,
  readWireguardAddresses,
} from "./bind-addresses.js";

export function loadServerConfig(
  args: LoadServerConfigArgs = {},
): ServerConfig {
  const loader = resolveEnvLoader(args);
  const commonConfig = loadCommonConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const databaseConfig = loadDatabaseConfig({
    commonConfig,
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const serverPortConfig = loadServerPortConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const devAppConfig = loadDevAppConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
  });
  const config: ServerConfig = {
    ...commonConfig,
    ...databaseConfig,
    ...serverPortConfig,
    SANDY_APP_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_APP_URL,
      definition: SANDY_APP_URL_ENV,
      env: loader.env,
    }),
    SANDY_APP_SURFACE: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_APP_SURFACE,
      definition: SANDY_APP_SURFACE_ENV,
      env: loader.env,
    }),
    SANDY_APP_VERSION: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_APP_VERSION,
      definition: SANDY_APP_VERSION_ENV,
      env: loader.env,
    }),
    SANDY_EXTERNAL_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_EXTERNAL_URL,
      definition: SANDY_EXTERNAL_URL_ENV,
      env: loader.env,
    }),
    SANDY_HOST_DAEMON_PORT: loadHostDaemonPortValue({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
      repoRoot: args.repoRoot,
    }),
    SANDY_INHERITED_SKILLS_ROOTS: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: [],
      definition: SANDY_INHERITED_SKILLS_ROOTS_ENV,
      env: loader.env,
    }),
    SANDY_SERVER_BIND_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_SERVER_BIND_HOST,
      definition: SANDY_SERVER_BIND_HOST_ENV,
      env: loader.env,
    }),
    SANDY_PERF_DIAGNOSTICS: readEnvVarWithDefault({
      context: loader.context,
      definition: SANDY_PERF_DIAGNOSTICS_ENV,
      env: loader.env,
      defaultValue: false,
    }),
    SANDY_SKIP_ONBOARDING: readEnvVarWithDefault({
      context: loader.context,
      definition: SANDY_SKIP_ONBOARDING_ENV,
      env: loader.env,
      defaultValue: false,
    }),
    featureFlags: loadFeatureFlags({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
  };

  assignIfDefined({
    key: "SANDY_DEV_APP_PORT",
    target: config,
    value: devAppConfig.SANDY_DEV_APP_PORT,
  });
  assignIfDefined({
    key: "SANDY_CLI_LAUNCHER",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: SANDY_CLI_LAUNCHER_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "SANDY_SERVER_LAUNCH_ID",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: SANDY_SERVER_LAUNCH_ID_ENV,
      env: loader.env,
    }),
  });

  return config;
}
