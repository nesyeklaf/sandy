import { hostToolchain } from "@sandy/process-utils";
import { openApplicationUrl } from "./application-url.js";
import { createDesktopLogger } from "./desktop-logger.js";
import { registerServerChoiceIpc } from "./server-choice-ipc.js";
import { randomUUID } from "node:crypto";
import { arch, homedir, release, type as osType } from "node:os";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  session,
  shell,
  webContents as electronWebContents,
  type Event,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type WebContents,
} from "electron";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
} from "@sandy/config/app-surface";
import { findMachineServiceFile } from "@sandy/config/machine-service";
import {
  appCommandIdSchema,
  type AppCommandId,
  type AppKeybindings,
} from "@sandy/domain";
import {
  sandyDesktopBrowserImportCookiesRequestSchema,
  sandyDesktopThemeSchema,
  type SandyDesktopInfo,
  type SandyDesktopWindowState,
} from "@sandy/desktop-contract";
import {
  serverMessageLenientSchema,
  type ClientMessage,
} from "@sandy/server-contract";
import { z } from "zod";
import { registerDesktopClipboardIpc } from "./desktop-clipboard.js";
import { registerDesktopAttentionIpc } from "./desktop-attention.js";
import { registerDesktopWindowFocusIpc } from "./desktop-window-focus.js";
import {
  assertPathExists,
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopMachineInstallerPath,
  type DesktopPathContext,
} from "./app-paths.js";
import {
  keepMovedMachineConnected,
  MACHINE_SERVICE_INSTALL_LOG_FILE_NAME,
  MACHINE_SERVICE_NOTICE_FILE_NAME,
  runMachineInstaller,
} from "./moved-machine-service.js";
import {
  resolveSandyAppProcessRuntime,
  type SandyAppProcess,
  type SandyAppProcessExit,
  startSandyAppProcess,
} from "./sandy-process.js";
import { openExistingServerDialog } from "./existing-server-dialog.js";
import {
  readForeignRuntimeDetails,
  stopForeignRuntime,
} from "./foreign-runtime.js";
import {
  createLocalViewUrl,
  STARTUP_ACTION_CHANNEL,
  startupActionIdSchema,
  type StartupAction,
  type StartupActionId,
} from "./local-view.js";
import {
  createServerMenuItems,
  installApplicationMenu,
  type ServerMenuArgs,
} from "./menu.js";
import {
  DEFAULT_APPLICATION_MENU_ACCELERATORS,
  resolveApplicationMenuAccelerators,
} from "./desktop-menu-shortcuts.js";
import {
  clearOwnedRuntimePidFile,
  reapStaleOwnedRuntime,
  writeOwnedRuntimePidFile,
} from "./owned-runtime-supervisor.js";
import {
  probeSandyServer,
  waitForCompatibleServer,
  type CompatibleServerProbeResult,
  type ServerProbeResult,
} from "./server-probe.js";
import { loadRemoteServerPage } from "./remote-server-load.js";
import {
  applyServerMove,
  createServerMovedWatcher,
  createServerMoveNoticeStore,
  ensureServerMovedRuntime,
  hasLiveSandyAppLauncher,
  openServerMoveTarget,
  probeLocalServerMove,
  readServerMovedLock,
  SERVER_MOVE_COMMIT_INTERVAL_MS,
  SERVER_MOVE_COMMIT_TIMEOUT_MS,
  SERVER_MOVE_DESTINATION_INTERVAL_MS,
  SERVER_MOVE_DESTINATION_TIMEOUT_MS,
  SERVER_MOVE_NOTICE_FILE_NAME,
  SERVER_MOVED_POLL_INTERVAL_MS,
  SERVER_MOVED_WATCH_DEBOUNCE_MS,
  waitForCommittedServerMove,
  waitForServerMoveDestination,
  type DesktopServerMove,
  type ServerMovedNotice,
  type ServerMovedWatcher,
  type ServerMoveNoticeStore,
} from "./server-moved.js";
import {
  BUILTIN_SERVER_NAME,
  createServerTargetStore,
  SERVER_TARGET_FILE_NAME,
  type ServerTargetStore,
} from "./server-target.js";
import { buildDesktopServerChoices, customServerId } from "./server-list.js";
import { openServerUrlDialog } from "./server-url-dialog.js";
import { registerDesktopShutdownSignalHandlers } from "./desktop-shutdown.js";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowFactory,
} from "./desktop-window-factory.js";
import {
  hasLinuxWindowArgument,
  LINUX_FRAMELESS_WINDOW_ARGUMENT,
  LINUX_TRANSPARENT_WINDOW_ARGUMENT,
} from "./desktop-linux-window-options.js";
import {
  createDesktopAboutDialogOptions,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "./desktop-about-panel.js";
import { registerDesktopContextMenu } from "./desktop-context-menu.js";
import {
  getDesktopVersion,
  resolveSandyDesktopPlatform,
} from "./desktop-platform.js";
import {
  DESKTOP_RELEASE_CHANNEL,
  DESKTOP_RELEASE_INFO,
} from "./desktop-release.js";
import {
  SANDY_DESKTOP_GET_INFO_CHANNEL,
  SANDY_DESKTOP_INFO_CHANGED_CHANNEL,
  SANDY_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  SANDY_DESKTOP_OPEN_APPLICATION_URL_CHANNEL,
  SANDY_DESKTOP_SET_THEME_CHANNEL,
  SANDY_DESKTOP_ZOOM_COMMAND_CHANNEL,
} from "./desktop-ipc-channels.js";
import {
  SANDY_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  SANDY_DESKTOP_APP_COMMAND_CHANNEL,
  SANDY_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
  SANDY_DESKTOP_RELOAD_WINDOW_CHANNEL,
  SANDY_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
  SANDY_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  SANDY_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  SANDY_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  SANDY_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  SANDY_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL,
  SANDY_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  SANDY_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  CLOSE_WINDOW_REQUEST_TIMEOUT_MS,
} from "./desktop-window-command-ipc.js";
import {
  createDesktopBrowserViewManager,
  type DesktopBrowserViewManager,
} from "./desktop-browser-view.js";
import { removeLegacyAutomationPartitions } from "./desktop-browser-legacy-partitions.js";
import { resolveDesktopBrowserAppCommand } from "./desktop-browser-shortcuts.js";
import { registerDesktopBrowserIpc } from "./desktop-browser-main-ipc.js";
import { resolveDesktopExternalUrl } from "./desktop-external-url.js";
import {
  createDesktopFindViewManager,
  type DesktopFindViewManager,
} from "./desktop-find-view.js";
import { createBrowserImportService } from "./browser-import/browser-import.js";
import { readMacAppIcon } from "./browser-import/mac-app-icon.js";
import {
  createDesktopBrowserBroker,
  type DesktopBrowserBroker,
} from "./desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "./desktop-browser-broker-client.js";
import {
  sandyDesktopBrowserTabRefSchema,
  sandyDesktopZoomCommandSchema,
  sandyDesktopWindowFindRequestSchema,
  type SandyDesktopZoomCommand,
} from "@sandy/desktop-contract";
import { nextZoomFactor } from "./desktop-zoom.js";
import {
  SANDY_DESKTOP_BROWSER_TARGET_CHANNEL,
  SANDY_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  SANDY_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  SANDY_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  SANDY_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  SANDY_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
} from "./desktop-browser-ipc.js";
import { parseDesktopSystemConfig } from "./desktop-system-config.js";
import { resolveDesktopReloadShortcut } from "./desktop-reload-shortcut.js";
import {
  createLogTailer,
  createLogLineBuffer,
  createLogViewerViewUrl,
  LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
  LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
  type LogLineBuffer,
  type LogTailer,
} from "./log-viewer.js";
import {
  LOG_VIEWER_APPEND_CHANNEL,
  LOG_VIEWER_COPY_CHANNEL,
  LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL,
  LOG_VIEWER_SNAPSHOT_CHANNEL,
  LOG_VIEWER_VISIBLE_LINE_LIMIT,
  type LogViewerLine,
  type LogViewerCopyRequest,
  type LogViewerOpenLogsFolderResult,
} from "./log-viewer-contract.js";
import {
  ATTACH_PROBE_TIMEOUT_MS,
  DEFAULT_SANDY_SERVER_URL,
  PROCESS_LOG_LINE_LIMIT,
  STARTUP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  type RuntimeOwnership,
  type WindowStateKey,
} from "./types.js";

const OWNED_RUNTIME_STOP_TIMEOUT_MS = 6_000;
const OWNED_RUNTIME_KILL_TIMEOUT_MS = 1_000;
const FOREIGN_RUNTIME_STOP_TIMEOUT_MS = 15_000;
const FOREIGN_RUNTIME_KILL_TIMEOUT_MS = 3_000;
const REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface DesktopRuntime {
  sandyProcess: SandyAppProcess | null;
  ownership: RuntimeOwnership;
  serverUrl: string;
  userDataPath: string | null;
}

interface LoadStartupErrorArgs {
  actions: StartupAction[];
  details: string;
  logs: string;
  title: string;
}

interface StartupErrorPage {
  actions: StartupActionId[];
  url: string;
}

interface LoadWindowUrlArgs {
  url: string;
}

interface CreateApplicationWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface StartOwnedRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

interface OwnedRuntime {
  sandyProcess: SandyAppProcess;
  runtime: DesktopRuntime;
}

interface SendLogViewerSnapshotArgs {
  browserWindow: BrowserWindow;
  lines: LogViewerLine[];
  logDir: string;
}

interface LoadLogViewerWindowArgs {
  logDir: string;
  preloadPath: string;
}

type StartupRaceResult =
  | ProcessExitedStartupRaceResult
  | ServerProbeStartupRaceResult;

interface ProcessExitedStartupRaceResult {
  exit: SandyAppProcessExit;
  kind: "process-exited";
}

interface ServerProbeStartupRaceResult {
  kind: "server-probe";
  result: ServerProbeResult;
}

interface ResolveDataDirFromEnvArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveDesktopServerUrlArgs {
  env: NodeJS.ProcessEnv;
}

interface ResolveDesktopWindowUrlArgs {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface SystemConfigRequestArgs {
  fetchImpl: typeof fetch;
  serverUrl: string;
}

interface SystemConfigSync {
  stop(): void;
}

const logViewerCopyRequestSchema = z
  .object({
    text: z.string(),
  })
  .strict();

let desktopWindowFactory: DesktopWindowFactory | null = null;
let desktopBrowserViewManager: DesktopBrowserViewManager | null = null;
let desktopFindViewManager: DesktopFindViewManager | null = null;
let desktopBrowserBroker: DesktopBrowserBroker | null = null;
let desktopBrowserBrokerClient: ReturnType<
  typeof createDesktopBrowserBrokerClient
> | null = null;
let currentAppKeybindings: AppKeybindings = [];
let currentApplicationMenuAccelerators = DEFAULT_APPLICATION_MENU_ACCELERATORS;
let currentRuntime: DesktopRuntime | null = null;
let currentWindowUrl: string | null = null;
let logViewerLineBuffer: LogLineBuffer | null = null;
let logViewerPreloadPath: string | null = null;
let logViewerTailer: LogTailer | null = null;
let logViewerWindow: BrowserWindow | null = null;
let systemConfigSync: SystemConfigSync | null = null;
let systemConfigRefreshToken = 0;
let refreshRemoteSystemConfig: (() => void) | null = null;
const applicationWindowWebContentsIds = new Set<number>();
const splitNavigationEnabledWebContentsIds = new Set<number>();
const splitNavigationCommandsByWebContentsId = new Map<
  number,
  readonly AppCommandId[]
>();
let sandyAppLoaded = false;
let startupErrorPage: StartupErrorPage | null = null;
let startupActionPending = false;
let stoppingForQuit = false;
let quitting = false;
let serverTargetStore: ServerTargetStore | null = null;
let serverTargetGeneration = 0;
let builtinServerUrl: string = DEFAULT_SANDY_SERVER_URL;
let desktopBridgePath: string | null = null;
let desktopUserDataPath: string | null = null;
let builtinDataDir: string | null = null;
let serverMoveNoticeStore: ServerMoveNoticeStore | null = null;
let machineServiceNoticeStore: ServerMoveNoticeStore | null = null;
let movedMachineConnection: Promise<void> | null = null;
let localServerMove: DesktopServerMove | null = null;
let serverMovedWatcher: ServerMovedWatcher | null = null;
let serverUrlDialogPreloadPath: string | null = null;
let existingServerDialogPreloadPath: string | null = null;

function resolveDesktopServerUrl(args: ResolveDesktopServerUrlArgs): string {
  const rawPort = args.env.SANDY_SERVER_PORT?.trim();
  if (rawPort === undefined || rawPort.length === 0) {
    return DEFAULT_SANDY_SERVER_URL;
  }

  const port = Number(rawPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return `http://127.0.0.1:${port}`;
  }

  throw new Error("SANDY_SERVER_PORT must be a valid TCP port");
}

function resolveDesktopWindowUrl(args: ResolveDesktopWindowUrlArgs): string {
  const rawAppUrl = args.env.SANDY_DESKTOP_APP_URL?.trim();
  if (rawAppUrl === undefined || rawAppUrl.length === 0) {
    return args.serverUrl;
  }
  let parsedAppUrl: URL;
  try {
    parsedAppUrl = new URL(rawAppUrl);
  } catch {
    throw new Error("SANDY_DESKTOP_APP_URL must be a valid URL");
  }
  if (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:") {
    throw new Error("SANDY_DESKTOP_APP_URL must be an http(s) URL");
  }
  return rawAppUrl;
}

function readDesktopAboutFacts(applicationName: string): DesktopAboutFacts {
  return {
    applicationName,
    buildDate: process.env.SANDY_DESKTOP_BUILD_DATE ?? "",
    channel: DESKTOP_RELEASE_CHANNEL,
    commit: process.env.SANDY_DESKTOP_COMMIT ?? "",
    electronVersion: process.versions.electron,
    osArch: arch(),
    osRelease: release(),
    osType: osType(),
    platform: process.platform,
    pluginSdkVersion: process.env.SANDY_DESKTOP_PLUGIN_SDK_VERSION ?? "",
    version: getDesktopVersion(process.env.SANDY_DESKTOP_VERSION),
  };
}

function installAboutPanel(applicationName: string): void {
  app.setAboutPanelOptions(
    createDesktopAboutPanelOptions(readDesktopAboutFacts(applicationName)),
  );
}

async function showAboutDialog(): Promise<void> {
  const { copyButtonId, ...messageBoxOptions } =
    createDesktopAboutDialogOptions(
      readDesktopAboutFacts(app.getName()),
      Date.now(),
    );
  const parentWindow = getFocusedApplicationWindow();
  const result =
    parentWindow === null
      ? await dialog.showMessageBox(messageBoxOptions)
      : await dialog.showMessageBox(parentWindow, messageBoxOptions);
  if (result.response === copyButtonId) {
    await clipboard.writeText(messageBoxOptions.detail);
  }
}

function getCurrentDesktopInfo(): SandyDesktopInfo | null {
  return {
    platform: resolveSandyDesktopPlatform(process.platform),
    serverDaemonLogsAvailable: true,
    version: getDesktopVersion(process.env.SANDY_DESKTOP_VERSION),
  };
}

function resolveApplicationWindow(
  webContents: WebContents,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents);
}

function zoomWebContents(
  target: WebContents | null | undefined,
  command: SandyDesktopZoomCommand,
): void {
  if (!target) {
    return;
  }
  if (desktopWindowFactory?.zoom(target.id, command)) return;
  target.setZoomFactor(nextZoomFactor(target.getZoomFactor(), command));
}

function sendToApplicationRenderer(
  browserWindow: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  if (!browserWindow.webContents.isDestroyed()) {
    browserWindow.webContents.send(channel, payload);
  }
}

function registerApplicationRendererReloadShortcut(
  webContents: WebContents,
): void {
  webContents.on("before-input-event", (event, input) => {
    const shortcut = resolveDesktopReloadShortcut(input);
    if (shortcut === null) {
      return;
    }
    event.preventDefault();
    const browserWindow = resolveApplicationWindow(webContents);
    if (browserWindow !== null) {
      reloadApplicationWindow(browserWindow, shortcut === "force-reload");
    }
  });
}

function reloadApplicationWindow(
  browserWindow: BrowserWindow,
  ignoreCache: boolean,
): void {
  desktopBrowserViewManager?.prepareWindowReload(browserWindow);
  if (ignoreCache) {
    browserWindow.webContents.reloadIgnoringCache();
  } else {
    browserWindow.webContents.reload();
  }
}

function sendDesktopInfoChanged(): void {
  const info = getCurrentDesktopInfo();
  if (info === null) {
    return;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        SANDY_DESKTOP_INFO_CHANGED_CHANNEL,
        info,
      );
    } else {
      browserWindow.webContents.send(SANDY_DESKTOP_INFO_CHANGED_CHANNEL, info);
    }
  }
}

