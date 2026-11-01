export type DesktopReleaseChannel = "latest" | "nightly";
export type DesktopBuildPlatform = "macos" | "linux" | "windows";

export interface DesktopReleaseConfig {
  appId: "dev.sandy.desktop" | "dev.sandy.desktop.nightly";
  applicationName: "sandy" | "sandy Nightly";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "sandy" | "sandy-nightly";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  windowsInstallName: "sandy" | "sandy-nightly";
}

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;
