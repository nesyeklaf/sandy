import {
  sandyDesktopServerChoicesSchema,
  MACOS_TRAFFIC_LIGHT_INSET_PX,
  MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
  type SandyDesktopServerChoice,
} from "@sandy/desktop-contract";
import { contextBridge, ipcRenderer, webFrame } from "electron";
import { appCommandIdSchema, type AppCommandId } from "@sandy/domain";
import {
  desktopBrowserImportOutcomeSchema,
  desktopBrowserImportSourceSchema,
} from "@sandy/host-daemon-contract";
import { z } from "zod";
import {
  sandyDesktopBrowserEvaluateResultSchema,
  sandyDesktopBrowserFindResultSchema,
  sandyDesktopBrowserOpenTabRequestSchema,
  sandyDesktopBrowserPageMessageSchema,
  sandyDesktopBrowserScopedOpenTabRequestSchema,
  sandyDesktopBrowserTabRefSchema,
  sandyDesktopBrowserSnapshotSchema,
  sandyDesktopBrowserStateSchema,
  sandyDesktopBrowserTargetSchema,
  sandyDesktopBrowserControlStateSchema,
  sandyDesktopBrowserRevealRequestSchema,
  type SandyDesktopBrowserControlState,
  type SandyDesktopClipboardContent,
  type SandyDesktopBrowserRevealRequest,
  sandyDesktopInfoSchema,
  sandyDesktopWindowStateSchema,
  type SandyDesktopApi,
  type SandyDesktopAppCommandHandler,
  type SandyDesktopBrowserApi,
  type SandyDesktopBrowserFindResultHandler,
  type SandyDesktopWindowFindRequest,
  type SandyDesktopBrowserPageMessageHandler,
  type SandyDesktopBrowserOpenTabHandler,
  type SandyDesktopBrowserScopedOpenTabHandler,
  type SandyDesktopBrowserFocusHandler,
  type SandyDesktopBrowserSnapshotHandler,
  type SandyDesktopBrowserStateHandler,
  type SandyDesktopBrowserState,
  type SandyDesktopBrowserUnsubscribe,
  type SandyDesktopBrowserViewBounds,
  type SandyDesktopCloseWindowRequestHandler,
  type SandyDesktopInfo,
  type SandyDesktopInfoChangeHandler,
  type SandyDesktopInfoUnsubscribe,
  type SandyDesktopOpenNewTabHandler,
  type SandyDesktopTheme,
  type SandyDesktopWindowState,
  type SandyDesktopWindowStateChangeHandler,
  type SandyDesktopZoomChangeHandler,
} from "@sandy/desktop-contract";
import {
  SANDY_DESKTOP_GET_INFO_CHANNEL,
  SANDY_DESKTOP_INFO_CHANGED_CHANNEL,
  SANDY_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  SANDY_DESKTOP_OPEN_APPLICATION_URL_CHANNEL,
  SANDY_DESKTOP_SET_THEME_CHANNEL,
  SANDY_DESKTOP_ZOOM_CHANGED_CHANNEL,
  SANDY_DESKTOP_ZOOM_COMMAND_CHANNEL,
} from "./desktop-ipc-channels.js";
import {
  SANDY_DESKTOP_BROWSER_ATTACH_CHANNEL,
  SANDY_DESKTOP_BROWSER_TARGET_CHANNEL,
  SANDY_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  SANDY_DESKTOP_BROWSER_CONTROL_CHANNEL,
  SANDY_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  SANDY_DESKTOP_BROWSER_REVEAL_CHANNEL,
  SANDY_DESKTOP_BROWSER_DETACH_CHANNEL,
  SANDY_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
  SANDY_DESKTOP_BROWSER_FOCUS_CHANNEL,
  SANDY_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  SANDY_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  SANDY_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  SANDY_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  SANDY_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  SANDY_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  SANDY_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  SANDY_DESKTOP_BROWSER_RELOAD_CHANNEL,
  SANDY_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  SANDY_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  SANDY_DESKTOP_BROWSER_STATE_CHANNEL,
  SANDY_DESKTOP_BROWSER_STOP_CHANNEL,
  SANDY_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
  SANDY_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  SANDY_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  SANDY_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
  SANDY_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  SANDY_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import {
  SANDY_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  SANDY_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  SANDY_DESKTOP_SELECT_SERVER_CHANNEL,
  SANDY_DESKTOP_APP_COMMAND_CHANNEL,
  SANDY_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
  SANDY_DESKTOP_RELOAD_WINDOW_CHANNEL,
  SANDY_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
  SANDY_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  SANDY_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  SANDY_DESKTOP_FOCUS_WINDOW_CHANNEL,
  SANDY_DESKTOP_SET_ATTENTION_THREADS_CHANNEL,
  SANDY_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  SANDY_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  SANDY_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL,
  SANDY_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  SANDY_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  SANDY_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
} from "./desktop-window-command-ipc.js";
import {
  getDesktopVersion,
  resolveSandyDesktopPlatform,
} from "./desktop-platform.js";
import { STARTUP_ACTION_CHANNEL } from "./local-view.js";

function createInitialDesktopInfo(): SandyDesktopInfo {
  return {
    platform: resolveSandyDesktopPlatform(process.platform),
    version: getDesktopVersion(process.env.SANDY_DESKTOP_VERSION),
  };
}

function createInitialDesktopWindowState(): SandyDesktopWindowState {
  return {
    isFullScreen: false,
  };
}

const serverChoiceListeners = new Set<
  (choices: SandyDesktopServerChoice[]) => void
>();
const listeners = new Set<SandyDesktopInfoChangeHandler>();
const appCommandListeners = new Set<SandyDesktopAppCommandHandler>();
const windowStateListeners = new Set<SandyDesktopWindowStateChangeHandler>();
let currentInfo = createInitialDesktopInfo();
let currentWindowState = createInitialDesktopWindowState();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentInfo);
  }
}