function getDesktopWindowState(
  browserWindow: Pick<DesktopBrowserWindow, "isFullScreen"> | null,
): SandyDesktopWindowState {
  return {
    isFullScreen: browserWindow?.isFullScreen() ?? false,
  };
}

function getSenderDesktopWindowState(
  event: IpcMainInvokeEvent,
): SandyDesktopWindowState {
  return getDesktopWindowState(resolveApplicationWindow(event.sender));
}

function sendDesktopWindowStateChanged(
  browserWindow: DesktopBrowserWindow,
): void {
  sendToApplicationRenderer(
    browserWindow as BrowserWindow,
    SANDY_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
    getDesktopWindowState(browserWindow),
  );
}

const desktopLogger = createDesktopLogger({ logDir: formatLogDirectory() });

function resolveDataDirFromEnv(args: ResolveDataDirFromEnvArgs): string {
  const rawDataDir = args.env.SANDY_DATA_DIR?.trim();
  if (rawDataDir === undefined || rawDataDir.length === 0) {
    return join(args.homeDir, ".sandy");
  }
  if (rawDataDir === "~") {
    return args.homeDir;
  }
  if (rawDataDir.startsWith("~/")) {
    return resolve(args.homeDir, rawDataDir.slice(2));
  }
  return resolve(rawDataDir);
}

