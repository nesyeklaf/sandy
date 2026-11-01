import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  generateThemeCss,
  parseColor,
  THEME_KIT_TEXT_CONTRAST,
  ThemeKitError,
  type ThemeKitInput,
} from "../src/index.js";

const input: ThemeKitInput = {
  light: {
    canvas: "oklch(0.93 0.025 85)",
    ink: "oklch(0.3 0.03 65)",
    accent: "oklch(0.5 0.12 40)",
  },
  dark: {
    canvas: "oklch(0.26 0.004 260)",
    ink: "oklch(0.86 0.005 260)",
    accent: "oklch(0.76 0.09 40)",
  },
};

function tokens(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector + " {");
  const end = css.indexOf("}", start);
  const map = new Map<string, string>();
  for (const line of css.slice(start, end).split("\n")) {
    const match = /^\s+--([a-z0-9-]+): (.+);$/.exec(line);
    if (match) map.set(match[1]!, match[2]!);
  }
  return map;
}

describe("generateThemeCss", () => {
  const css = generateThemeCss(input);
  const light = tokens(css, ":root, .light");
  const dark = tokens(css, ".dark");

  it("writes both mode blocks with the anchors the caller gave", () => {
    expect(light.get("canvas")).toBe("oklch(0.93 0.025 85)");
    expect(dark.get("canvas")).toBe("oklch(0.26 0.004 260)");
    expect(dark.get("ink")).toBe("oklch(0.86 0.005 260)");
  });

  it("derives selection tokens in oklab so a grey canvas keeps the accent hue", () => {
    for (const token of ["accent", "sidebar-accent", "surface-selected", "state-hover", "state-active"]) {
      expect(dark.get(token)).toMatch(/^color-mix\(in oklab, var\(--primary\)/);
      expect(light.get(token)).not.toContain("in oklch");
    }
  });

  it("keeps every status color readable on the canvas", () => {
    for (const [block, canvasToken] of [[light, "canvas"], [dark, "canvas"]] as const) {
      const canvas = parseColor(block.get(canvasToken)!)!;
      for (const token of ["primary", "destructive-text", "attention", "warning", "success", "diff-added", "diff-removed", "pr-merged"]) {
        const color = parseColor(block.get(token)!)!;
        expect(contrastRatio(color, canvas), token).toBeGreaterThanOrEqual(THEME_KIT_TEXT_CONTRAST);
      }
    }
  });

  it("keeps status colors soft", () => {
    for (const token of ["attention", "success", "diff-added", "pr-merged"]) {
      expect(parseColor(dark.get(token)!)!.c).toBeLessThanOrEqual(0.09);
    }
  });

  it("emits a full ANSI palette with a readable foreground for each", () => {
    for (let index = 0; index < 16; index += 1) {
      expect(dark.get("ansi-" + index)).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark.get("ansi-bg-fg-" + index)).toMatch(/^#(000000|ffffff)$/);
    }
  });

  it("adds fonts only to the shared block", () => {
    const withFonts = generateThemeCss({ ...input, fonts: { mono: "'Fira Code', monospace" } });
    expect(tokens(withFonts, ":root, .light").get("font-mono")).toBe("'Fira Code', monospace");
    expect(tokens(withFonts, ".dark").has("font-mono")).toBe(false);
  });

  it("rejects colors it cannot read and chroma beyond the cap", () => {
    expect(() => generateThemeCss({ ...input, dark: { ...input.dark, canvas: "tomato" } })).toThrow(ThemeKitError);
    expect(() => generateThemeCss({ ...input, statusChroma: 0.4 })).toThrow(ThemeKitError);
  });

  it("nudges an accent that is too close to the canvas until it reads", () => {
    const weak = generateThemeCss({ ...input, dark: { ...input.dark, accent: "oklch(0.35 0.09 40)" } });
    const canvas = parseColor("oklch(0.26 0.004 260)")!;
    const primary = parseColor(tokens(weak, ".dark").get("primary")!)!;
    expect(contrastRatio(primary, canvas)).toBeGreaterThanOrEqual(THEME_KIT_TEXT_CONTRAST);
  });
});
