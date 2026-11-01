import { join } from "node:path";
import { providerNativeSkillRootsSchema } from "@sandy/domain";
import { z } from "zod";

const BUNDLED_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "pi",
  "acp-cursor",
] as const;

const SANDY_APP_CONFIG_FILE_NAME = "config.json";
const SANDY_APP_ENV_FILE_NAME = "env.json";

export type SandyAppManagedConfigKey = "SANDY_APP_URL" | "SANDY_LOG_LEVEL";

export const SANDY_APP_MANAGED_CONFIG_KEYS: SandyAppManagedConfigKey[] = [
  "SANDY_APP_URL",
  "SANDY_LOG_LEVEL",
];

export const REMOVED_AI_SERVICE_CONFIG_KEYS: readonly string[] = [
  "SANDY_INFERENCE",
  "SANDY_INFERENCE_FALLBACK",
  "SANDY_TRANSCRIPTION",
];

export const REMOVED_AI_SERVICE_CONFIG_MESSAGE =
  "SANDY_INFERENCE, SANDY_INFERENCE_FALLBACK, and SANDY_TRANSCRIPTION were removed. Choose AI services in Settings → AI services or with `sandy settings ai-services set <task> <automatic|off|service>`.";

export const PORTABLE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY = "customAcpAgents";
const REMOVED_CUSTOM_ACP_AGENTS_MESSAGE =
  "customAcpAgents in config.json is no longer read. Declare the agents with `sandy plugin config provider-acp set customAgents '<json>'`.";

interface SandyAppManagedConfigWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ParseSandyAppManagedConfigOptions {
  logger?: SandyAppManagedConfigWarningLogger;
}

const sandyAppManagedConfigValuesSchema = z
  .object({
    SANDY_APP_URL: z.string().optional(),
    SANDY_LOG_LEVEL: z.string().optional(),
  })
  .strict();

const ACP_PROVIDER_ID_PATTERN = /^acp-[a-z0-9][a-z0-9-]*$/u;

const customModelProviderIdSchema = z.union([
  z.enum(BUNDLED_PROVIDER_IDS),
  z.string().regex(ACP_PROVIDER_ID_PATTERN),
]);

export const customProviderModelSchema = z
  .object({
    providerId: customModelProviderIdSchema,
    model: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const sandyAppManagedEnvNameSchema = z.string().regex(PORTABLE_ENV_NAME_PATTERN);

const sandyAppManagedEnvConfigSchema = z.record(
  sandyAppManagedEnvNameSchema,
  z.string(),
);

const sandyAppManagedConfigBoundarySchema = z
  .object({
    config: sandyAppManagedConfigValuesSchema.optional(),
    customModels: z.array(z.unknown()).optional(),
    sharedSkillRoots: providerNativeSkillRootsSchema.optional(),
    serverHeaders: z.record(z.string(), z.string()).optional(),
    machineCredential: z.string().min(1).optional(),
    connectMachineId: z.string().min(1).optional(),
    serverUrl: z.string().min(1).optional(),
  })
  .strict();

export const sandyAppManagedEnvFileSchema = z
  .object({
    env: sandyAppManagedEnvConfigSchema.optional(),
  })
  .strict();

export type SandyAppManagedConfigValues = z.infer<
  typeof sandyAppManagedConfigValuesSchema
>;
export type CustomProviderModel = z.infer<typeof customProviderModelSchema>;
export type SandyAppManagedConfig = Omit<
  z.infer<typeof sandyAppManagedConfigBoundarySchema>,
  "customModels"
> & {
  customModels?: CustomProviderModel[];
};
export type SandyAppManagedEnvConfig = z.infer<typeof sandyAppManagedEnvConfigSchema>;
export type SandyAppManagedEnvFile = z.infer<typeof sandyAppManagedEnvFileSchema>;

function parseCustomModels(
  entries: readonly unknown[] | undefined,
  options: ParseSandyAppManagedConfigOptions,
): CustomProviderModel[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const customModels: CustomProviderModel[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = customProviderModelSchema.safeParse(entry);
    if (!result.success) {
      options.logger?.warn(
        { error: result.error.message, index },
        "Ignoring invalid custom model config entry",
      );
      continue;
    }
    customModels.push(result.data);
  }

  return customModels;
}

function withoutRemovedAiServiceConfig(
  rawConfig: unknown,
  options: ParseSandyAppManagedConfigOptions,
): unknown {
  if (typeof rawConfig !== "object" || rawConfig === null) return rawConfig;
  const values: unknown = Reflect.get(rawConfig, "config");
  if (typeof values !== "object" || values === null) return rawConfig;
  const removed = REMOVED_AI_SERVICE_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(values, key),
  );
  if (removed.length === 0) return rawConfig;
  options.logger?.warn({ keys: removed }, REMOVED_AI_SERVICE_CONFIG_MESSAGE);
  return {
    ...rawConfig,
    config: Object.fromEntries(
      Object.entries(values).filter(([key]) => !removed.includes(key)),
    ),
  };
}

function withoutRemovedCustomAcpAgents(
  rawConfig: unknown,
  options: ParseSandyAppManagedConfigOptions,
): unknown {
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    !Object.hasOwn(rawConfig, REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY)
  ) {
    return rawConfig;
  }
  options.logger?.warn(
    { key: REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY },
    REMOVED_CUSTOM_ACP_AGENTS_MESSAGE,
  );
  return Object.fromEntries(
    Object.entries(rawConfig).filter(
      ([key]) => key !== REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY,
    ),
  );
}

export function parseSandyAppManagedConfig(
  rawConfig: unknown,
  options: ParseSandyAppManagedConfigOptions = {},
): SandyAppManagedConfig {
  const parsed = sandyAppManagedConfigBoundarySchema.parse(
    withoutRemovedCustomAcpAgents(
      withoutRemovedAiServiceConfig(rawConfig, options),
      options,
    ),
  );
  const customModels = parseCustomModels(parsed.customModels, options);
  const config: SandyAppManagedConfig = {};
  if (parsed.config !== undefined) {
    config.config = parsed.config;
  }
  if (customModels !== undefined) {
    config.customModels = customModels;
  }
  if (parsed.sharedSkillRoots !== undefined) {
    config.sharedSkillRoots = parsed.sharedSkillRoots;
  }
  if (parsed.serverUrl !== undefined) {
    config.serverUrl = parsed.serverUrl;
  }
  if (parsed.serverHeaders !== undefined) {
    config.serverHeaders = parsed.serverHeaders;
  }
  if (parsed.machineCredential !== undefined) {
    config.machineCredential = parsed.machineCredential;
  }
  if (parsed.connectMachineId !== undefined) {
    config.connectMachineId = parsed.connectMachineId;
  }
  return config;
}

export function formatSandyAppConfigPath(dataDir: string): string {
  return join(dataDir, SANDY_APP_CONFIG_FILE_NAME);
}

export function formatSandyAppEnvPath(dataDir: string): string {
  return join(dataDir, SANDY_APP_ENV_FILE_NAME);
}