function formatLogDirectory(): string {
  return join(
    resolveDataDirFromEnv({
      env: process.env,
      homeDir: homedir(),
    }),
    "logs",
  );
}

function formatExitResult(result: SandyAppProcessExit): string {
  if (result.code !== null) {
    return `exit code ${result.code}`;
  }
  return result.signal === null
    ? "without an exit code"
    : `signal ${result.signal}`;
}

function createDesktopPathContext(): DesktopPathContext {
  return {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

const pendingCloseWindowRequests = new Map<number, NodeJS.Timeout>();

function requestRendererWindowClose(browserWindow: BrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  const pending = pendingCloseWindowRequests.get(webContentsId);
  if (pending !== undefined) {
    clearTimeout(pending);
  }
  pendingCloseWindowRequests.set(
    webContentsId,
    setTimeout(() => {
      pendingCloseWindowRequests.delete(webContentsId);
      if (!browserWindow.isDestroyed()) {
        browserWindow.close();
      }
    }, CLOSE_WINDOW_REQUEST_TIMEOUT_MS),
  );
  sendToApplicationRenderer(
    browserWindow,
    SANDY_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
    null,
  );
}

function closeFocusedDetachedDevTools(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.webContents.isDevToolsFocused()) {
      browserWindow.webContents.closeDevTools();
      return;
    }
  }
}

function getFocusedApplicationWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused !== null &&
    !focused.isDestroyed() &&
    applicationWindowWebContentsIds.has(focused.webContents.id)
  ) {
    return focused;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (
      !browserWindow.isDestroyed() &&
      applicationWindowWebContentsIds.has(browserWindow.webContents.id)
    ) {
      return browserWindow;
    }
  }
  return null;
}

function listServerChoices() {
  return buildDesktopServerChoices(serverTargetStore, builtinServerUrl);
}

function buildMenuServerItems() {
  return listServerChoices().map(({ active, id, name }) => ({
    checked: active,
    id,
    name,
  }));
}

function buildServerMenuArgs(): ServerMenuArgs {
  return {
    isMac: process.platform === "darwin",
    showBuiltinServer: serverTargetStore?.getShowBuiltinServer() ?? true,
    toggleBuiltinServer() {
      if (serverTargetStore === null) return;
      void serverTargetStore
        .setShowBuiltinServer(!serverTargetStore.getShowBuiltinServer())
        .then(refreshApplicationMenu)
        .catch((error: unknown) => {
          desktopLogger.warn(
            `[desktop] could not save server visibility: ${error instanceof Error ? error.message : String(error)}`,
          );
          refreshApplicationMenu();
        });
    },
    addServer() {
      void openSetServerUrlDialog(true);
    },
    selectServer(serverId) {
      void setActiveServerTarget(serverId);
    },
    servers: buildMenuServerItems(),
    setServerUrl() {
      void openSetServerUrlDialog();
    },
  };
}

function popupServerMenu(browserWindow: BrowserWindow | null): void {
  Menu.buildFromTemplate(createServerMenuItems(buildServerMenuArgs())).popup(
    browserWindow === null ? {} : { window: browserWindow },
  );
}

function refreshApplicationMenu(): void {
  const choices = listServerChoices();
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        SANDY_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
        choices,
      );
    }
  }
  installApplicationMenu({
    ...buildServerMenuArgs(),
    accelerators: currentApplicationMenuAccelerators,
    isMac: process.platform === "darwin",
    createNewWindow() {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    },
    openAbout() {
      void showAboutDialog();
    },
    openNewTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          SANDY_DESKTOP_OPEN_NEW_TAB_CHANNEL,
          null,
        );
        sendToApplicationRenderer(
          browserWindow,
          SANDY_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.newTab",
        );
      }
    },
    openNewThread() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          SANDY_DESKTOP_APP_COMMAND_CHANNEL,
          "thread.new",
        );
      }
    },
    reopenClosedTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          SANDY_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.reopenClosedTab",
        );
      }
    },
    openSettings() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          SANDY_DESKTOP_APP_COMMAND_CHANNEL,
          "settings.open",
        );
      }
    },
    zoomFocusedPage(command) {
      zoomWebContents(electronWebContents.getFocusedWebContents(), command);
    },
    reloadWindow(browserWindow, ignoreCache) {
      if (!(browserWindow instanceof BrowserWindow)) {
        return;
      }
      reloadApplicationWindow(browserWindow, ignoreCache);
    },
    closeWindowOrSideTab(browserWindow) {
      if (browserWindow === undefined) {
        closeFocusedDetachedDevTools();
        return;
      }
      if (
        !(browserWindow instanceof BrowserWindow) ||
        browserWindow === logViewerWindow
      ) {
        browserWindow.close();
        return;
      }
      requestRendererWindowClose(browserWindow);
    },
    openLocalLogs() {
      void openLocalLogs();
    },
  });
}

function setCurrentRuntime(runtime: DesktopRuntime | null): void {
  currentRuntime = runtime;
  if (runtime === null) {
    stopSystemConfigSync();
  }
  refreshApplicationMenu();
  sendDesktopInfoChanged();
}

function formatApiUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/api/v1/system/config";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatRealtimeUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchSystemConfig(args: SystemConfigRequestArgs) {
  const response = await args.fetchImpl(formatApiUrl(args.serverUrl));
  if (!response.ok) {
    throw new Error(
      `System config request failed with HTTP ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  return parseDesktopSystemConfig(payload);
}

function createSystemConfigSync(serverUrl: string): SystemConfigSync {
  const realtimeUrl = formatRealtimeUrl(serverUrl);
  const subscribeMessage: ClientMessage = {
    type: "subscribe",
    target: { kind: "system" },
  };
  let reconnectTimer: NodeJS.Timeout | null = null;
  let socket: WebSocket | null = null;
  let stopped = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const parsed = serverMessageLenientSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) {
        return;
      }
      if (
        parsed.data.entity === "system" &&
        parsed.data.changes.includes("config-changed")
      ) {
        void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
      }
    } catch {
      return;
    }
  }

  function connect(): void {
    if (stopped) {
      return;
    }
    socket = new WebSocket(realtimeUrl);
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify(subscribeMessage));
      void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
}

async function refreshSystemConfig(
  args: SystemConfigRequestArgs,
): Promise<void> {
  const token = systemConfigRefreshToken + 1;
  systemConfigRefreshToken = token;
  try {
    const config = await fetchSystemConfig(args);
    if (token !== systemConfigRefreshToken) {
      return;
    }
    currentAppKeybindings = config.keybindings;
    currentApplicationMenuAccelerators = resolveApplicationMenuAccelerators(
      currentAppKeybindings,
    );
    refreshApplicationMenu();
  } catch (error) {
    if (token !== systemConfigRefreshToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    desktopLogger.warn(`Could not refresh system config: ${message}`);
  }
}

function createRemoteSystemConfigSync(serverUrl: string): SystemConfigSync {
  function refresh(): void {
    void refreshSystemConfig({
      fetchImpl: (input, init) =>
        net.fetch(input as string | Request, {
          ...init,
          credentials: "include",
        }),
      serverUrl,
    });
  }

  const timer = setInterval(refresh, REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS);
  timer.unref();
  refreshRemoteSystemConfig = refresh;
  refresh();

  return {
    stop(): void {
      clearInterval(timer);
      refreshRemoteSystemConfig = null;
    },
  };
}

function stopSystemConfigSync(): void {
  systemConfigSync?.stop();
  systemConfigSync = null;
}

function startSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createSystemConfigSync(serverUrl);
  void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
}

function startRemoteSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createRemoteSystemConfigSync(serverUrl);
}

function registerApplicationWindow(browserWindow: DesktopBrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  applicationWindowWebContentsIds.add(webContentsId);
  const nativeWindow = BrowserWindow.fromId(browserWindow.id);
  if (nativeWindow !== null) {
    desktopBrowserBroker?.registerWindow(nativeWindow);
    nativeWindow.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          splitNavigationEnabledWebContentsIds.delete(webContentsId);
          splitNavigationCommandsByWebContentsId.delete(webContentsId);
          desktopFindViewManager?.close(nativeWindow);
        }
      },
    );
    const layoutFindView = () => {
      desktopFindViewManager?.layout(nativeWindow);
    };
    nativeWindow.on("resize", layoutFindView);
    nativeWindow.on("enter-full-screen", layoutFindView);
    nativeWindow.on("leave-full-screen", layoutFindView);
  }
  registerApplicationRendererReloadShortcut(
    (browserWindow as BrowserWindow).webContents,
  );
  registerDesktopContextMenu({ webContents: browserWindow.webContents });
  browserWindow.on("enter-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("leave-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("closed", () => {
    desktopFindViewManager?.releaseWindow(webContentsId);
    desktopBrowserBroker?.releaseWindow(webContentsId);
    applicationWindowWebContentsIds.delete(webContentsId);
    splitNavigationEnabledWebContentsIds.delete(webContentsId);
    splitNavigationCommandsByWebContentsId.delete(webContentsId);
  });
}

async function ensureBuiltinRuntimeAttached(): Promise<boolean> {
  if (localServerMove !== null) {
    return false;
  }
  if (currentRuntime !== null) {
    return true;
  }
  if (desktopBridgePath === null || desktopUserDataPath === null) {
    return false;
  }

  const existingProbe = await probeSandyServer({
    serverUrl: builtinServerUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    setCurrentRuntime({
      sandyProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    return true;
  }

  if (existingProbe.kind === "incompatible") {
    return false;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: desktopBridgePath,
    serverUrl: builtinServerUrl,
    userDataPath: desktopUserDataPath,
  });
  return runtime !== null;
}

function showServerMovedNotice(notice: ServerMovedNotice): void {
  const options: MessageBoxOptions = {
    buttons: ["OK"],
    detail: notice.detail,
    message: notice.message,
    type: "info",
  };
  const parentWindow = getFocusedApplicationWindow();
  const shown =
    parentWindow === null
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(parentWindow, options);
  shown.catch((error: unknown) => {
    desktopLogger.warn(
      `[desktop] could not show the server move notice: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function activateLocalServerMove(move: DesktopServerMove): Promise<void> {
  if (
    serverTargetStore === null ||
    serverMoveNoticeStore === null ||
    machineServiceNoticeStore === null ||
    desktopBridgePath === null ||
    desktopUserDataPath === null ||
    builtinDataDir === null
  ) {
    return;
  }
  const bridgePath = desktopBridgePath;
  const userDataPath = desktopUserDataPath;
  localServerMove = move;
  stopServerMovedWatcher();
  desktopLogger.info(
    `[desktop] this computer's sandy server moved to ${move.toHostName}; the app now opens that server and runs this computer as a regular machine`,
  );
  await applyServerMove({
    move,
    noticeStore: serverMoveNoticeStore,
    showNotice: showServerMovedNotice,
    targetStore: serverTargetStore,
  });
  refreshApplicationMenu();
  connectMovedMachine({
    bridgePath,
    dataDir: builtinDataDir,
    move,
    noticeStore: machineServiceNoticeStore,
    userDataPath,
  });
}

function connectMovedMachine(args: {
  bridgePath: string;
  dataDir: string;
  move: DesktopServerMove;
  noticeStore: ServerMoveNoticeStore;
  userDataPath: string;
}): void {
  if (movedMachineConnection !== null) {
    return;
  }
  const logPath = join(
    args.dataDir,
    "logs",
    MACHINE_SERVICE_INSTALL_LOG_FILE_NAME,
  );
  movedMachineConnection = (async () => {
    await keepMovedMachineConnected({
      findService: () =>
        findMachineServiceFile({
          dataDir: args.dataDir,
          homeDir: homedir(),
          platform: process.platform,
        }),
      install: () =>
        runMachineInstaller({
          dataDir: args.dataDir,
          env: process.env,
          installerPath: resolveDesktopMachineInstallerPath(args.bridgePath),
          logPath,
        }),
      logInfo: (message) => {
        desktopLogger.info(message);
      },
      logPath,
      move: args.move,
      noticeStore: args.noticeStore,
      showNotice: showServerMovedNotice,
      stopLocalRuntime: stopOwnedRuntime,
    });
    if (quitting) {
      return;
    }
    await ensureServerMovedRuntime({
      hasLocalRuntime: () => currentRuntime !== null,
      async isLocalAddressFree() {
        const probe = await probeSandyServer({
          serverUrl: builtinServerUrl,
          timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
        });
        return probe.kind === "unavailable";
      },
      localServerUrl: builtinServerUrl,
      logInfo: (message) => {
        desktopLogger.info(message);
      },
      async startLocalRuntime() {
        await spawnOwnedRuntime({
          bridgePath: args.bridgePath,
          serverUrl: builtinServerUrl,
          userDataPath: args.userDataPath,
        });
      },
    });
    refreshApplicationMenu();
  })()
    .catch((error: unknown) => {
      desktopLogger.warn(
        `[desktop] could not keep this computer connected as a machine: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      movedMachineConnection = null;
    });
}

async function confirmLocalServerMove(
  move: DesktopServerMove,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  const dataDir = builtinDataDir;
  if (dataDir === null) {
    return false;
  }
  const result = await waitForCommittedServerMove({
    dataDir,
    async hasLiveLocalLauncher() {
      return (
        currentRuntime?.ownership === "spawned" ||
        (await hasLiveSandyAppLauncher({ dataDir }))
      );
    },
    intervalMs: SERVER_MOVE_COMMIT_INTERVAL_MS,
    isCancelled: () => quitting || isCancelled(),
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    move,
    probeLocalServer: () =>
      probeLocalServerMove({
        serverUrl: builtinServerUrl,
        timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
      }),
    timeoutMs,
  });
  if (result === "withdrawn") {
    desktopLogger.info(
      `[desktop] server move ${move.moveId} was withdrawn before it finished; staying on ${BUILTIN_SERVER_NAME}`,
    );
  } else if (result === "timed-out" && timeoutMs > 0) {
    desktopLogger.warn(
      `[desktop] server move ${move.moveId} is locked, but ${builtinServerUrl} did not report server_moved within ${timeoutMs}ms; staying on ${BUILTIN_SERVER_NAME}`,
    );
  }
  return result === "committed";
}

async function readCommittedLocalServerMove(): Promise<DesktopServerMove | null> {
  if (builtinDataDir === null) {
    return null;
  }
  const move = await readServerMovedLock({
    dataDir: builtinDataDir,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
  });
  if (move === null || !(await confirmLocalServerMove(move, 0, () => false))) {
    return null;
  }
  return move;
}

async function activateLocalServerMoveIfLocked(): Promise<void> {
  const move = await readCommittedLocalServerMove();
  if (move === null) {
    localServerMove = null;
    return;
  }
  await activateLocalServerMove(move);
}

function startServerMovedWatcher(): void {
  if (
    serverMovedWatcher !== null ||
    localServerMove !== null ||
    builtinDataDir === null
  ) {
    return;
  }
  serverMovedWatcher = createServerMovedWatcher({
    confirmMove: (move, isCancelled) =>
      confirmLocalServerMove(move, SERVER_MOVE_COMMIT_TIMEOUT_MS, isCancelled),
    dataDir: builtinDataDir,
    debounceMs: SERVER_MOVED_WATCH_DEBOUNCE_MS,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    onMove(move) {
      void handleWatchedServerMove(move);
    },
    pollIntervalMs: SERVER_MOVED_POLL_INTERVAL_MS,
  });
  serverMovedWatcher.start();
}

function stopServerMovedWatcher(): void {
  serverMovedWatcher?.stop();
  serverMovedWatcher = null;
}

async function handleWatchedServerMove(move: DesktopServerMove): Promise<void> {
  if (
    localServerMove !== null ||
    serverTargetStore?.getTarget().kind !== "builtin"
  ) {
    stopServerMovedWatcher();
    return;
  }
  try {
    await activateLocalServerMove(move);
  } catch (error) {
    desktopLogger.warn(
      `[desktop] could not switch to the moved sandy server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const generation = serverTargetGeneration;
  if (move.target.kind === "custom") {
    await waitForServerMoveDestination({
      fetchImpl: (input, init) => net.fetch(input, init),
      intervalMs: SERVER_MOVE_DESTINATION_INTERVAL_MS,
      isCancelled: () => quitting || serverTargetGeneration !== generation,
      serverUrl: move.target.url,
      timeoutMs: SERVER_MOVE_DESTINATION_TIMEOUT_MS,
    });
  }
  if (quitting || serverTargetGeneration !== generation) {
    return;
  }
  await applyServerTarget();
}

async function runStartupAction(
  action: StartupActionId,
  browserWindow: BrowserWindow | null,
): Promise<void> {
  if (action === "choose-server") {
    popupServerMenu(browserWindow);
    return;
  }
  if (startupActionPending) {
    return;
  }
  startupActionPending = true;
  try {
    startupErrorPage = null;
    await loadLoadingView();
    if (
      action === "open-moved-server" &&
      localServerMove !== null &&
      serverTargetStore !== null
    ) {
      await openServerMoveTarget({
        move: localServerMove,
        targetStore: serverTargetStore,
      });
    }
    await applyServerTarget();
  } catch (error) {
    await loadStartupError({
      actions: [],
      details: error instanceof Error ? error.message : String(error),
      logs: "",
      title: "Could not open sandy",
    });
  } finally {
    startupActionPending = false;
  }
}

async function selectBuiltinServer(): Promise<void> {
  if (serverTargetStore === null) {
    return;
  }
  const move = await readCommittedLocalServerMove();
  if (move !== null) {
    localServerMove = move;
    await loadServerMovedView(move);
    refreshApplicationMenu();
    return;
  }
  const switched = await serverTargetStore.setTarget("builtin");
  if (!switched) {
    refreshApplicationMenu();
    return;
  }
  await applyServerTarget();
}

async function loadServerMovedView(move: DesktopServerMove): Promise<void> {
  await loadActionView({
    actions: [
      { id: "open-moved-server", label: `Open ${move.toHostName}` },
      { id: "choose-server", label: "Choose server…" },
    ],
    details: move.oldCopyKept
      ? "The old copy on this computer is locked after the move."
      : "The old copy on this computer was deleted.",
    logs: "",
    title: `sandy moved to ${move.toHostName}`,
  });
}

async function applyServerTarget(): Promise<void> {
  startupErrorPage = null;
  if (serverTargetStore === null) {
    return;
  }
  serverTargetGeneration += 1;
  const generation = serverTargetGeneration;
  const isCurrent = (): boolean => serverTargetGeneration === generation;
  desktopBrowserBrokerClient?.suspend();
  for (const window of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(window.webContents.id))
      desktopBrowserViewManager?.prepareWindowReload(window);
  }
  await loadLoadingView();
  if (!isCurrent()) return;
  if (serverTargetStore.getTarget().kind === "builtin") {
    await activateLocalServerMoveIfLocked();
    if (!isCurrent()) {
      return;
    }
  }
  const target = serverTargetStore.getTarget();
  desktopBrowserBrokerClient?.reconnect();

  if (target.kind === "builtin") {
    startServerMovedWatcher();
    const attached = await ensureBuiltinRuntimeAttached();
    if (!isCurrent()) {
      return;
    }
    if (!attached) {
      await loadStartupError({
        actions: [
          { id: "retry", label: "Try again" },
          { id: "choose-server", label: "Choose server…" },
        ],
        details:
          `Could not connect to the local sandy server on ${process.platform === "darwin" ? "this Mac" : "this computer"}. ` +
          "Check that the port is free or that a compatible sandy server is running.",
        logs: "",
        title: "Could not connect to sandy server",
      });
      refreshApplicationMenu();
      return;
    }
    const localServerUrl = currentRuntime?.serverUrl ?? builtinServerUrl;
    startSystemConfigSync(localServerUrl);
    await loadSandyApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: localServerUrl,
      }),
    );
  } else {
    stopServerMovedWatcher();
    await loadRemoteServerTarget(target.url, isCurrent);
    if (!isCurrent()) {
      return;
    }
  }
  refreshApplicationMenu();
}

async function loadRemoteServerTarget(
  serverUrl: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const loaded = await loadRemoteServerPage({
    isCurrent,
    loadStartupError,
    loadUrl: loadWindowUrl,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    serverUrl,
  });
  if (!loaded || !isCurrent()) {
    return loaded;
  }
  sandyAppLoaded = true;
  startRemoteSystemConfigSync(serverUrl);
  return true;
}

async function setActiveServerTarget(serverId: string): Promise<void> {
  if (
    serverTargetStore === null ||
    !listServerChoices().some(
      (choice) => choice.id === serverId && !choice.active,
    )
  ) {
    return;
  }
  if (serverId.startsWith("custom:")) {
    const url = serverTargetStore
      .getCustomServerUrls()
      .find((url) => customServerId(url) === serverId);
    if (url === undefined) {
      return;
    }
    await serverTargetStore.setCustomServerUrl(url);
    await applyServerTarget();
    return;
  }
  if (serverId === "builtin") await selectBuiltinServer();
}

async function openSetServerUrlDialog(add = false): Promise<void> {
  if (serverTargetStore === null || serverUrlDialogPreloadPath === null) {
    return;
  }
  const target = serverTargetStore.getTarget();
  if (!add && target.kind !== "custom") {
    return;
  }
  const previousUrl = !add && target.kind === "custom" ? target.url : null;
  const result = await openServerUrlDialog({
    initialName:
      serverTargetStore
        .getCustomServers()
        .find((server) => server.url === previousUrl)?.name ?? null,
    initialUrl: previousUrl,
    mode: add ? "add" : "edit",
    parentWindow: getFocusedApplicationWindow(),
    preloadPath: serverUrlDialogPreloadPath,
  });
  if (result.kind === "cancelled") {
    return;
  }
  if (
    result.kind === "clear" &&
    serverTargetStore.getCustomServerUrl() === null
  ) {
    return;
  }
  if (result.kind === "set" && result.url === previousUrl) {
    await serverTargetStore.setCustomServerName(previousUrl, result.name);
    refreshApplicationMenu();
    return;
  }
  await serverTargetStore.setCustomServerUrl(
    result.kind === "set" ? result.url : null,
    {
      ...(previousUrl === null ? {} : { replacedUrl: previousUrl }),
      ...(result.kind === "set" && !(add && result.name === null)
        ? { name: result.name }
        : {}),
    },
  );
  await applyServerTarget();
}

function sendLogViewerSnapshot(args: SendLogViewerSnapshotArgs): void {
  if (args.browserWindow.isDestroyed()) {
    return;
  }
  args.browserWindow.webContents.send(LOG_VIEWER_SNAPSHOT_CHANNEL, {
    lines: args.lines,
    logDir: args.logDir,
  });
}

async function handleOpenLogsFolder(): Promise<LogViewerOpenLogsFolderResult> {
  const logDir = formatLogDirectory();
  const errorMessage = await shell.openPath(logDir);
  if (errorMessage.length > 0) {
    throw new Error(errorMessage);
  }
  return { path: logDir };
}

function installLogViewerIpcHandlers(): void {
  ipcMain.handle(
    LOG_VIEWER_COPY_CHANNEL,
    (_event, request: LogViewerCopyRequest) => {
      return clipboard.writeText(
        logViewerCopyRequestSchema.parse(request).text,
      );
    },
  );
  ipcMain.handle(LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL, () =>
    handleOpenLogsFolder(),
  );
}

async function loadLogViewerWindow(
  args: LoadLogViewerWindowArgs,
): Promise<void> {
  const browserWindow = new BrowserWindow({
    height: 720,
    minHeight: 520,
    minWidth: 840,
    show: false,
    title: "sandy - Local Logs",
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
    },
    width: 1180,
  });
  const tailer = createLogTailer({
    logDir: args.logDir,
    onLines(lines) {
      logViewerLineBuffer?.append(lines);
    },
  });
  const lineBuffer = createLogLineBuffer({
    flushIntervalMs: LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
    flushLineCount: LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
    maxLines: LOG_VIEWER_VISIBLE_LINE_LIMIT,
    onFlush(lines) {
      if (logViewerWindow === null || logViewerWindow.isDestroyed()) {
        return;
      }
      logViewerWindow.webContents.send(LOG_VIEWER_APPEND_CHANNEL, {
        lines,
      });
    },
  });

  logViewerLineBuffer = lineBuffer;
  logViewerTailer = tailer;
  logViewerWindow = browserWindow;

  browserWindow.once("ready-to-show", () => {
    browserWindow.show();
  });
  browserWindow.on("closed", () => {
    if (logViewerTailer === tailer) {
      logViewerTailer = null;
      tailer.stop();
    }
    if (logViewerWindow === browserWindow) {
      logViewerWindow = null;
    }
    if (logViewerLineBuffer === lineBuffer) {
      logViewerLineBuffer = null;
    }
    lineBuffer.stop();
  });

  await browserWindow.loadURL(createLogViewerViewUrl({ logDir: args.logDir }));
  sendLogViewerSnapshot({
    browserWindow,
    lines: lineBuffer.lines(),
    logDir: args.logDir,
  });
  await tailer.start();
}