function notifyWindowStateListeners(): void {
  for (const listener of windowStateListeners) {
    listener(currentWindowState);
  }
}

function applyDesktopInfoPayload(payload: unknown): SandyDesktopInfo | null {
  const parsed = sandyDesktopInfoSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentInfo = parsed.data;
  notifyListeners();
  return currentInfo;
}

function applyDesktopWindowStatePayload(
  payload: unknown,
): SandyDesktopWindowState | null {
  const parsed = sandyDesktopWindowStateSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentWindowState = parsed.data;
  notifyWindowStateListeners();
  return currentWindowState;
}

async function invokeDesktopInfo(channel: string): Promise<SandyDesktopInfo> {
  try {
    const payload: unknown = await ipcRenderer.invoke(channel);
    return applyDesktopInfoPayload(payload) ?? currentInfo;
  } catch {
    return currentInfo;
  }
}

async function invokeDesktopWindowState(): Promise<SandyDesktopWindowState> {
  try {
    const payload: unknown = await ipcRenderer.invoke(
      SANDY_DESKTOP_GET_WINDOW_STATE_CHANNEL,
    );
    return applyDesktopWindowStatePayload(payload) ?? currentWindowState;
  } catch {
    return currentWindowState;
  }
}

const browserStateListeners = new Set<SandyDesktopBrowserStateHandler>();
const browserStates = new Map<string, SandyDesktopBrowserState>();
browserStateListeners.add((state) => {
  browserStates.delete(state.tabId);
  browserStates.set(state.tabId, state);
  if (browserStates.size > 100) {
    const oldest = browserStates.keys().next().value;
    if (oldest !== undefined) browserStates.delete(oldest);
  }
});
const browserControlListeners = new Set<
  (state: SandyDesktopBrowserControlState) => void
>();
const browserRevealListeners = new Set<
  (request: SandyDesktopBrowserRevealRequest) => void
>();
const browserOpenTabListeners = new Set<SandyDesktopBrowserOpenTabHandler>();
const browserScopedOpenTabListeners =
  new Set<SandyDesktopBrowserScopedOpenTabHandler>();
const browserFocusListeners = new Set<SandyDesktopBrowserFocusHandler>();
const browserPageMessageListeners =
  new Set<SandyDesktopBrowserPageMessageHandler>();
