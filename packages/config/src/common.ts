import { DEFAULTS } from "./defaults.js";
import {
  readEnvVarWithDefault,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import { SANDY_LOG_LEVEL_ENV } from "./env-vars.js";
import { resolveRuntimeDataDir, type SandyRuntimeMode } from "./runtime.js";

export interface LogLevelConfig {
  SANDY_LOG_LEVEL: string;
}

type LoadLogLevelConfigArgs = EnvLoaderArgs;

export interface CommonConfig extends LogLevelConfig {
  SANDY_DATA_DIR: string;
}

export interface LoadCommonConfigArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

function resolveDefaultLogLevel(mode: SandyRuntimeMode): string {
  return mode === "prod" ? DEFAULTS.logLevel.prod : DEFAULTS.logLevel.dev;
}

export function loadLogLevelConfig(
  args: LoadLogLevelConfigArgs = {},
): LogLevelConfig {
  const loader = resolveEnvLoader(args);
  return {
    SANDY_LOG_LEVEL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: resolveDefaultLogLevel(loader.mode),
      definition: SANDY_LOG_LEVEL_ENV,
      env: loader.env,
    }),
  };
}

export function loadCommonConfig(
  args: LoadCommonConfigArgs = {},
): CommonConfig {
  const loader = resolveEnvLoader(args);
  const logLevelConfig = loadLogLevelConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
  });

  return {
    ...logLevelConfig,
    SANDY_DATA_DIR: resolveRuntimeDataDir({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
      repoRoot: args.repoRoot,
    }),
  };
}