async function openLocalLogs(): Promise<void> {
  if (logViewerPreloadPath === null) {
    return;
  }

  if (logViewerWindow !== null && !logViewerWindow.isDestroyed()) {
    logViewerWindow.focus();
    return;
  }

  await loadLogViewerWindow({
    logDir: formatLogDirectory(),
    preloadPath: logViewerPreloadPath,
  });
}

async function openDataDirectory(): Promise<void> {
  const dataDir = resolveDataDirFromEnv({
    env: process.env,
    homeDir: homedir(),
  });
  const errorMessage = await shell.openPath(dataDir);
  if (errorMessage.length > 0) {
    desktopLogger.error(
      `[desktop] could not open the data directory ${dataDir}: ${errorMessage}`,
    );
  }
}

async function loadWindowUrl(args: LoadWindowUrlArgs): Promise<void> {
  startupErrorPage = null;
  currentWindowUrl = args.url;
  if (desktopWindowFactory === null) {
    return;
  }

  await desktopWindowFactory.loadUrl({ url: args.url });
}

async function loadLoadingView(): Promise<void> {
  sandyAppLoaded = false;
  await loadWindowUrl({
    url: createLocalViewUrl({
      viewModel: {
        kind: "loading",
        message: "Starting local services and opening the sandy workspace.",
        title: "Opening sandy",
      },
    }),
  });
}

