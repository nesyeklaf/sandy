import { useEffect, type ReactNode } from "react";
import type {
  SandyDesktopApi,
  SandyDesktopBrowserApi,
  SandyDesktopBrowserState,
  SandyDesktopInfo,
} from "@sandy/desktop-contract";

const STORY_DESKTOP_INFO: SandyDesktopInfo = {
  platform: "macos",
  version: "0.0.0-story",
};

function createStoryDesktopBrowserApi(
  initialState: SandyDesktopBrowserState | null,
): SandyDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    setBounds() {},
    setVisible() {},
    onState(listener) {
      let subscribed = true;
      if (initialState !== null) {
        queueMicrotask(() => {
          if (subscribed) listener(initialState);
        });
      }
      return () => {
        subscribed = false;
      };
    },
    onOpenTab() {
      return () => {};
    },
  };
}

function createStoryDesktopApi(
  browserState: SandyDesktopBrowserState | null,
): SandyDesktopApi {
  return {
    ...STORY_DESKTOP_INFO,
    browser: createStoryDesktopBrowserApi(browserState),
    async getInfo() {
      return STORY_DESKTOP_INFO;
    },
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}

interface WithDesktopBrowserProps {
  browserState?: SandyDesktopBrowserState | null;
  children: ReactNode;
}

export function WithDesktopBrowser({
  browserState = null,
  children,
}: WithDesktopBrowserProps) {
  if (typeof window !== "undefined" && window.sandyDesktop === undefined) {
    window.sandyDesktop = createStoryDesktopApi(browserState);
  }
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        delete window.sandyDesktop;
      }
    };
  }, []);
  return <>{children}</>;
}
