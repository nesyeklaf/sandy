import { describe, expect, it } from "vitest";
import {
  canonicalSkillSelection,
  isSkillNameEnabled,
  setSkillNamesEnabled,
  skillSelectionKey,
  skillSelectionSchema,
  type SkillSelection,
} from "../src/skill-selection.js";

describe("skillSelectionSchema", () => {
  it.each([
    [{ mode: "inherit" }],
    [{ mode: "disable", names: ["review"] }],
    [{ mode: "allow-only", names: [] }],
  ])("accepts %j", (value) => {
    expect(skillSelectionSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [{ mode: "all" }],
    [{ mode: "inherit", names: ["review"] }],
    [{ mode: "disable" }],
    [{ mode: "disable", names: ["review", "review"] }],
    [{ mode: "allow-only", names: [""] }],
    [{ mode: "disable", names: ["review"], allow: ["other"] }],
  ])("rejects %j", (value) => {
    expect(skillSelectionSchema.safeParse(value).success).toBe(false);
  });
});

describe("isSkillNameEnabled", () => {
  it("keeps every name under inherit", () => {
    expect(isSkillNameEnabled({ mode: "inherit" }, "anything")).toBe(true);
  });

  it("turns off only listed names under disable", () => {
    const selection = { mode: "disable" as const, names: ["review"] };
    expect(isSkillNameEnabled(selection, "review")).toBe(false);
    expect(isSkillNameEnabled(selection, "deploy")).toBe(true);
  });

  it("keeps a newly discovered name off under allow-only", () => {
    const selection = { mode: "allow-only" as const, names: ["review"] };
    expect(isSkillNameEnabled(selection, "review")).toBe(true);
    expect(isSkillNameEnabled(selection, "brand-new-skill")).toBe(false);
  });
});

describe("skillSelectionKey", () => {
  it("ignores name order", () => {
    expect(
      skillSelectionKey({ mode: "disable", names: ["b", "a"] }),
    ).toBe(skillSelectionKey({ mode: "disable", names: ["a", "b"] }));
    expect(canonicalSkillSelection({ mode: "allow-only", names: ["b", "a"] }))
      .toEqual({ mode: "allow-only", names: ["a", "b"] });
  });

  it("distinguishes disable from allow-only with the same names", () => {
    expect(skillSelectionKey({ mode: "disable", names: ["a"] })).not.toBe(
      skillSelectionKey({ mode: "allow-only", names: ["a"] }),
    );
  });
});

describe("setSkillNamesEnabled", () => {
  it("turns a name off under inherit by starting a disable list", () => {
    expect(
      setSkillNamesEnabled({ mode: "inherit" }, ["review"], false),
    ).toEqual({ mode: "disable", names: ["review"] });
    expect(setSkillNamesEnabled({ mode: "inherit" }, ["review"], true)).toEqual({
      mode: "inherit",
    });
  });

  it("adds to and removes from a disable list", () => {
    const off = setSkillNamesEnabled(
      { mode: "disable", names: ["pdf"] },
      ["review", "pdf"],
      false,
    );
    expect(off).toEqual({ mode: "disable", names: ["pdf", "review"] });
    expect(setSkillNamesEnabled(off, ["pdf"], true)).toEqual({
      mode: "disable",
      names: ["review"],
    });
  });

  it("adds to and removes from an allow-only list", () => {
    const on = setSkillNamesEnabled(
      { mode: "allow-only", names: [] },
      ["review"],
      true,
    );
    expect(on).toEqual({ mode: "allow-only", names: ["review"] });
    expect(setSkillNamesEnabled(on, ["review"], false)).toEqual({
      mode: "allow-only",
      names: [],
    });
  });

  it("matches isSkillNameEnabled after every toggle", () => {
    const starts: SkillSelection[] = [
      { mode: "inherit" },
      { mode: "disable", names: ["a"] },
      { mode: "allow-only", names: ["a"] },
    ];
    for (const start of starts) {
      for (const enabled of [true, false]) {
        const next = setSkillNamesEnabled(start, ["a", "b"], enabled);
        expect(isSkillNameEnabled(next, "a")).toBe(enabled);
        expect(isSkillNameEnabled(next, "b")).toBe(enabled);
      }
    }
  });
});
