import { describe, expect, it } from "vitest";
import { MONOGRAM_COLOR_COUNT, projectMonogramColor, projectMonogramLetter } from "./project-monogram";

describe("projectMonogramLetter", () => {
  it.each([
    ["sandy-sidebar", "S"],
    ["sandy-plugin-tasks", "T"],
    ["the-app", "A"],
    ["@acme/widgets", "W"],
    ["org/repo-name", "R"],
    ["myProject", "P"],
    ["Sidebar", "S"],
    ["sandy", "S"],
    ["2fa-server", "2"],
    ["ölçüm", "Ö"],
    ["  ", "#"],
    ["---", "#"],
  ])("%j → %s", (name, letter) => {
    expect(projectMonogramLetter(name)).toBe(letter);
  });
});

describe("projectMonogramColor", () => {
  it("is stable for a name, ignoring case and outer spaces", () => {
    expect(projectMonogramColor("sandy-sidebar")).toBe(projectMonogramColor(" SANDY-Sidebar "));
  });

  it("stays inside the palette and spreads similar names", () => {
    const colors = new Set(Array.from({ length: 40 }, (_, index) => projectMonogramColor(`project-${index}`)));
    for (const color of colors) {
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThan(MONOGRAM_COLOR_COUNT);
    }
    expect(colors.size).toBeGreaterThan(MONOGRAM_COLOR_COUNT / 2);
  });
});
