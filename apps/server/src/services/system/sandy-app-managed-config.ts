import { readFile } from "node:fs/promises";
import {
  sandyAppManagedEnvFileSchema,
  formatSandyAppConfigPath,
  formatSandyAppEnvPath,
  parseSandyAppManagedConfig,
  type SandyAppManagedConfig,
  type SandyAppManagedEnvConfig,
  type SandyAppManagedEnvFile,
} from "@sandy/config/sandy-app-managed-config";
import { validateOptionalUrl } from "@sandy/config/public-url";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

interface ApplySandyAppManagedConfigArgs {
  baseConfig: ServerRuntimeConfig;
  managedConfig: SandyAppManagedConfig;
  targetConfig: ServerRuntimeConfig;
}

interface ReadSandyAppManagedConfigArgs {
  configPath: string;
  logger?: ServerLogger;
}

interface ReadSandyAppManagedEnvArgs {
  envPath: string;
}

interface CreateSandyAppManagedConfigReloaderArgs {
  config: ServerRuntimeConfig;
  hub: NotificationHub;
  logger: ServerLogger;
}

interface ReloadSandyAppManagedConfigArgs {
  notify: boolean;
}

export interface SandyAppManagedConfigReloader {
  reload(args: ReloadSandyAppManagedConfigArgs): Promise<void>;
}

interface ApplyManagedProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  managedEnv: SandyAppManagedEnvConfig;
  managedKeys: Set<string>;
}

function cloneRuntimeConfig(config: ServerRuntimeConfig): ServerRuntimeConfig {
  return { ...config };
}

function replaceRuntimeConfig(
  targetConfig: ServerRuntimeConfig,
  nextConfig: ServerRuntimeConfig,
): void {
  if (nextConfig.appUrl === undefined) {
    delete targetConfig.appUrl;
  }
  Object.assign(targetConfig, nextConfig);
}

function setOptionalAppUrl(
  config: ServerRuntimeConfig,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete config.appUrl;
    return;
  }
  config.appUrl = value;
}

function applyManagedProcessEnv(args: ApplyManagedProcessEnvArgs): void {
  for (const key of args.managedKeys) {
    const baseValue = args.baseEnv[key];
    if (baseValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseValue;
    }
  }

  args.managedKeys.clear();
  for (const [key, value] of Object.entries(args.managedEnv)) {
    process.env[key] = value;
    args.managedKeys.add(key);
  }
}

export function applySandyAppManagedConfig(
  args: ApplySandyAppManagedConfigArgs,
): void {
  const managedConfig = args.managedConfig.config ?? {};

  args.targetConfig.customModels =
    args.managedConfig.customModels ?? args.baseConfig.customModels;
  args.targetConfig.sharedSkillRoots =
    args.managedConfig.sharedSkillRoots ?? args.baseConfig.sharedSkillRoots;

  setOptionalAppUrl(
    args.targetConfig,
    managedConfig.SANDY_APP_URL !== undefined
      ? validateOptionalUrl("SANDY_APP_URL", managedConfig.SANDY_APP_URL)
      : args.baseConfig.appUrl,
  );
}

async function readSandyAppManagedConfig(
  args: ReadSandyAppManagedConfigArgs,
): Promise<SandyAppManagedConfig> {
  try {
    const rawConfig = await readFile(args.configPath, "utf8");
    return parseSandyAppManagedConfig(JSON.parse(rawConfig), {
      logger: args.logger,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readSandyAppManagedEnv(
  args: ReadSandyAppManagedEnvArgs,
): Promise<SandyAppManagedEnvFile> {
  try {
    const rawConfig = await readFile(args.envPath, "utf8");
    return sandyAppManagedEnvFileSchema.parse(JSON.parse(rawConfig));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function createSandyAppManagedConfigReloader(
  args: CreateSandyAppManagedConfigReloaderArgs,
): Promise<SandyAppManagedConfigReloader> {
  const baseConfig = cloneRuntimeConfig(args.config);
  const baseEnv = { ...process.env };
  const configPath = formatSandyAppConfigPath(args.config.dataDir);
  const envPath = formatSandyAppEnvPath(args.config.dataDir);
  const managedEnvKeys = new Set<string>();

  async function reload(
    reloadArgs: ReloadSandyAppManagedConfigArgs,
  ): Promise<void> {
    const managedConfig = await readSandyAppManagedConfig({
      configPath,
      logger: args.logger,
    });
    const managedEnvFile = await readSandyAppManagedEnv({ envPath });
    const nextConfig = cloneRuntimeConfig(args.config);
    applySandyAppManagedConfig({
      baseConfig,
      managedConfig,
      targetConfig: nextConfig,
    });
    applyManagedProcessEnv({
      baseEnv,
      managedEnv: managedEnvFile.env ?? {},
      managedKeys: managedEnvKeys,
    });
    replaceRuntimeConfig(args.config, nextConfig);
    if (reloadArgs.notify) {
      args.hub.notifySystem(["config-changed"]);
    }
  }

  try {
    await reload({ notify: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(
      { configPath, error: message },
      "Ignoring invalid sandy-app managed config during startup",
    );
  }

  return {
    reload,
  };
}
