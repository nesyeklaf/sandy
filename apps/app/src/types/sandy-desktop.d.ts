import type { SandyDesktopApi } from "@sandy/desktop-contract";

declare global {
  interface Window {
    sandyDesktop?: SandyDesktopApi;
  }
}

export {};
