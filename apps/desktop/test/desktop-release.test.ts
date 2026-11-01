import { describe, expect, it } from "vitest";
import { createDesktopReleaseInfo } from "../src/desktop-release.js";

describe("desktop release info", () => {
  it("gives the nightly channel its own name and icon", () => {
    expect(createDesktopReleaseInfo("latest")).toEqual({
      applicationName: "sandy",
      channel: "latest",
      iconFileName: "icon.png",
    });
    expect(createDesktopReleaseInfo("nightly")).toEqual({
      applicationName: "sandy Nightly",
      channel: "nightly",
      iconFileName: "icon-nightly.png",
    });
  });
});