async function loadStartupError(args: LoadStartupErrorArgs): Promise<void> {
  desktopLogger.error(
    args.logs.length === 0
      ? `[desktop] ${args.title}: ${args.details}`
      : `[desktop] ${args.title}: ${args.details}\nsandy-app output:\n${args.logs}`,
  );
  await loadActionView({
    ...args,
    details:
      args.actions.length === 0
        ? `${args.details} Logs are under ${formatLogDirectory()}/.`
        : args.details,
  });
}

async function loadActionView(args: LoadStartupErrorArgs): Promise<void> {
  sandyAppLoaded = false;
  const url = createLocalViewUrl({
    viewModel: {
      actions: args.actions,
      details: args.details,
      kind: "error",
      logText: args.logs,
      title: args.title,
    },
  });
  const loading = loadWindowUrl({ url });
  startupErrorPage =
    args.actions.length === 0
      ? null
      : { actions: args.actions.map((action) => action.id), url };
  await loading;
}

async function loadSandyApp(serverUrl: string): Promise<void> {
  sandyAppLoaded = true;
  await loadWindowUrl({ url: serverUrl });
  if (shouldOpenDevTools()) {
    desktopWindowFactory?.openDevTools();
  }
}

function shouldOpenDevTools(): boolean {
  return process.env.SANDY_DESKTOP_OPEN_DEVTOOLS === "1";
}

async function createApplicationWindow(
  args: CreateApplicationWindowArgs,
): Promise<DesktopBrowserWindow | null> {
  if (desktopWindowFactory === null) {
    return null;
  }

  const browserWindow = await desktopWindowFactory.createWindow({
    initialUrl: args.initialUrl,
    stateKey: args.stateKey,
  });
  if (sandyAppLoaded && shouldOpenDevTools()) {
    browserWindow.webContents.openDevTools({ mode: "detach" });
  }
  return browserWindow;
}

async function stopOwnedRuntime(): Promise<void> {
  const runtime = currentRuntime;
  if (runtime === null || runtime.ownership !== "spawned") {
    setCurrentRuntime(null);
    return;
  }

  setCurrentRuntime(null);
  try {
    await runtime.sandyProcess?.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: OWNED_RUNTIME_KILL_TIMEOUT_MS,
      signal: "SIGTERM",
      timeoutMs: OWNED_RUNTIME_STOP_TIMEOUT_MS,
    });
  } finally {
    if (runtime.userDataPath !== null) {
      await clearOwnedRuntimePidFile({ userDataPath: runtime.userDataPath });
    }
  }
}

function handleBeforeQuit(event: Event): void {
  quitting = true;
  if (stoppingForQuit) {
    return;
  }

  event.preventDefault();
  stoppingForQuit = true;
  void finishQuit().finally(() => {
    app.quit();
  });
}

async function finishQuit(): Promise<void> {
  stopServerMovedWatcher();
  desktopBrowserBrokerClient?.stop();
  desktopBrowserBroker?.dispose();
  stopSystemConfigSync();
  desktopBrowserViewManager?.destroyAll();
  desktopFindViewManager?.destroyAll();
  await desktopWindowFactory
    ?.persistOpenWindows()
    .catch((error) =>
      desktopLogger.error(
        `Could not save desktop window state: ${String(error)}`,
      ),
    );
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    browserWindow.hide();
  }
  await stopOwnedRuntime();
}

function registerDesktopInfoIpc(): void {
  registerServerChoiceIpc({
    applicationWindowWebContentsIds,
    list: listServerChoices,
    select: setActiveServerTarget,
    onError: (error) =>
      desktopLogger.error(`Could not switch server: ${String(error)}`),
  });
  registerDesktopWindowFocusIpc(applicationWindowWebContentsIds);
  registerDesktopAttentionIpc(applicationWindowWebContentsIds);
  registerDesktopClipboardIpc(applicationWindowWebContentsIds);
  ipcMain.on(SANDY_DESKTOP_ZOOM_COMMAND_CHANNEL, (event, payload: unknown) => {
    const parsed = sandyDesktopZoomCommandSchema.safeParse(payload);
    if (parsed.success) {
      zoomWebContents(
        resolveApplicationWindow(event.sender)?.webContents,
        parsed.data,
      );
    }
  });
  ipcMain.handle(SANDY_DESKTOP_GET_INFO_CHANNEL, () => {
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(SANDY_DESKTOP_GET_WINDOW_STATE_CHANNEL, (event) => {
    return getSenderDesktopWindowState(event);
  });
  ipcMain.handle(SANDY_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL, async () => {
    await openLocalLogs();
  });
  ipcMain.handle(SANDY_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL, async () => {
    await openDataDirectory();
  });
  ipcMain.on(
    SANDY_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
    (event, enabled: unknown, directionalCommands: unknown) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame ||
        typeof enabled !== "boolean"
      ) {
        return;
      }
      const parsed = appCommandIdSchema
        .array()
        .safeParse(directionalCommands ?? []);
      if (!parsed.success) return;
      if (enabled) {
        splitNavigationEnabledWebContentsIds.add(event.sender.id);
        if (directionalCommands !== undefined) {
          splitNavigationCommandsByWebContentsId.set(
            event.sender.id,
            parsed.data,
          );
        }
      } else {
        splitNavigationEnabledWebContentsIds.delete(event.sender.id);
        splitNavigationCommandsByWebContentsId.delete(event.sender.id);
      }
    },
  );
  ipcMain.on(SANDY_DESKTOP_SET_THEME_CHANNEL, (_event, payload: unknown) => {
    const parsed = sandyDesktopThemeSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    nativeTheme.themeSource = parsed.data;
  });
  ipcMain.on(STARTUP_ACTION_CHANNEL, (event, ...payload: unknown[]) => {
    const action = startupActionIdSchema.safeParse(payload[0]);
    const page = startupErrorPage;
    if (
      payload.length !== 1 ||
      !action.success ||
      page === null ||
      !page.actions.includes(action.data) ||
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== page.url
    ) {
      return;
    }
    void runStartupAction(action.data, resolveApplicationWindow(event.sender));
  });

  ipcMain.on(SANDY_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, (event, payload) => {
    const pending = pendingCloseWindowRequests.get(event.sender.id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingCloseWindowRequests.delete(event.sender.id);
    }
    if (payload === false) {
      resolveApplicationWindow(event.sender)?.close();
    }
  });
  ipcMain.handle(
    SANDY_DESKTOP_OPEN_APPLICATION_URL_CHANNEL,
    async (event, value: unknown) => {
      const owner = resolveApplicationWindow(event.sender);
      if (
        owner === null ||
        owner.webContents !== event.sender ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Application window is unavailable.");
      await openApplicationUrl(value);
    },
  );

  ipcMain.on(
    SANDY_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
    (_event, payload: unknown) => {
      const url = resolveDesktopExternalUrl(payload);
      if (url !== null) {
        void shell.openExternal(url);
      }
    },
  );
}

interface DesktopBrowserWindowLifecycleArgs {
  browserWindow: BrowserWindow;
  manager: DesktopBrowserViewManager;
}

const WINDOW_RESIZE_SETTLE_MS = 200;

function registerDesktopBrowserWindowLifecycle({
  browserWindow,
  manager,
}: DesktopBrowserWindowLifecycleArgs): void {
  const hostWebContentsId = browserWindow.webContents.id;
  let resizeSettleTimer: NodeJS.Timeout | null = null;
  const endWindowResize = () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    if (!browserWindow.isDestroyed()) {
      manager.endWindowResize(browserWindow);
    }
  };
  browserWindow.on("resize", () => {
    manager.beginWindowResize(browserWindow);
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
    }
    resizeSettleTimer = setTimeout(endWindowResize, WINDOW_RESIZE_SETTLE_MS);
  });
  browserWindow.on("resized", endWindowResize);
  browserWindow.once("closed", () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    manager.releaseWindow(hostWebContentsId);
  });
}

