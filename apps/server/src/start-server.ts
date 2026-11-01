import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@sandy/config/server";
import { toOptionalString } from "@sandy/config/strings";
import { SANDY_LOOPBACK_HOST } from "@sandy/config/runtime";
import { createLogger } from "@sandy/logger";
import { startTelemetry } from "@sandy/telemetry";
import { getAppSettings, getDisabledProviderIds, setAppSettings } from "@sandy/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createProviderLiveCommandsCache } from "./services/providers/provider-live-commands.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import {
  createCliCommandService,
  createWindowsUserPath,
} from "./services/system/cli-command.js";
import { createSandyAppManagedConfigReloader } from "./services/system/sandy-app-managed-config.js";
import { startGatedPerformanceDiagnostics } from "./services/system/performance-diagnostics.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { installProviderModelCatalogPrewarm } from "./services/providers/provider-model-catalog-prewarm.js";
import {
  createProviderRegistryService,
  type ProviderRegistryService,
} from "./services/providers/provider-registry.js";
import type { PluginService } from "./services/plugins/plugin-service.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import type { ServerLogger, ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import { startDaemonLivenessChecks } from "./ws/daemon-protocol.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { disconnectImportedDaemonSessions } from "./internal/session-owner-side-effects.js";
import {
  applyServerImportAtBoot,
  refuseInterruptedServerImport,
  repairLastServerMoveHostName,
} from "./services/server-move/pending-boot.js";
import { isServerMoveFrozen } from "./services/server-move/freeze-state.js";
import { reconcileServerMoveRunAtBoot } from "./services/server-move/reconcile.js";
import {
  retireServerProcess as retireProcessWithDeadline,
  SERVER_RETIRE_FORCE_EXIT_MS,
} from "./services/server-move/retire.js";
import {
  PluginToolCallRegistry,
  setPluginToolCallRegistry,
} from "./services/plugins/plugin-tool-calls.js";

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  serverConfig: Pick<ServerConfig, "SANDY_SERVER_BIND_HOST" | "SANDY_SERVER_PORT">;
  logger: Pick<ServerLogger, "warn">;
  extraListenerRetryMs?: number;
}

export const EXTRA_LISTENER_RETRY_MS = 10_000;

export function startHttpListeners(args: StartHttpListenerArgs) {
  const port = args.serverConfig.SANDY_SERVER_PORT;
  const loopback = serve({
    hostname: SANDY_LOOPBACK_HOST,
    port,
    fetch: args.fetch,
  });
  const extras = args.serverConfig.SANDY_SERVER_BIND_HOST.map((hostname) => {
    const server = serve({ hostname, port, fetch: args.fetch });
    let retry: ReturnType<typeof setTimeout> | null = null;
    server.on("error", (error: unknown) => {
      args.logger.warn(
        { err: error, hostname, port },
        "Bind address unavailable; loopback keeps serving, retrying",
      );
      retry = setTimeout(() => {
        retry = null;
        server.listen(port, hostname);
      }, args.extraListenerRetryMs ?? EXTRA_LISTENER_RETRY_MS);
      retry.unref();
    });
    server.on("close", () => {
      if (retry !== null) clearTimeout(retry);
    });
    return server;
  });
  return [loopback, ...extras];
}

export function closeHttpListener(
  server: ReturnType<typeof startHttpListeners>[number],
): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

export interface StartServerPluginsArgs {
  logger: Pick<ServerLogger, "error">;
  pluginService: Pick<PluginService, "start" | "startPeriodicUpdateChecks">;
  providerRegistry: Pick<ProviderRegistryService, "markRegistrationsSettled">;
}

