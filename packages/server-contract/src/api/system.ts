import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import {
  aiServiceSelectionSchema,
  aiServiceSelectionsSchema,
  aiServiceStatusSchema,
  aiTaskSchema,
  aiTextTaskSchema,
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  customThemeNameSchema,
  availableModelSchema,
  experimentsSchema,
  featureFlagsSchema,
  jsonValueSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
  themeKitInputSchema,
} from "@sandy/domain";
import { providerHealthSchema as providerHealthSchema } from "@sandy/provider-bridge-protocol/provider-maintenance";
import { hostPlatformSchema } from "@sandy/host-daemon-contract/local";
import { machineEnvironmentSetSchema } from "./machine-environment.js";
import { systemVoiceTranscriptionResponseSchema } from "./system-voice.js";
import {
  systemEnvironmentProviderSchema,
  systemEnvironmentProvidersResponseSchema,
} from "./system-environment-providers.js";
export {
  systemEnvironmentProviderSchema,
  systemEnvironmentProvidersResponseSchema,
} from "./system-environment-providers.js";
export { systemVoiceTranscriptionResponseSchema } from "./system-voice.js";
const machineEnvironmentReplacementVariableSchema =
  machineEnvironmentSetSchema.extend({
    value: machineEnvironmentSetSchema.shape.value.nullable(),
  });

export const machineEnvironmentReplaceSchema = z
  .object({
    variables: z.array(machineEnvironmentReplacementVariableSchema),
  })
  .strict()
  .superRefine(({ variables }, context) => {
    const names = new Set<string>();
    for (const [index, variable] of variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Machine environment variable names must be unique",
        });
      }
      names.add(variable.name);
    }
  });
export type MachineEnvironmentReplace = z.infer<
  typeof machineEnvironmentReplaceSchema
>;

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);
export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
  detail: z.string().min(1).nullable(),
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  permissionCeiling: permissionModeSchema,
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
    projectId: z.string().min(1),
    selectedModel: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors)
  .superRefine((query, context) => {
    if (query.projectId !== undefined && query.environmentId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "projectId and environmentId are mutually exclusive",
      });
    }
  });
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemUsageLimitsQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SystemUsageLimitsQuery = z.infer<
  typeof systemUsageLimitsQuerySchema
>;

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export { providerInfoSchema as systemProviderInfoSchema } from "@sandy/domain";
export type { ProviderInfo as SystemProviderInfo } from "@sandy/domain";

export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

export const systemProviderStateSchema = providerHealthSchema.extend({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  localLoginCommand: z.string().min(1).nullable(),
});
export type SystemProviderState = z.infer<typeof systemProviderStateSchema>;

export const systemProviderStatesResponseSchema = z.object({
  providers: z.array(systemProviderStateSchema),
});
export type SystemProviderStatesResponse = z.infer<
  typeof systemProviderStatesResponseSchema
>;

export const systemAiServiceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pluginId: z.string().min(1),
  tasks: z.array(aiTaskSchema),
  automaticRank: z.number().int().nonnegative().nullable(),
  status: aiServiceStatusSchema,
});
export type SystemAiService = z.infer<typeof systemAiServiceSchema>;

export const systemAiServicesResponseSchema = z.object({
  selections: aiServiceSelectionsSchema,
  services: z.array(systemAiServiceSchema),
});
export type SystemAiServicesResponse = z.infer<
  typeof systemAiServicesResponseSchema
>;

export const setAiServiceSelectionRequestSchema = z
  .object({
    task: aiTaskSchema,
    selection: aiServiceSelectionSchema,
  })
  .strict();
export type SetAiServiceSelectionRequest = z.infer<
  typeof setAiServiceSelectionRequestSchema
>;

export const CLIENT_ERROR_SOURCES = [
  "react-caught",
  "react-uncaught",
  "window-error",
  "unhandled-rejection",
] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];
export const CLIENT_ERROR_MESSAGE_MAX_LENGTH = 2_000;
export const CLIENT_ERROR_STACK_MAX_LENGTH = 16_000;

export const clientErrorReportSchema = z
  .object({
    source: z.enum(CLIENT_ERROR_SOURCES),
    message: z.string().min(1).max(CLIENT_ERROR_MESSAGE_MAX_LENGTH),
    stack: z.string().max(CLIENT_ERROR_STACK_MAX_LENGTH).nullable(),
    componentStack: z.string().max(CLIENT_ERROR_STACK_MAX_LENGTH).nullable(),
    path: z.string().min(1).max(CLIENT_ERROR_MESSAGE_MAX_LENGTH),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

export const testAiServiceRequestSchema = z
  .object({ task: aiTextTaskSchema })
  .strict();
export type TestAiServiceRequest = z.infer<typeof testAiServiceRequestSchema>;

export const testAiServiceResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    pluginId: z.string().min(1),
    serviceId: z.string().min(1),
    displayName: z.string().min(1),
    text: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
  }),
]);
export type TestAiServiceResponse = z.infer<typeof testAiServiceResponseSchema>;

