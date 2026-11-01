import {
  loadCommonConfig,
  loadLogLevelConfig,
  type LoadCommonConfigArgs,
  type LogLevelConfig,
} from "./common.js";
import { loadOtlpConfig, type OtlpConfig } from "./otlp.js";

interface LoggerConfig extends LogLevelConfig, OtlpConfig {
  SANDY_DATA_DIR: string;
}

interface LoadLoggerConfigArgs extends LoadCommonConfigArgs {
  dataDir?: string;
}

export function loadLoggerConfig(
  args: LoadLoggerConfigArgs = {},
): LoggerConfig {
  const otlpConfig = loadOtlpConfig(args);
  if (args.dataDir !== undefined) {
    return {
      ...loadLogLevelConfig(args),
      ...otlpConfig,
      SANDY_DATA_DIR: args.dataDir,
    };
  }

  return { ...loadCommonConfig(args), ...otlpConfig };
}
