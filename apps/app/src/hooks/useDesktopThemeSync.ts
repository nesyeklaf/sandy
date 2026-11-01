import { useEffect } from "react";
import { getSandyDesktopInfo } from "@/lib/sandy-desktop";
import { useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  useEffect(() => {
    const desktopApi = getSandyDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);
}
