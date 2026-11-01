import { describe, expect, it } from "vitest";
import { resolveSandyDesktopPlatform } from "../src/desktop-platform.js";

describe("resolveSandyDesktopPlatform", () => {
  it("names each supported desktop platform", () => {
    expect(resolveSandyDesktopPlatform("darwin")).toBe("macos");
    expect(resolveSandyDesktopPlatform("linux")).toBe("linux");
    expect(resolveSandyDesktopPlatform("win32")).toBe("windows");
  });
});
