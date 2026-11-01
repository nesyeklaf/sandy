import { useEffect, useState } from "react";
import type { SandyDesktopWindowState } from "@sandy/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getSandyDesktopInfo,
} from "@/lib/sandy-desktop";

export function useDesktopWindowState(): SandyDesktopWindowState {
  const [windowState, setWindowState] = useState<SandyDesktopWindowState>(
    DEFAULT_DESKTOP_WINDOW_STATE,
  );

  useEffect(() => {
    const desktopApi = getSandyDesktopInfo();
    let cancelled = false;

    const unsubscribe = desktopApi?.onWindowStateChange?.((nextState) => {
      setWindowState(nextState);
    });

    void desktopApi?.getWindowState?.().then((nextState) => {
      if (!cancelled) {
        setWindowState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return windowState;
}