export function startServerPlugins(
  args: StartServerPluginsArgs,
): Promise<void> {
  return args.pluginService
    .start()
    .catch((error: unknown) => {
      args.logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      args.providerRegistry.markRegistrationsSettled();
      args.pluginService.startPeriodicUpdateChecks();
    });
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  const telemetry = startTelemetry({ component: "server" });
  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.SANDY_DATA_DIR,
  });
  await refuseInterruptedServerImport({
    dataDir: serverConfig.SANDY_DATA_DIR,
    logger,
  });
  let diagnosticsEnabled = () => false;
  const db = initDb(serverConfig.databasePath, {
    slowQueryThresholdMs: () => (diagnosticsEnabled() ? 25 : 100),
    slowQueryDiagnosticsEnabled: () => diagnosticsEnabled(),
    dataDir: serverConfig.SANDY_DATA_DIR,
    logger,
  });
  const serverImport = await applyServerImportAtBoot({
    dataDir: serverConfig.SANDY_DATA_DIR,
    db,
    logger,
    now: Date.now(),
  });
  const pendingServerMove = serverImport.pendingMove;
  if (pendingServerMove === null) {
    await repairLastServerMoveHostName({
      dataDir: serverConfig.SANDY_DATA_DIR,
      db,
      logger,
    });
  }
  if (serverConfig.SANDY_SKIP_ONBOARDING) {
    const settings = getAppSettings(db);
    if (settings.onboardingCompletedAt === null) {
      setAppSettings(db, {
        ...settings,
        onboardingCompletedAt: new Date().toISOString(),
      });
    }
  }
  const serverMoveRun =
    pendingServerMove === null
      ? await reconcileServerMoveRunAtBoot({
          dataDir: serverConfig.SANDY_DATA_DIR,
          logger,
          now: Date.now(),
        })
      : null;
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.SANDY_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../app");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";
  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    appVersion: serverConfig.SANDY_APP_VERSION,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    customModels: [],
    dataDir: serverConfig.SANDY_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.SANDY_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.SANDY_INHERITED_SKILLS_ROOTS,
    isDevelopment: !isProduction,
    performanceDiagnosticsAvailable: serverConfig.SANDY_PERF_DIAGNOSTICS,
    serverPort: serverConfig.SANDY_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
  };

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);
      return {
        providerOrder: settings.providerOrder,
        disabledProviderIds: getDisabledProviderIds(db),
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }
  if (serverConfig.SANDY_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.SANDY_DEV_APP_PORT;
  }
  if (serverConfig.SANDY_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.SANDY_SERVER_LAUNCH_ID;
  }
  const terminalSessions = new TerminalSessionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    logger,
  });
  const sandyAppManagedConfig = await createSandyAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const machineAuth = await createMachineAuthService({
    dataDir: serverConfig.SANDY_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();
  const providerLiveCommands = createProviderLiveCommandsCache();
  const aiServices = createAiServiceRegistry({
    onStatusChange: () => hub.notifySystem(["config-changed"]),
  });
  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    terminalSessions,
  });
  pendingInteractions.start();
  setPluginToolCallRegistry(new PluginToolCallRegistry({ logger }));

  const cliCommand = createCliCommandService({
    env: process.env,
    homeDir: homedir(),
    launcherPath: serverConfig.SANDY_CLI_LAUNCHER ?? null,
    platform: process.platform,
    windowsUserPath: createWindowsUserPath(process.env),
  });
  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
    serverMove,
  } = createApp(
    {
      sandyAppManagedConfig,
      cliCommand,
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      providerNativeRoots,
      providerLiveCommands,
      aiServices,
      skillTreeRegistry,
      terminalSessions,
      watchInterests,
    },
    {
      serverMove: {
        appSurface: serverConfig.SANDY_APP_SURFACE,
        manualImportPending: serverImport.manualImportPending,
        pending: pendingServerMove,
        restoredRun: serverMoveRun,
        retireProcess: retireServerProcess,
      },
      staticDir,
      performanceDiagnosticsEnabled: () => diagnosticsEnabled(),
    },
  );
  disconnectImportedDaemonSessions(
    {
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      aiServices,
      skillTreeRegistry,
      terminalSessions,
    },
    { sessions: serverImport.importedDaemonSessions },
  );
  const performanceDiagnostics = await startGatedPerformanceDiagnostics({
    allowed: serverConfig.SANDY_PERF_DIAGNOSTICS,
    dataDir: serverConfig.SANDY_DATA_DIR,
    db,
    hub,
    logger,
  });
  diagnosticsEnabled = performanceDiagnostics.isEnabled;
  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger,
    thresholdMs: () => (diagnosticsEnabled() ? 100 : 500),
  });
  const stopDaemonLivenessChecks = startDaemonLivenessChecks({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    terminalSessions,
  });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    terminalSessions,
  };
  const providerModelCatalogPrewarm =
    pendingServerMove === null
      ? installProviderModelCatalogPrewarm(sweepDeps)
      : null;
  if (pendingServerMove === null) {
    await runStartupRecoverySweep(sweepDeps).catch((error) => {
      logger.error({ err: error }, "Startup recovery sweep failed");
    });
  }

  const servers = startHttpListeners({
    fetch: app.fetch,
    serverConfig,
    logger,
  });
  for (const server of servers) {
    injectWebSocket(server);
  }

  logger.info(
    {
      bindAddresses: [SANDY_LOOPBACK_HOST, ...serverConfig.SANDY_SERVER_BIND_HOST],
      port: serverConfig.SANDY_SERVER_PORT,
      dataDir: serverConfig.SANDY_DATA_DIR,
    },
    "Server listening",
  );
  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.SANDY_SERVER_PORT}`,
  });
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  if (pendingServerMove === null) {
    if (serverMoveRun?.kind === "completed") {
      logger.info(
        { moveId: serverMoveRun.run.status.moveId },
        "This server already moved before it restarted; retiring without starting plugins",
      );
      providerRegistry.markRegistrationsSettled();
    } else {
      void startServerPlugins({
        logger,
        pluginService,
        providerRegistry,
      }).finally(() => {
        void serverMove.handlePluginsStarted();
      });
    }
    pluginCatalogService.startPeriodicRefresh();
    sweepInterval = setInterval(() => {
      if (!isServerMoveFrozen(db)) {
        void runPeriodicSweeps(sweepDeps);
      }
    }, 10_000);
    sweepInterval.unref();
  } else {
    logger.info(
      { moveId: pendingServerMove.moveId },
      "Server started in pending move mode; waiting for the target machine to activate it",
    );
  }

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      hub.stopClientChangeNotifications();
      serverMove.dispose();
      providerModelCatalogPrewarm?.stop();
      eventLoopStallMonitor.stop();
      await performanceDiagnostics.stop();
      stopDaemonLivenessChecks();
      if (sweepInterval !== null) {
        clearInterval(sweepInterval);
      }
      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();
      if (pendingServerMove === null) {
        await pluginService.stop().catch((error: unknown) => {
          logger.warn({ err: error }, "Plugin shutdown failed");
        });
      }
      const closeServers = Promise.all(servers.map(closeHttpListener));
      await closeWebSockets();
      await closeServers;
      await telemetry.shutdown();
    })();
    return shutdownPromise;
  };

  function retireServerProcess(): void {
    logger.info({}, "Server moved to another machine; shutting down");
    retireProcessWithDeadline({
      exit: (code) => process.exit(code),
      forceExitAfterMs: SERVER_RETIRE_FORCE_EXIT_MS,
      shutdown: runShutdown,
    });
  }

  process.on("uncaughtException", (error: unknown) => {
    if (pluginService.handleUncaughtException(error)) return;
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.fatal({ err: error }, "Uncaught exception");
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
}