const browserSnapshotListeners = new Set<SandyDesktopBrowserSnapshotHandler>();
const browserFindResultListeners = new Set<SandyDesktopBrowserFindResultHandler>();
const closeWindowRequestListeners =
  new Set<SandyDesktopCloseWindowRequestHandler>();
const openNewTabListeners = new Set<SandyDesktopOpenNewTabHandler>();
const zoomListeners = new Set<SandyDesktopZoomChangeHandler>();
let lastZoomFactor = webFrame.getZoomFactor();

function publishZoomFactor(factor: number): void {
  document.documentElement.style.setProperty("--sandy-zoom", String(factor));
  ipcRenderer.send(SANDY_DESKTOP_ZOOM_CHANGED_CHANNEL);
}

function notifyZoomChangeIfChanged(): void {
  const zoomFactor = webFrame.getZoomFactor();
  if (zoomFactor === lastZoomFactor) {
    return;
  }
  lastZoomFactor = zoomFactor;
  publishZoomFactor(zoomFactor);
  for (const listener of zoomListeners) {
    listener(zoomFactor);
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function listServerChoices(): Promise<SandyDesktopServerChoice[]> {
  return sandyDesktopServerChoicesSchema.parse(
    await ipcRenderer.invoke(SANDY_DESKTOP_GET_SERVER_CHOICES_CHANNEL),
  );
}

function forwardParsed<T>(
  channel: string,
  schema: z.ZodType<T>,
  listeners: Set<(value: T) => void>,
): void {
  ipcRenderer.on(channel, (_event, payload: unknown) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of listeners) {
      listener(parsed.data);
    }
  });
}

function browserViewBoundsAtWindowScale(
  bounds: SandyDesktopBrowserViewBounds,
): SandyDesktopBrowserViewBounds {
  const zoomFactor = webFrame.getZoomFactor();
  if (zoomFactor === 1) {
    return bounds;
  }
  const x = Math.round(bounds.x * zoomFactor);
  const y = Math.round(bounds.y * zoomFactor);
  return {
    x,
    y,
    width: Math.max(0, Math.round((bounds.x + bounds.width) * zoomFactor) - x),
    height: Math.max(
      0,
      Math.round((bounds.y + bounds.height) * zoomFactor) - y,
    ),
  };
}

const sandyBrowserApi: SandyDesktopBrowserApi = {
  async getTarget() {
    return sandyDesktopBrowserTargetSchema
      .nullable()
      .parse(await ipcRenderer.invoke(SANDY_DESKTOP_BROWSER_TARGET_CHANNEL));
  },
  async getControl(tabId) {
    return sandyDesktopBrowserControlStateSchema.nullable().parse(
      await ipcRenderer.invoke(SANDY_DESKTOP_BROWSER_GET_CONTROL_CHANNEL, {
        tabId,
      }),
    );
  },
  releaseControl(tabId) {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL, { tabId });
  },
  onControl(listener) {
    return addListener(browserControlListeners, listener);
  },
  onReveal(listener) {
    return addListener(browserRevealListeners, listener);
  },
  async evaluate(request) {
    return sandyDesktopBrowserEvaluateResultSchema.parse(
      await ipcRenderer.invoke(SANDY_DESKTOP_BROWSER_EVALUATE_CHANNEL, request),
    );
  },
  onPageMessage(listener) {
    return addListener(browserPageMessageListeners, listener);
  },
  attach(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_ATTACH_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  detach(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_DETACH_CHANNEL, { tabId });
  },
  setThreadDiscarded(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL, request);
  },
  async listThreadIdsWithTabs() {
    return z
      .array(z.string().min(1))
      .parse(
        await ipcRenderer.invoke(
          SANDY_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
        ),
      );
  },
  navigate(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_NAVIGATE_CHANNEL, request);
  },
  goBack(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_GO_BACK_CHANNEL, { tabId });
  },
  goForward(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_GO_FORWARD_CHANNEL, { tabId });
  },
  reload(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_RELOAD_CHANNEL, { tabId });
  },
  stop(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_STOP_CHANNEL, { tabId });
  },
  focus(tabId): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_FOCUS_CHANNEL, { tabId });
  },
  setBounds(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  setVisible(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL, request);
  },
  setVisibleWithoutFocus(request): void {
    ipcRenderer.send(
      SANDY_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
      request,
    );
  },
  onState(listener): SandyDesktopBrowserUnsubscribe {
    const unsubscribe = addListener(browserStateListeners, listener);
    for (const state of browserStates.values()) listener(state);
    return unsubscribe;
  },
  onOpenTab(listener): SandyDesktopBrowserUnsubscribe {
    return addListener(browserOpenTabListeners, listener);
  },
  onScopedOpenTab(listener): SandyDesktopBrowserUnsubscribe {
    return addListener(browserScopedOpenTabListeners, listener);
  },
  onFocus(listener): SandyDesktopBrowserUnsubscribe {
    return addListener(browserFocusListeners, listener);
  },
  onSnapshot(listener): SandyDesktopBrowserUnsubscribe {
    return addListener(browserSnapshotListeners, listener);
  },
  findInPage(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL, request);
  },
  stopFindInPage(request): void {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL, request);
  },
  onFindResult(listener): SandyDesktopBrowserUnsubscribe {
    return addListener(browserFindResultListeners, listener);
  },
  async listImportSources() {
    const payload: unknown = await ipcRenderer.invoke(
      SANDY_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    );
    return z
      .object({ sources: z.array(desktopBrowserImportSourceSchema) })
      .parse(payload);
  },
  async importCookies(request) {
    const payload: unknown = await ipcRenderer.invoke(
      SANDY_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
      request,
    );
    return desktopBrowserImportOutcomeSchema.parse(payload);
  },
  openFullDiskAccessSettings() {
    ipcRenderer.send(SANDY_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL);
  },
};

