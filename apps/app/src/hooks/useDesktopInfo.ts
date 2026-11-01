import { useEffect, useState } from "react";
import type { SandyDesktopApi, SandyDesktopInfo } from "@sandy/desktop-contract";
import { getSandyDesktopInfo } from "@/lib/sandy-desktop";

interface DesktopInfo {
  desktopApi: SandyDesktopApi | null;
  desktopInfo: SandyDesktopInfo | null;
  isDesktop: boolean;
}

export function useDesktopInfo(): DesktopInfo {
  const [desktopApi] = useState<SandyDesktopApi | null>(() => getSandyDesktopInfo());
  const [desktopInfo, setDesktopInfo] = useState<SandyDesktopInfo | null>(null);

  useEffect(() => {
    const api = getSandyDesktopInfo();
    if (api === null) {
      return;
    }

    let mounted = true;
    void api
      .getInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onChange((info) => {
      setDesktopInfo(info);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { desktopApi, desktopInfo, isDesktop: desktopApi !== null };
}
