import { describe, expect, it } from "vitest";
import { formatHomePathForDisplay } from "@sandy/shared-ui/lib/utils";

describe("formatHomePathForDisplay", () => {
  it.each([
    ["/Users/you", "~"],
    ["/Users/you/.sandy/plugins/github", "~/.sandy/plugins/github"],
    ["/home/u/.sandy/skills/review", "~/.sandy/skills/review"],
    ["/root/.sandy/automations/run.sh", "~/.sandy/automations/run.sh"],
    ["C:\\Users\\you\\.sandy\\plugins", "~\\.sandy\\plugins"],
  ])("compacts a conventional home path %s", (path, expected) => {
    expect(formatHomePathForDisplay(path)).toBe(expected);
  });

  it.each([
    "/managed/plugins/github",
    "/Volumes/work/plugins/github",
    "skills/example/writing-voice",
    "SKILL.md",
  ])("preserves a path outside a conventional home %s", (path) => {
    expect(formatHomePathForDisplay(path)).toBe(path);
  });
});
