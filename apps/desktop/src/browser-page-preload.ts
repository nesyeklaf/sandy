import { contextBridge, ipcRenderer } from "electron";
import {
  SANDY_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL,
  SANDY_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  SANDY_DESKTOP_BROWSER_PAGE_WORLD_ID,
} from "./desktop-browser-ipc.js";

contextBridge.exposeInIsolatedWorld(
  SANDY_DESKTOP_BROWSER_PAGE_WORLD_ID,
  SANDY_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  {
    postMessage(channel: unknown, data: unknown): void {
      ipcRenderer.send(SANDY_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL, {
        channel,
        data,
      });
    },
  },
);
