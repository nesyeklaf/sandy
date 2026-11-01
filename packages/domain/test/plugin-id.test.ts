import { describe, expect, it } from "vitest";

import { derivePluginId } from "../src/plugin-id.js";

describe("derivePluginId", () => {
  it.each([
    ["sandy-plugin-hello", "hello"],
    ["@acme/sandy-plugin-hello", "hello"],
  ])("derives %s as %s", (packageName, expectedId) => {
    expect(derivePluginId(packageName)).toBe(expectedId);
  });
});
