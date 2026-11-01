import { describe, expect, it } from "vitest";
import { parseBacklog } from "./backlog";

describe("parseBacklog", () => {
  it("turns lines into items and indented lines into details", () => {
    expect(
      parseBacklog("- Fix the flaky test\n  it fails on CI only\n\n2. Write docs\n* [ ] Ship it\n# Heading item"),
    ).toEqual([
      { title: "Fix the flaky test", details: "it fails on CI only" },
      { title: "Write docs", details: "" },
      { title: "Ship it", details: "" },
      { title: "Heading item", details: "" },
    ]);
  });

  it("skips checked boxes together with their details", () => {
    expect(parseBacklog("- [x] Done already\n  old note\n- Still open")).toEqual([
      { title: "Still open", details: "" },
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(parseBacklog("  \n\n")).toEqual([]);
  });
});