async function spawnOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<OwnedRuntime> {
  const sandyProcess = startSandyAppProcess({
    bridgePath: args.bridgePath,
    cwd: homedir(),
    env: {
      ...process.env,
      [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP,
    },
    logLineLimit: PROCESS_LOG_LINE_LIMIT,
    runtime: resolveSandyAppProcessRuntime({
      env: process.env,
      isPackaged: app.isPackaged,
      platform: process.platform,
      processExecPath: process.execPath,
    }),
  });
  const runtime: DesktopRuntime = {
    sandyProcess,
    ownership: "spawned",
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  };
  await writeOwnedRuntimePidFile({
    bridgePath: args.bridgePath,
    pid: sandyProcess.pid,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  setCurrentRuntime(runtime);

  void sandyProcess.exit.then((exit) => {
    void clearOwnedRuntimePidFile({ userDataPath: args.userDataPath });
    if (quitting || currentRuntime !== runtime) {
      return;
    }
    setCurrentRuntime(null);
    if (localServerMove !== null) {
      desktopLogger.warn(
        `[desktop] the Electron-owned sandy-app process that runs this computer as a machine stopped with ${formatExitResult(exit)}`,
      );
      return;
    }
    void loadStartupError({
      details: `The Electron-owned sandy-app process stopped with ${formatExitResult(
        exit,
      )}.`,
      logs: sandyProcess.logs.text(),
      actions: [],
      title: "sandy stopped",
    });
  });
  return { sandyProcess, runtime };
}

async function startOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<DesktopRuntime | null> {
  const { sandyProcess, runtime } = await spawnOwnedRuntime(args);

  const raceResult = await Promise.race<StartupRaceResult>([
    waitForCompatibleServer({
      intervalMs: STARTUP_POLL_INTERVAL_MS,
      serverUrl: args.serverUrl,
      timeoutMs: STARTUP_TIMEOUT_MS,
    }).then((result) => ({
      kind: "server-probe",
      result,
    })),
    sandyProcess.exit.then((exit) => ({
      exit,
      kind: "process-exited",
    })),
  ]);

  if (raceResult.kind === "process-exited") {
    await loadStartupError({
      details: `sandy-app exited before the server was ready with ${formatExitResult(
        raceResult.exit,
      )}.`,
      logs: sandyProcess.logs.text(),
      actions: [],
      title: "Could not start sandy",
    });
    setCurrentRuntime(null);
    return null;
  }

  if (raceResult.result.kind === "compatible") {
    return runtime;
  }

  await loadStartupError({
    details:
      raceResult.result.kind === "incompatible"
        ? `Port ${args.serverUrl} is responding, but it does not look like sandy: ${raceResult.result.reason}.`
        : `Timed out waiting for sandy at ${args.serverUrl}: ${raceResult.result.reason}.`,
    logs: sandyProcess.logs.text(),
    actions: [],
    title: "Could not start sandy",
  });
  await stopOwnedRuntime();
  return null;
}

interface InitializeRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

function shouldAskBeforeAttaching(): boolean {
  if (!app.isPackaged || existingServerDialogPreloadPath === null) {
    return false;
  }
  if (process.env.SANDY_DESKTOP_ATTACH_WITHOUT_PROMPT === "1") {
    return false;
  }
  return (process.env.SANDY_DESKTOP_APP_URL ?? "").trim().length === 0;
}

async function waitForServerToStop(serverUrl: string): Promise<boolean> {
  const deadline = Date.now() + FOREIGN_RUNTIME_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const probe = await probeSandyServer({
      serverUrl,
      timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
    });
    if (probe.kind === "unavailable") {
      return true;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, STARTUP_POLL_INTERVAL_MS);
    });
  }
  return false;
}

type ExistingServerDecision = "attach" | "quit" | "start-fresh";

async function decideOnExistingServer(
  probe: CompatibleServerProbeResult,
): Promise<ExistingServerDecision> {
  if (!shouldAskBeforeAttaching()) {
    return "attach";
  }

  const preloadPath = existingServerDialogPreloadPath;
  if (preloadPath === null) {
    return "attach";
  }

  const details = await readForeignRuntimeDetails({
    dataDir: probe.dataDir,
    serverUrl: probe.serverUrl,
  });
  const choice = await openExistingServerDialog({
    details,
    parentWindow: getFocusedApplicationWindow(),
    preloadPath,
    serverUrl: probe.serverUrl,
  });

  if (choice === "quit") {
    return "quit";
  }
  if (choice === "connect" || details === null) {
    return "attach";
  }

  const stopResult = await stopForeignRuntime({
    details,
    killTimeoutMs: FOREIGN_RUNTIME_KILL_TIMEOUT_MS,
    timeoutMs: FOREIGN_RUNTIME_STOP_TIMEOUT_MS,
  });
  if (stopResult.kind === "unverified") {
    await loadStartupError({
      details:
        `The sandy at ${probe.serverUrl} records process ${String(stopResult.pid)}, but that ` +
        "process no longer matches the record. sandy did not stop it. Stop it yourself, then open sandy again.",
      logs: "",
      actions: [],
      title: "Could not stop the running sandy",
    });
    return "quit";
  }
  if (stopResult.kind === "still-running") {
    await loadStartupError({
      details: `sandy could not stop process ${String(stopResult.pid)}, even after SIGKILL.`,
      logs: "",
      actions: [],
      title: "Could not stop the running sandy",
    });
    return "quit";
  }
  if (stopResult.kind === "replaced") {
    await loadStartupError({
      details:
        `Another sandy started at ${probe.serverUrl} while the question was open, so sandy stopped nothing. ` +
        "Open sandy again to see the copy that runs now.",
      logs: "",
      actions: [],
      title: "Could not stop the running sandy",
    });
    return "quit";
  }
  if (!(await waitForServerToStop(probe.serverUrl))) {
    await loadStartupError({
      details: `The sandy at ${probe.serverUrl} stopped, but the address is still in use.`,
      logs: "",
      actions: [],
      title: "Could not stop the running sandy",
    });
    return "quit";
  }
  return "start-fresh";
}

