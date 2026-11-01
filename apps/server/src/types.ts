import type { CustomProviderModel } from "@sandy/config/sandy-app-managed-config";
import type { DbConnection } from "@sandy/db";
import type { FeatureFlags, ProviderNativeSkillRoots } from "@sandy/domain";
import type { Logger } from "@sandy/logger";
import type { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import type { MachineAuthService } from "./services/machine-auth.js";
import type { CliCommandService } from "./services/system/cli-command.js";
import type { SandyAppManagedConfigReloader } from "./services/system/sandy-app-managed-config.js";
import type { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import type { LifecycleDedupers } from "./lifecycle-dedupers.js";
import type { NotificationHub } from "./ws/hub.js";
import type { WatchInterestCoordinator } from "./ws/watch-interests.js";
import type { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import type { ProviderRegistryService } from "./services/providers/provider-registry.js";
import type { AiServiceRegistry } from "./services/ai/ai-service-registry.js";
import type { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import type { ProviderNativeRootsCache } from "./services/providers/native-roots.js";
import type { ProviderLiveCommandsCache } from "./services/providers/provider-live-commands.js";

export type ServerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  appVersion: string;
  builtinSkillsRootPath: string;
  customModels: CustomProviderModel[];
  dataDir: string;
  featureFlags: FeatureFlags;
  hostDaemonPort: number;
  inheritedSkillsRootPaths: string[];
  isDevelopment: boolean;
  performanceDiagnosticsAvailable: boolean;
  serverPort: number;
  sharedSkillRoots: ProviderNativeSkillRoots;
  appUrl?: string;
  devAppPort?: number;
  launchId?: string;
}

export interface AppDeps {
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  lifecycleDedupers: LifecycleDedupers;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  pendingInteractions: PendingInteractionLifecycle;
  providerRegistry: ProviderRegistryService;
  pluginHostArtifacts: PluginHostArtifactRegistry;
  providerNativeRoots: ProviderNativeRootsCache;
  providerLiveCommands: ProviderLiveCommandsCache;
  aiServices: AiServiceRegistry;
  skillTreeRegistry: SkillTreeRegistry;
  terminalSessions: TerminalSessionLifecycle;
  watchInterests: WatchInterestCoordinator;
}

export interface ServerAppDeps extends AppDeps {
  sandyAppManagedConfig: SandyAppManagedConfigReloader;
  cliCommand: CliCommandService;
}

export type WorkSessionDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hub"
  | "logger"
  | "lifecycleDedupers"
  | "machineAuth"
  | "providerRegistry"
  | "pluginHostArtifacts"
  | "aiServices"
  | "skillTreeRegistry"
>;

export type LoggedWorkSessionDeps = WorkSessionDeps & Pick<AppDeps, "logger">;

export type LoggedPendingInteractionWorkSessionDeps = WorkSessionDeps &
  Pick<AppDeps, "logger" | "pendingInteractions" | "terminalSessions">;
