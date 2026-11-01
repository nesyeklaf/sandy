import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getSandyDesktopInfo } from "@/lib/sandy-desktop";

export function useWindowReloadCommand(): void {
  const desktopApi = getSandyDesktopInfo();
  const reloadWindow = desktopApi?.reloadWindow;

  useAppCommandHandler(
    "window.reload",
    () => {
      if (reloadWindow === undefined) {
        return false;
      }
      reloadWindow.call(desktopApi);
      return true;
    },
    0,
    reloadWindow !== undefined,
  );
}