async function initializeRuntime(args: InitializeRuntimeArgs): Promise<void> {
  const existingProbe = await probeSandyServer({
    serverUrl: args.serverUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    const decision = await decideOnExistingServer(existingProbe);
    if (decision === "quit") {
      app.quit();
      return;
    }
    if (decision === "start-fresh") {
      await loadLoadingView();
      const freshRuntime = await startOwnedRuntime({
        bridgePath: args.bridgePath,
        serverUrl: args.serverUrl,
        userDataPath: args.userDataPath,
      });
      if (freshRuntime !== null) {
        await loadSandyApp(freshRuntime.serverUrl);
        startSystemConfigSync(freshRuntime.serverUrl);
        refreshApplicationMenu();
      }
      return;
    }

    setCurrentRuntime({
      sandyProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    await loadSandyApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: existingProbe.serverUrl,
      }),
    );
    startSystemConfigSync(existingProbe.serverUrl);
    refreshApplicationMenu();
    return;
  }

  if (existingProbe.kind === "incompatible") {
    await loadStartupError({
      details: `Port ${args.serverUrl} is already in use, but it is not a compatible sandy server: ${existingProbe.reason}.`,
      logs: "",
      actions: [],
      title: "Port conflict",
    });
    return;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: args.bridgePath,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  if (runtime !== null) {
    await loadSandyApp(runtime.serverUrl);
    startSystemConfigSync(runtime.serverUrl);
    refreshApplicationMenu();
  }
}

async function runDesktopApp(): Promise<void> {
  const applicationName = app.isPackaged
    ? DESKTOP_RELEASE_INFO.applicationName
    : "sandy-dev";
  app.setName(applicationName);
  installAboutPanel(applicationName);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (desktopWindowFactory?.focusFirstWindow() === true) {
      return;
    }
    void createApplicationWindow({
      initialUrl: currentWindowUrl,
      stateKey: null,
    });
  });
  app.on("before-quit", handleBeforeQuit);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (desktopWindowFactory?.hasOpenWindows() === false) {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    }
  });
  app.on("did-become-active", () => {
    refreshRemoteSystemConfig?.();
  });
  app.on("browser-window-created", (_event, browserWindow) => {
    if (desktopBrowserViewManager === null) {
      return;
    }
    registerDesktopBrowserWindowLifecycle({
      browserWindow,
      manager: desktopBrowserViewManager,
    });
  });
  registerDesktopShutdownSignalHandlers({
    exitProcess(code) {
      process.exitCode = code;
    },
    processEvents: process,
    quitApplication() {
      app.quit();
    },
    async stopOwnedRuntime() {
      quitting = true;
      await stopOwnedRuntime();
    },
  });

  app.setAppUserModelId(
    DESKTOP_RELEASE_CHANNEL === "nightly"
      ? "dev.sandy.desktop.nightly"
      : "dev.sandy.desktop",
  );
  if (app.isPackaged) {
    await hostToolchain.refresh();
    Object.assign(process.env, hostToolchain.environment());
  }
  await app.whenReady();
  if (app.isPackaged) {
    await session.defaultSession.clearCache();
  }

  const paths = createDesktopPathContext();
  const devIcon = !paths.isPackaged || process.env.SANDY_DESKTOP_DEV_ICON === "1";
  const iconPath = resolveDesktopIconPath({
    devIcon,
    packagedIconFileName: DESKTOP_RELEASE_INFO.iconFileName,
    paths,
  });
  const bridgePath = resolveDesktopBridgePath({ paths });
  const resolvedLogViewerPreloadPath = join(
    paths.appPath,
    "dist",
    "log-viewer-preload.cjs",
  );
  const preloadPath = join(paths.appPath, "dist", "preload.cjs");
  const browserPagePreloadPath = join(
    paths.appPath,
    "dist",
    "browser-page-preload.cjs",
  );
  const findBarPreloadPath = join(
    paths.appPath,
    "dist",
    "find-bar-preload.cjs",
  );
  const resolvedExistingServerDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "existing-server-dialog-preload.cjs",
  );
  const resolvedServerUrlDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "server-url-dialog-preload.cjs",
  );
  const serverUrl = resolveDesktopServerUrl({ env: process.env });
  builtinServerUrl = serverUrl;
  desktopBridgePath = bridgePath;
  const userDataPath = app.getPath("userData");
  desktopUserDataPath = userDataPath;

  assertPathExists({ label: "sandy-app bridge", path: bridgePath });
  assertPathExists({
    label: "existing server dialog preload script",
    path: resolvedExistingServerDialogPreloadPath,
  });
  assertPathExists({
    label: "log viewer preload script",
    path: resolvedLogViewerPreloadPath,
  });
  assertPathExists({ label: "preload script", path: preloadPath });
  assertPathExists({
    label: "browser page preload script",
    path: browserPagePreloadPath,
  });
  assertPathExists({
    label: "find bar preload script",
    path: findBarPreloadPath,
  });
  assertPathExists({
    label: "server URL dialog preload script",
    path: resolvedServerUrlDialogPreloadPath,
  });
  assertPathExists({ label: "app icon", path: iconPath });

  if (process.platform === "darwin" && app.dock !== undefined && devIcon) {
    app.dock.setIcon(iconPath);
  }
  await reapStaleOwnedRuntime({
    signal: "SIGTERM",
    timeoutMs: 5_000,
    userDataPath,
  });

  serverTargetStore = createServerTargetStore({
    storagePath: join(userDataPath, SERVER_TARGET_FILE_NAME),
  });
  await serverTargetStore.load();
  const dataDir = resolveDataDirFromEnv({
    env: process.env,
    homeDir: homedir(),
  });
  builtinDataDir = dataDir;
  serverMoveNoticeStore = createServerMoveNoticeStore({
    storagePath: join(userDataPath, SERVER_MOVE_NOTICE_FILE_NAME),
  });
  machineServiceNoticeStore = createServerMoveNoticeStore({
    storagePath: join(userDataPath, MACHINE_SERVICE_NOTICE_FILE_NAME),
  });
  registerDesktopInfoIpc();
  desktopFindViewManager = createDesktopFindViewManager({
    preloadPath: findBarPreloadPath,
  });
  ipcMain.on(SANDY_DESKTOP_OPEN_WINDOW_FIND_CHANNEL, (event, payload: unknown) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return;
    }
    const parsed = sandyDesktopWindowFindRequestSchema.safeParse(payload);
    const browserWindow = resolveApplicationWindow(event.sender);
    if (!parsed.success || browserWindow === null) {
      return;
    }
    desktopFindViewManager?.open(browserWindow, parsed.data);
  });
  ipcMain.on(SANDY_DESKTOP_RELOAD_WINDOW_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return;
    }
    const browserWindow = resolveApplicationWindow(event.sender);
    if (browserWindow !== null) {
      reloadApplicationWindow(browserWindow, false);
    }
  });
  void removeLegacyAutomationPartitions(userDataPath).catch(() => {});
  desktopBrowserViewManager = createDesktopBrowserViewManager({
    pagePreloadPath: browserPagePreloadPath,
    dispatchAppCommand({ command, hostWebContentsId }) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow === undefined) {
        return;
      }
      sendToApplicationRenderer(
        browserWindow,
        SANDY_DESKTOP_APP_COMMAND_CHANNEL,
        command,
      );
    },
    focusHostWebContents(hostWebContentsId) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow !== undefined) {
        browserWindow.webContents.focus();
      }
    },
    resolveAppCommand(input, hostWebContentsId) {
      return resolveDesktopBrowserAppCommand({
        input,
        platform: process.platform,
        keybindings: currentAppKeybindings,
        splitNavigationEnabled:
          splitNavigationEnabledWebContentsIds.has(hostWebContentsId),
        splitNavigationCommands:
          splitNavigationCommandsByWebContentsId.get(hostWebContentsId),
      });
    },
  });
  registerDesktopBrowserIpc(desktopBrowserViewManager);
  const browserImportService = createBrowserImportService({
    context: {
      platform: process.platform,
      home: homedir(),
      configHome: process.env.XDG_CONFIG_HOME,
      excludedDirectories: [app.getPath("userData")],
    },
    resolveIcon: (appPath) => readMacAppIcon(appPath),
    log(message, details) {
      desktopLogger.info(
        `[desktop] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`,
      );
    },
  });
  desktopBrowserBroker = createDesktopBrowserBroker({
    manager: desktopBrowserViewManager,
    product: `Chrome/${process.versions.chrome}`,
    browserImport: browserImportService,
  });
  ipcMain.handle(
    SANDY_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    async (event) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) return null;
      return { sources: await browserImportService.listSources() };
    },
  );
  ipcMain.handle(
    SANDY_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
    async (event, payload: unknown) => {
      const parsed =
        sandyDesktopBrowserImportCookiesRequestSchema.safeParse(payload);
      if (
        !parsed.success ||
        !applicationWindowWebContentsIds.has(event.sender.id)
      )
        return null;
      const manager = desktopBrowserViewManager;
      if (!manager) return null;
      return browserImportService.importCookies(
        {
          sourceId: parsed.data.sourceId,
          sourceProfileDirectory: parsed.data.sourceProfileDirectory,
        },
        manager.session(),
      );
    },
  );
  ipcMain.on(
    SANDY_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    (event) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        process.platform !== "darwin"
      )
        return;
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    },
  );
  ipcMain.handle(SANDY_DESKTOP_BROWSER_TARGET_CHANNEL, (event) => {
    return applicationWindowWebContentsIds.has(event.sender.id)
      ? (desktopBrowserBroker?.getTarget(event.sender.id) ?? null)
      : null;
  });
  ipcMain.handle(
    SANDY_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = sandyDesktopBrowserTabRefSchema.safeParse(payload);
      return parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
        ? (desktopBrowserBroker?.getControl(
            event.sender.id,
            parsed.data.tabId,
          ) ?? null)
        : null;
    },
  );
  ipcMain.on(
    SANDY_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = sandyDesktopBrowserTabRefSchema.safeParse(payload);
      if (
        parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
      )
        desktopBrowserBroker?.takeOver(event.sender.id, parsed.data.tabId);
    },
  );
  desktopBrowserBrokerClient = createDesktopBrowserBrokerClient({
    broker: desktopBrowserBroker,
    fetchImpl: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : input, init),
    dataDir,
    homeDir: homedir(),
    getServerUrl() {
      const target = serverTargetStore?.getTarget();
      if (target?.kind === "custom") return target.url;
      return currentRuntime?.serverUrl ?? builtinServerUrl;
    },
  });

  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      return new BrowserWindow(options);
    },
  };
  logViewerPreloadPath = resolvedLogViewerPreloadPath;
  serverUrlDialogPreloadPath = resolvedServerUrlDialogPreloadPath;
  existingServerDialogPreloadPath = resolvedExistingServerDialogPreloadPath;
  desktopWindowFactory = createDesktopWindowFactory({
    browserWindowCreator,
    createWindowStateKey() {
      return `window-${randomUUID()}`;
    },
    shouldUseDarkColors() {
      return nativeTheme.shouldUseDarkColors;
    },
    displayWorkAreas: null,
    icon: nativeImage.createFromPath(iconPath),
    isLinuxTransparent: hasLinuxWindowArgument({
      argument: LINUX_TRANSPARENT_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isMac: process.platform === "darwin",
    isLinuxFrameless: hasLinuxWindowArgument({
      argument: LINUX_FRAMELESS_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isQuitting() {
      return quitting;
    },
    openExternalUrl(openArgs) {
      void shell.openExternal(openArgs.url);
    },
    onWindowCreated: registerApplicationWindow,
    preloadPath,
    userDataPath,
  });
  installLogViewerIpcHandlers();

  refreshApplicationMenu();
  await loadLoadingView();
  await desktopWindowFactory.restoreSavedWindows({
    initialUrl: currentWindowUrl,
  });
  await activateLocalServerMoveIfLocked();
  if (
    serverTargetStore.getTarget().kind === "builtin" &&
    localServerMove === null
  ) {
    startServerMovedWatcher();
    await initializeRuntime({ bridgePath, serverUrl, userDataPath });
  } else {
    await applyServerTarget();
  }
}

void runDesktopApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  void loadStartupError({
    details: message,
    logs: "",
    actions: [],
    title: "Could not open sandy",
  });
});