export const serverAccessStatusSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      pluginId: z.string().min(1).nullable(),
      availability: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("available"),
            serverUrl: z.string().url().optional(),
          }),
          z.object({
            status: z.literal("setup-required"),
            message: z.string(),
          }),
          z.object({ status: z.literal("unavailable"), message: z.string() }),
        ])
        .nullable(),
    }),
  ),
  defaultProviderId: z.string(),
  effectiveUrl: z.string().nullable(),
  urlSource: z.enum(["setting", "SANDY_EXTERNAL_URL"]).nullable(),
});
export type ServerAccessStatus = z.infer<typeof serverAccessStatusSchema>;

export const systemConfigResponseSchema = z.object({
  serverAccess: serverAccessStatusSchema,
  generalSettings: appSettingsSchema.extend({
    showUnhandledProviderEvents: z.boolean().optional(),
  }),
  keybindings: appKeybindingsSchema,
  defaultKeybindings: appDefaultKeybindingsSchema,
  keybindingOverrides: appKeybindingOverridesSchema,
  experiments: experimentsSchema,
  performanceDiagnosticsAvailable: z.boolean(),
  appearance: appThemeSchema,
  customThemes: z.array(z.string()),
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  localHelperPorts: z.array(z.number().int().min(1).max(65_535)),
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});
export type SystemAttentionResponse = z.infer<
  typeof systemAttentionResponseSchema
>;

export const themeCatalogResponseSchema = z.object({
  dir: z.string(),
  custom: z.array(z.string()),
  plugins: z.array(pluginThemeMetaSchema),
  active: appThemeSchema,
});
export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const createThemeRequestSchema = z.object({
  name: customThemeNameSchema,
  kit: themeKitInputSchema,
  overwrite: z.boolean().default(false),
});
export type CreateThemeRequest = z.input<typeof createThemeRequestSchema>;

export const createThemeResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  css: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["error", "warning"]),
      mode: z.enum(["light", "dark", "both"]),
      token: z.string(),
      message: z.string(),
    }),
  ),
});
export type CreateThemeResponse = z.infer<typeof createThemeResponseSchema>;

export const systemCliCommandShadowSchema = z.object({
  path: z.string().min(1),
  source: z.enum(["machine", "npm", "other"]),
});
export type SystemCliCommandShadow = z.infer<
  typeof systemCliCommandShadowSchema
>;

export const systemCliCommandStatusSchema = z.object({
  installedPath: z.string().min(1).nullable(),
  onPath: z.boolean(),
  shadowedBy: systemCliCommandShadowSchema.nullable(),
  supported: z.boolean(),
});
export type SystemCliCommandStatus = z.infer<
  typeof systemCliCommandStatusSchema
>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

export const cliSkillMachineStatusSchema = z.enum([
  "installed",
  "outdated",
  "missing",
  "unknown",
]);
export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  hostIds: z.string().optional(),
});
export type SystemCliSkillsStatusQuery = z.infer<
  typeof systemCliSkillsStatusQuerySchema
>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});
export type SystemCliSkillsStatusResponse = z.infer<
  typeof systemCliSkillsStatusResponseSchema
>;

export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});
export type SystemInstallCliSkillsRequest = z.infer<
  typeof systemInstallCliSkillsRequestSchema
>;

export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});
export type SystemInstallCliSkillsResponse = z.infer<
  typeof systemInstallCliSkillsResponseSchema
>;
export type SystemConfigReloadResponse = z.infer<
  typeof systemConfigReloadResponseSchema
>;

export type SystemEnvironmentProvider = z.infer<
  typeof systemEnvironmentProviderSchema
>;

export type SystemEnvironmentProvidersResponse = z.infer<
  typeof systemEnvironmentProvidersResponseSchema
>;

export const systemEnvironmentProvidersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    if (query.hostId !== undefined && query.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "hostId requires projectId",
      });
    }
  });
export type SystemEnvironmentProvidersQuery = z.infer<
  typeof systemEnvironmentProvidersQuerySchema
>;

export const systemMachineProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  supportsSuspend: z.boolean(),
});
export type SystemMachineProvider = z.infer<typeof systemMachineProviderSchema>;

export const systemMachineProvidersResponseSchema = z.object({
  providers: z.array(systemMachineProviderSchema),
});
export type SystemMachineProvidersResponse = z.infer<
  typeof systemMachineProvidersResponseSchema
>;

export const systemProviderCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  pluginEnabled: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  logoUrl: z.string().nullable(),
  info: providerInfoSchema.nullable(),
});
export type SystemProviderCatalogEntry = z.infer<
  typeof systemProviderCatalogEntrySchema
>;
export const systemProviderEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type SystemProviderEnabledRequest = z.infer<
  typeof systemProviderEnabledRequestSchema
>;
