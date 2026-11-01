import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  defaultAppSettings,
  managedBranchPrefixSchema,
  MANAGED_BRANCH_PREFIX_MAX_LENGTH,
} from "../src/app-settings.js";

describe("managedBranchPrefixSchema", () => {
  it("accepts prefixes that start a valid branch name", () => {
    for (const prefix of ["sandy/", "", "sawyer/wt-", "team/sandy/", "wip_"]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(true);
    }
  });

  it("rejects prefixes that cannot start a valid branch name", () => {
    for (const prefix of [
      " sandy/",
      "sandy //",
      "-sandy/",
      "/sandy/",
      "sandy//",
      "sandy../",
      "sandy:",
      "sandy~",
      "sandy\\",
      "sandy@{",
      ".sandy/",
      "a".repeat(MANAGED_BRANCH_PREFIX_MAX_LENGTH + 1),
    ]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(false);
    }
  });

  it("defaults to the sandy namespace", () => {
    expect(defaultAppSettings.managedBranchPrefix).toBe("sandy/");
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(
      defaultAppSettings,
    );
  });
});
