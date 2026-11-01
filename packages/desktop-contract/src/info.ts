import type { SandyDesktopServerChoice } from "./servers.js";
import { z } from "zod";
import type { SandyDesktopBrowserApi } from "./browser.js";
import type { SandyDesktopWindowFindRequest } from "./find.js";
import type { AppCommandId } from "@sandy/domain";

export const sandyDesktopPlatformSchema = z.enum(["macos", "linux", "windows"]);
export type SandyDesktopPlatform = z.infer<typeof sandyDesktopPlatformSchema>;

export const sandyDesktopInfoSchema = z.object({
  platform: sandyDesktopPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  version: z.string().min(1),
});
export type SandyDesktopInfo = z.infer<typeof sandyDesktopInfoSchema>;

export const sandyDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
  })
  .strict();
export type SandyDesktopWindowState = z.infer<typeof sandyDesktopWindowStateSchema>;

export const sandyDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type SandyDesktopTheme = z.infer<typeof sandyDesktopThemeSchema>;

export const sandyDesktopClipboardContentSchema = z
  .object({
    text: z.string(),
    html: z.string().optional(),
  })
  .strict();
export type SandyDesktopClipboardContent = z.infer<
  typeof sandyDesktopClipboardContentSchema
>;

export const sandyDesktopZoomCommandSchema = z.enum(["in", "out", "reset"]);
export type SandyDesktopZoomCommand = z.infer<typeof sandyDesktopZoomCommandSchema>;
export const SANDY_DESKTOP_MIN_ZOOM_PERCENT = 50;
export const SANDY_DESKTOP_MAX_ZOOM_PERCENT = 300;

export type SandyDesktopInfoChangeHandler = (info: SandyDesktopInfo) => void;
export type SandyDesktopInfoUnsubscribe = () => void;
export type SandyDesktopWindowStateChangeHandler = (
  state: SandyDesktopWindowState,
) => void;
export type SandyDesktopZoomChangeHandler = (zoomFactor: number) => void;
export type SandyDesktopOpenNewTabHandler = () => void;
export type SandyDesktopAppCommandHandler = (command: AppCommandId) => void;
export type SandyDesktopCloseWindowRequestHandler = () => boolean;

export interface SandyDesktopAttentionThreads {
  pendingThreadIds: string[];
  unreadThreadIds: string[];
}

export interface SandyDesktopApi extends SandyDesktopInfo {
  browser: SandyDesktopBrowserApi;
  getServerChoices?(): Promise<SandyDesktopServerChoice[]>;
  listServerChoices?(): Promise<SandyDesktopServerChoice[]>;
  onServerChoicesChange?(
    listener: (choices: SandyDesktopServerChoice[]) => void,
  ): () => void;
  selectServer?(id: string): void;
  getInfo(): Promise<SandyDesktopInfo>;
  focusWindow?(): void;
  setAttentionThreads?(threads: SandyDesktopAttentionThreads): void;
  getWindowState?(): Promise<SandyDesktopWindowState>;
  macosTrafficLightInset?: number;
  macosTrafficLightTopInset?: number;
  onChange(listener: SandyDesktopInfoChangeHandler): SandyDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: SandyDesktopWindowStateChangeHandler,
  ): SandyDesktopInfoUnsubscribe;
  onZoomChange?(listener: SandyDesktopZoomChangeHandler): SandyDesktopInfoUnsubscribe;
  zoom?(command: SandyDesktopZoomCommand): void;
  onOpenNewTab?(listener: SandyDesktopOpenNewTabHandler): SandyDesktopInfoUnsubscribe;
  onAppCommand?(listener: SandyDesktopAppCommandHandler): SandyDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: SandyDesktopCloseWindowRequestHandler,
  ): SandyDesktopInfoUnsubscribe;
  openWindowFind?(request: SandyDesktopWindowFindRequest): void;
  openDataDirectory?(): Promise<void>;
  openExternalUrl(url: string): void;
  openApplicationUrl?(url: string): Promise<void>;
  openServerDaemonLogs?(): Promise<void>;
  reloadWindow?(): void;
  setSplitNavigationEnabled?(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void;
  setTheme(theme: SandyDesktopTheme): void;
  writeClipboard?(content: SandyDesktopClipboardContent): Promise<void>;
}
