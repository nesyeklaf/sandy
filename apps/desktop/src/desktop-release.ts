type DesktopReleaseChannel = "latest" | "nightly";

interface DesktopReleaseInfo {
  applicationName: "sandy" | "sandy Nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  const nightly = channel === "nightly";

  return {
    applicationName: nightly ? "sandy Nightly" : "sandy",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest or nightly, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.SANDY_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);
