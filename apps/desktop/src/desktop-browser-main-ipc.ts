import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import type { z } from "zod";
import {
  sandyDesktopBrowserAttachRequestSchema,
  sandyDesktopBrowserEvaluateRequestSchema,
  sandyDesktopBrowserFindInPageRequestSchema,
  sandyDesktopBrowserNavigateRequestSchema,
  sandyDesktopBrowserSetBoundsRequestSchema,
  sandyDesktopBrowserSetThreadDiscardedRequestSchema,
  sandyDesktopBrowserSetVisibleRequestSchema,
  sandyDesktopBrowserStopFindInPageRequestSchema,
  sandyDesktopBrowserTabRefSchema,
  type SandyDesktopBrowserEvaluateResult,
} from "@sandy/desktop-contract";
import {
  SANDY_DESKTOP_BROWSER_ATTACH_CHANNEL,
  SANDY_DESKTOP_BROWSER_DETACH_CHANNEL,
  SANDY_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  SANDY_DESKTOP_BROWSER_FOCUS_CHANNEL,
  SANDY_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  SANDY_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  SANDY_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  SANDY_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  SANDY_DESKTOP_BROWSER_RELOAD_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  SANDY_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  SANDY_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  SANDY_DESKTOP_BROWSER_STOP_CHANNEL,
  SANDY_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import type { DesktopBrowserViewManager } from "./desktop-browser-view.js";

function hostWindowFromBrowserIpcEvent(
  event: IpcMainEvent,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerRequestCommand<T>(
  channel: string,
  schema: z.ZodType<T>,
  run: (args: { hostWindow: BrowserWindow; request: T }) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    const hostWindow = hostWindowFromBrowserIpcEvent(event);
    if (hostWindow === null) {
      return;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    run({ hostWindow, request: parsed.data });
  });
}

export function registerDesktopBrowserIpc(
  manager: DesktopBrowserViewManager,
): void {
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_ATTACH_CHANNEL,
    sandyDesktopBrowserAttachRequestSchema,
    (args) => manager.attach(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
    sandyDesktopBrowserNavigateRequestSchema,
    (args) => manager.navigate(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
    sandyDesktopBrowserSetBoundsRequestSchema,
    (args) => manager.setBounds(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
    sandyDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisible(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
    sandyDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisibleWithoutFocus(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
    sandyDesktopBrowserFindInPageRequestSchema,
    (args) => manager.findInPage(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
    sandyDesktopBrowserStopFindInPageRequestSchema,
    (args) => manager.stopFindInPage(args),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_DETACH_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.detach({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
    sandyDesktopBrowserSetThreadDiscardedRequestSchema,
    (args) => manager.setThreadDiscarded(args),
  );
  ipcMain.handle(SANDY_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL, (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === null) return [];
    const tabs = manager.listTabs({
      hostWebContentsId: event.sender.id,
      threadId: null,
    });
    return [...new Set(tabs.map((tab) => tab.threadId))];
  });
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_FOCUS_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.focus({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_GO_BACK_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goBack({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goForward({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_RELOAD_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.reload({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    SANDY_DESKTOP_BROWSER_STOP_CHANNEL,
    sandyDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.stop({ hostWindow, tabId: request.tabId }),
  );
  ipcMain.handle(
    SANDY_DESKTOP_BROWSER_EVALUATE_CHANNEL,
    async (
      event,
      payload: unknown,
    ): Promise<SandyDesktopBrowserEvaluateResult> => {
      const hostWindow = BrowserWindow.fromWebContents(event.sender);
      if (hostWindow === null) {
        return { ok: false, error: "Browser host window is not available" };
      }
      const parsed = sandyDesktopBrowserEvaluateRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: "Invalid browser page evaluation request" };
      }
      return manager.evaluate({ hostWindow, request: parsed.data });
    },
  );
}
