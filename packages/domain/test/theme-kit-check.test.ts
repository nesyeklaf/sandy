import { describe, expect, it } from "vitest";
import { checkThemeCss, generateThemeCss } from "../src/index.js";

const generated = generateThemeCss({
  light: { canvas: "oklch(0.93 0.025 85)", ink: "oklch(0.3 0.03 65)", accent: "oklch(0.5 0.12 40)" },
  dark: { canvas: "oklch(0.26 0.004 260)", ink: "oklch(0.86 0.005 260)", accent: "oklch(0.76 0.09 40)" },
});

describe("checkThemeCss", () => {
  it("accepts what the generator writes", () => {
    expect(checkThemeCss(generated)).toEqual([]);
  });

  it("flags a text color that is too faint, with its mode and token", () => {
    const css = generated.replace(/(\.dark \{[\s\S]*?--ink: )oklch\([^)]*\)/, "$1oklch(0.4 0.005 260)");
    const issues = checkThemeCss(css);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", mode: "dark", token: "ink" }));
  });

  it("reports missing tokens and a missing block", () => {
    const missing = generated.replace(/\s+--pr-merged: [^;]+;/g, "");
    expect(checkThemeCss(missing).filter((issue) => issue.token === "pr-merged")).toHaveLength(2);
    const noDark = generated.slice(0, generated.indexOf(".dark {"));
    expect(checkThemeCss(noDark)).toContainEqual(expect.objectContaining({ severity: "error", token: ".dark" }));
  });

  it("warns about oklch mixing of a chromatic color into a grey canvas", () => {
    const css = generated.replace(
      /(\.dark \{[\s\S]*?--accent: )color-mix\(in oklab/,
      "$1color-mix(in oklch",
    );
    expect(checkThemeCss(css)).toContainEqual(
      expect.objectContaining({ severity: "warning", mode: "dark", token: "accent" }),
    );
  });

  it("warns about saturated status colors and a near-black canvas", () => {
    const css = generated
      .replace(/(\.dark \{[\s\S]*?--attention: )oklch\([^)]*\)/, "$1oklch(0.76 0.2 28)")
      .replace(/(\.dark \{[\s\S]*?--canvas: )oklch\([^)]*\)/, "$1oklch(0.12 0.004 260)");
    const issues = checkThemeCss(css);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "warning", token: "attention" }));
    expect(issues).toContainEqual(expect.objectContaining({ severity: "warning", token: "canvas", mode: "dark" }));
  });
});