const sandyDesktopApi: SandyDesktopApi = {
  browser: sandyBrowserApi,
  getServerChoices: listServerChoices,
  listServerChoices,
  onServerChoicesChange(listener) {
    return addListener(serverChoiceListeners, listener);
  },
  selectServer(id) {
    ipcRenderer.send(SANDY_DESKTOP_SELECT_SERVER_CHANNEL, id);
  },
  macosTrafficLightInset: MACOS_TRAFFIC_LIGHT_INSET_PX,
  macosTrafficLightTopInset: MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
  platform: resolveSandyDesktopPlatform(process.platform),
  get serverDaemonLogsAvailable() {
    return currentInfo.serverDaemonLogsAvailable;
  },
  version: currentInfo.version,
  getInfo() {
    return invokeDesktopInfo(SANDY_DESKTOP_GET_INFO_CHANNEL);
  },
  setAttentionThreads(threads) {
    ipcRenderer.send(SANDY_DESKTOP_SET_ATTENTION_THREADS_CHANNEL, threads);
  },
  focusWindow() {
    ipcRenderer.send(SANDY_DESKTOP_FOCUS_WINDOW_CHANNEL);
  },
  getWindowState() {
    return invokeDesktopWindowState();
  },
  onChange(listener: SandyDesktopInfoChangeHandler): SandyDesktopInfoUnsubscribe {
    return addListener(listeners, listener);
  },
  onWindowStateChange(
    listener: SandyDesktopWindowStateChangeHandler,
  ): SandyDesktopInfoUnsubscribe {
    return addListener(windowStateListeners, listener);
  },
  onZoomChange(listener): SandyDesktopInfoUnsubscribe {
    return addListener(zoomListeners, listener);
  },
  zoom(command): void {
    ipcRenderer.send(SANDY_DESKTOP_ZOOM_COMMAND_CHANNEL, command);
  },
  onOpenNewTab(listener): SandyDesktopInfoUnsubscribe {
    return addListener(openNewTabListeners, listener);
  },
  onAppCommand(listener): SandyDesktopInfoUnsubscribe {
    return addListener(appCommandListeners, listener);
  },
  onCloseWindowRequest(listener): SandyDesktopInfoUnsubscribe {
    return addListener(closeWindowRequestListeners, listener);
  },
  openWindowFind(request): void {
    ipcRenderer.send(SANDY_DESKTOP_OPEN_WINDOW_FIND_CHANNEL, {
      topOffset: Math.round(request.topOffset * webFrame.getZoomFactor()),
    } satisfies SandyDesktopWindowFindRequest);
  },
  async openDataDirectory(): Promise<void> {
    await ipcRenderer.invoke(SANDY_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL);
  },
  async openApplicationUrl(url: string): Promise<void> {
    await ipcRenderer.invoke(SANDY_DESKTOP_OPEN_APPLICATION_URL_CHANNEL, url);
  },
  openExternalUrl(url: string): void {
    ipcRenderer.send(SANDY_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL, url);
  },
  async openServerDaemonLogs(): Promise<void> {
    await ipcRenderer.invoke(SANDY_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL);
  },
  reloadWindow(): void {
    ipcRenderer.send(SANDY_DESKTOP_RELOAD_WINDOW_CHANNEL);
  },
  setSplitNavigationEnabled(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void {
    ipcRenderer.send(
      SANDY_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
      enabled,
      directionalCommands,
    );
  },
  setTheme(theme: SandyDesktopTheme): void {
    ipcRenderer.send(SANDY_DESKTOP_SET_THEME_CHANNEL, theme);
  },
  async writeClipboard(content: SandyDesktopClipboardContent): Promise<void> {
    await ipcRenderer.invoke(SANDY_DESKTOP_WRITE_CLIPBOARD_CHANNEL, content);
  },
};

forwardParsed(
  SANDY_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  sandyDesktopServerChoicesSchema,
  serverChoiceListeners,
);

ipcRenderer.on(SANDY_DESKTOP_INFO_CHANGED_CHANNEL, (_event, payload: unknown) => {
  applyDesktopInfoPayload(payload);
});

ipcRenderer.on(
  SANDY_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopWindowStatePayload(payload);
  },
);

