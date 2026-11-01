import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getSandyDesktopInfo } from "@/lib/sandy-desktop";

export function useDataDirectoryCommand(): void {
  const desktopApi = getSandyDesktopInfo();
  const openDataDirectory = desktopApi?.openDataDirectory;

  useAppCommandHandler(
    "dataDirectory.open",
    () => {
      if (openDataDirectory === undefined) {
        return false;
      }
      void openDataDirectory.call(desktopApi).catch(() => undefined);
      return true;
    },
    0,
    openDataDirectory !== undefined,
  );
}
