import { describe, expect, it } from "vitest";
import {
  RETIRED_PLUGIN_SUCCESSORS,
  pathWithRetiredPluginIdsReplaced,
} from "../src/plugin-id.js";

describe("pathWithRetiredPluginIdsReplaced", () => {
  it.each([
    [
      "/settings/plugins/sandy--provider-acp-next",
      "/settings/plugins/provider-acp",
    ],
    ["/plugins/sandy--provider-acp-next", "/plugins/provider-acp"],
    [
      "/extensions/plugins/sandy--provider-acp-next/settings",
      "/extensions/plugins/provider-acp/settings",
    ],
  ])("rewrites %s", (pathname, expected) => {
    expect(pathWithRetiredPluginIdsReplaced(pathname)).toBe(expected);
  });

  it.each([
    "/settings/plugins/provider-acp",
    "/settings/plugins/sandy--provider-acp-next-extra",
    "/threads/sandy",
    "/settings/plugins/constructor",
  ])("leaves %s alone", (pathname) => {
    expect(pathWithRetiredPluginIdsReplaced(pathname)).toBeNull();
  });

  it("maps every retired plugin to a different plugin", () => {
    for (const [retired, successor] of Object.entries(
      RETIRED_PLUGIN_SUCCESSORS,
    )) {
      expect(successor).not.toBe(retired);
      expect(Object.hasOwn(RETIRED_PLUGIN_SUCCESSORS, successor)).toBe(false);
    }
  });
});