ipcRenderer.on(SANDY_DESKTOP_OPEN_NEW_TAB_CHANNEL, () => {
  for (const listener of openNewTabListeners) {
    listener();
  }
});

forwardParsed(
  SANDY_DESKTOP_APP_COMMAND_CHANNEL,
  appCommandIdSchema,
  appCommandListeners,
);

ipcRenderer.on(SANDY_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL, () => {
  let handled = false;
  for (const listener of closeWindowRequestListeners) {
    handled = listener() || handled;
  }
  ipcRenderer.send(SANDY_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, handled);
});

forwardParsed(
  SANDY_DESKTOP_BROWSER_STATE_CHANNEL,
  sandyDesktopBrowserStateSchema,
  browserStateListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_CONTROL_CHANNEL,
  sandyDesktopBrowserControlStateSchema,
  browserControlListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_REVEAL_CHANNEL,
  sandyDesktopBrowserRevealRequestSchema,
  browserRevealListeners,
);

ipcRenderer.on(
  SANDY_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = sandyDesktopBrowserTabRefSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserFocusListeners) {
      listener(parsed.data.tabId);
    }
  },
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  sandyDesktopBrowserOpenTabRequestSchema,
  browserOpenTabListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  sandyDesktopBrowserScopedOpenTabRequestSchema,
  browserScopedOpenTabListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  sandyDesktopBrowserSnapshotSchema,
  browserSnapshotListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
  sandyDesktopBrowserPageMessageSchema,
  browserPageMessageListeners,
);

forwardParsed(
  SANDY_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  sandyDesktopBrowserFindResultSchema,
  browserFindResultListeners,
);

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("resize", notifyZoomChangeIfChanged);
  window.addEventListener("DOMContentLoaded", () => {
    publishZoomFactor(webFrame.getZoomFactor());
    for (const button of document.querySelectorAll<HTMLElement>(
      "[data-startup-action]",
    )) {
      button.addEventListener("click", () => {
        ipcRenderer.send(STARTUP_ACTION_CHANNEL, button.dataset.startupAction);
      });
    }
  });
}

void invokeDesktopInfo(SANDY_DESKTOP_GET_INFO_CHANNEL);
void invokeDesktopWindowState();

contextBridge.exposeInMainWorld("sandyDesktop", sandyDesktopApi);
