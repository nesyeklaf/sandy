import { describe, expect, it, vi } from "vitest";
import { collectComposerCustomization } from "../internal/composer-customization-validation.js";

describe("composer menu registration", () => {
  it("keeps valid menus and reports bad triggers, missing callbacks and duplicate ids", () => {
    const items = () => [];
    const rejected = vi.fn();
    const registration = collectComposerCustomization(
      {
        id: "flows",
        experimental_menus: [
          { id: "flows", trigger: "!", label: "Flows", items },
          { id: "bad-trigger", trigger: "@", label: "Bad", items },
          { id: "no-items", trigger: "/", label: "Missing" },
          { id: "flows", trigger: "~", label: "Duplicate", items },
          { id: "slash", trigger: "/", label: "Slash", items },
        ],
      },
      new Set(),
      rejected,
    );
    expect(registration?.experimental_menus).toEqual([
      { id: "flows", trigger: "!", label: "Flows", items },
      { id: "slash", trigger: "/", label: "Slash", items },
    ]);
    expect(rejected.mock.calls.flat()).toEqual([
      expect.stringContaining('"trigger" must be one of'),
      expect.stringContaining("items"),
      expect.stringContaining('duplicate id "flows"'),
    ]);
  });
});
