import { describe, expect, it } from "vitest";
import { sandyDesktopInfoSchema } from "../src/info.js";

const baseInfo = {
  platform: "macos",
  version: "0.0.31",
} as const;

describe("sandyDesktopInfoSchema", () => {
  it("accepts a shell payload", () => {
    expect(sandyDesktopInfoSchema.safeParse(baseInfo).success).toBe(true);
  });

  it("accepts linux", () => {
    expect(
      sandyDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "linux",
      }).success,
    ).toBe(true);
  });

  it("rejects win32", () => {
    expect(
      sandyDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "win32",
      }).success,
    ).toBe(false);
  });
});
