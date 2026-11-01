const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "SANDY_DESKTOP_RELEASE_CHANNEL";

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux, and win32 only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.sandy.desktop.nightly",
      applicationName: "sandy Nightly",
      artifactName: "sandy-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "sandy-nightly",
      macIconPath: "assets/icon-nightly.icns",
      windowsInstallName: "sandy-nightly",
    };
  }

  return {
    appId: "dev.sandy.desktop",
    applicationName: "sandy",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxExecutableName: "sandy",
    macIconPath: "assets/icon.icns",
    windowsInstallName: "sandy",
  };
}
