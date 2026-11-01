import { z } from "zod";
import {
  contrastRatio,
  formatHex,
  formatOklch,
  mixOklab,
  parseColor,
  type Oklch,
} from "./color.js";

const themeKitFontSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^;{}\\\n]+$/, "Font stacks cannot contain ; { } or newlines");
const themeKitColorSchema = z.string().min(1).max(64);
const themeKitModeInputSchema = z.object({
  canvas: themeKitColorSchema,
  ink: themeKitColorSchema,
  accent: themeKitColorSchema,
});

export const themeKitInputSchema = z.object({
  light: themeKitModeInputSchema,
  dark: themeKitModeInputSchema,
  statusChroma: z.number().min(0).max(0.16).optional(),
  fonts: z
    .object({
      sans: themeKitFontSchema.optional(),
      mono: themeKitFontSchema.optional(),
      terminal: themeKitFontSchema.optional(),
    })
    .optional(),
});

export type ThemeKitModeInput = z.infer<typeof themeKitModeInputSchema>;
export type ThemeKitInput = z.infer<typeof themeKitInputSchema>;

export const THEME_KIT_DEFAULT_STATUS_CHROMA = 0.085;
export const THEME_KIT_MAX_STATUS_CHROMA = 0.16;
export const THEME_KIT_TEXT_CONTRAST = 4.5;

const TEXT_TARGET = 4.7;

const STATUS_HUES = {
  destructive: 22,
  attention: 28,
  warning: 80,
  success: 145,
  diffAdded: 150,
  diffRemoved: 25,
  merged: 315,
  discord: 275,
} as const;

const ANSI_HUES: readonly (readonly [number, number])[] = [
  [1, 25],
  [2, 145],
  [3, 90],
  [4, 245],
  [5, 325],
  [6, 205],
];

export class ThemeKitError extends Error {}

function parseInput(label: string, value: string): Oklch {
  const color = parseColor(value);
  if (color === null) {
    throw new ThemeKitError(
      `${label}: '${value}' is not a color. Use oklch(L C H) or #rrggbb.`,
    );
  }
  return color;
}

function tuneAgainst(
  color: Oklch,
  background: Oklch,
  target: number,
  other?: Oklch,
): Oklch {
  const reference = other ?? background;
  const awayDirection = background.l < 0.5 ? 1 : -1;
  const step = 0.005;
  let candidate = { ...color };
  for (let guard = 0; guard < 200; guard += 1) {
    if (
      contrastRatio(candidate, reference) >= target &&
      contrastRatio(candidate, background) >= target
    ) {
      return candidate;
    }
    const next = candidate.l + awayDirection * step;
    if (next < 0.04 || next > 0.98) break;
    candidate = { ...candidate, l: next };
  }
  return candidate;
}

function tuneTowardDark(
  color: Oklch,
  foreground: Oklch,
  target: number,
): Oklch {
  let candidate = { ...color };
  for (let guard = 0; guard < 200; guard += 1) {
    if (contrastRatio(foreground, candidate) >= target) return candidate;
    candidate = { ...candidate, l: candidate.l - 0.005 };
    if (candidate.l < 0.04) break;
  }
  return candidate;
}

function textMixPercent(
  ink: Oklch,
  canvas: Oklch,
  start: number,
): number {
  let percent = start;
  while (percent < 100) {
    if (contrastRatio(mixOklab(ink, canvas, percent / 100), canvas) >= TEXT_TARGET) {
      return percent;
    }
    percent += 2;
  }
  return 100;
}

function neutral(canvas: Oklch, lightness: number, chroma: number): Oklch {
  return { l: lightness, c: chroma, h: canvas.h };
}

function modeEntries(
  mode: "light" | "dark",
  input: ThemeKitModeInput,
  statusChroma: number,
): [string, string][] {
  const dark = mode === "dark";
  const canvas = parseInput(`${mode}.canvas`, input.canvas);
  const ink = parseInput(`${mode}.ink`, input.ink);
  const accent = tuneAgainst(
    parseInput(`${mode}.accent`, input.accent),
    canvas,
    TEXT_TARGET,
  );
  const primaryForeground =
    contrastRatio(canvas, accent) >= contrastRatio(ink, accent) ? canvas : ink;
  const status = (hue: number, lightness = dark ? 0.76 : 0.5): Oklch =>
    tuneAgainst({ l: lightness, c: statusChroma, h: hue }, canvas, TEXT_TARGET);
  const entries: [string, string][] = [];
  const set = (token: string, value: string | Oklch) =>
    entries.push([token, typeof value === "string" ? value : formatOklch(value)]);

  const muted = textMixPercent(ink, canvas, 72);
  const subtle = textMixPercent(ink, canvas, 62);
  const readback = textMixPercent(ink, canvas, 66);

  set("canvas", canvas);
  set("ink", ink);
  set("primary", accent);
  set("primary-foreground", primaryForeground);
  set("muted-foreground", `color-mix(in oklab, var(--ink) ${muted}%, var(--canvas))`);
  set("subtle-foreground", `color-mix(in oklab, var(--ink) ${subtle}%, var(--canvas))`);
  set("readback-foreground", `color-mix(in oklab, var(--ink) ${readback}%, var(--canvas))`);
  set("timeline-accent", "var(--primary)");
  set("file-accent", "var(--timeline-accent)");

  const white: Oklch = { l: 0.985, c: 0.008, h: canvas.h };
  const destructive = tuneTowardDark(
    { l: 0.55, c: Math.min(statusChroma * 1.4, THEME_KIT_MAX_STATUS_CHROMA), h: STATUS_HUES.destructive },
    white,
    TEXT_TARGET,
  );
  set("destructive", destructive);
  set("destructive-foreground", white);
  set("destructive-text", status(STATUS_HUES.destructive));
  set("attention", status(STATUS_HUES.attention));
  set("attention-foreground", "var(--canvas)");
  set("warning", status(STATUS_HUES.warning, dark ? 0.8 : 0.52));
  set("warning-text", "var(--warning)");
  set("success", status(STATUS_HUES.success));
  set("success-foreground", "var(--success)");
  set("diff-added", status(STATUS_HUES.diffAdded));
  set("diff-removed", status(STATUS_HUES.diffRemoved));
  set("pr-merged", status(STATUS_HUES.merged));
  set("brand-discord", status(STATUS_HUES.discord));

  const mix = dark
    ? { accent: 16, sidebar: 18, selected: 18, hover: 12, active: 20 }
    : { accent: 10, sidebar: 12, selected: 14, hover: 9, active: 16 };
  set("accent", `color-mix(in oklab, var(--primary) ${mix.accent}%, var(--canvas))`);
  set("sidebar-accent", `color-mix(in oklab, var(--primary) ${mix.sidebar}%, var(--canvas))`);
  set("surface-selected", `color-mix(in oklab, var(--primary) ${mix.selected}%, transparent)`);
  set("state-hover", `color-mix(in oklab, var(--primary) ${mix.hover}%, transparent)`);
  set("state-active", `color-mix(in oklab, var(--primary) ${mix.active}%, transparent)`);
  const shadow = formatOklch(neutral(canvas, dark ? 0.15 : 0.3, dark ? 0.01 : 0.02));
  set(
    "pill-shadow",
    `0 1px 1px 0 ${shadow.replace(")", dark ? " / 0.08)" : " / 0.03)")}`,
  );

  const normalLightness = dark ? 0.74 : 0.45;
  const brightLightness = dark ? 0.8 : 0.52;
  const ansi: Oklch[] = new Array<Oklch>(16);
  ansi[0] = neutral(canvas, dark ? 0.55 : 0.3, 0.01);
  ansi[7] = neutral(canvas, dark ? 0.9 : 0.4, 0.012);
  ansi[8] = neutral(canvas, dark ? 0.62 : 0.38, 0.01);
  ansi[15] = neutral(canvas, dark ? 0.95 : 0.25, 0.01);
  for (const [index, hue] of ANSI_HUES) {
    ansi[index] = status(hue, normalLightness);
    ansi[index + 8] = status(hue, brightLightness);
  }
  const black: Oklch = { l: 0, c: 0, h: 0 };
  const whiteText: Oklch = { l: 1, c: 0, h: 0 };
  ansi.forEach((color, index) => {
    set(`ansi-${index}`, formatHex(color));
  });
  ansi.forEach((color, index) => {
    set(
      `ansi-bg-fg-${index}`,
      contrastRatio(black, color) >= contrastRatio(whiteText, color)
        ? "#000000"
        : "#ffffff",
    );
  });
  return entries;
}

function block(selector: string, entries: readonly (readonly [string, string])[]): string {
  const body = entries.map(([token, value]) => `  --${token}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}\n`;
}

export function generateThemeCss(input: ThemeKitInput): string {
  const statusChroma = input.statusChroma ?? THEME_KIT_DEFAULT_STATUS_CHROMA;
  if (
    !Number.isFinite(statusChroma) ||
    statusChroma < 0 ||
    statusChroma > THEME_KIT_MAX_STATUS_CHROMA
  ) {
    throw new ThemeKitError(
      `statusChroma must be between 0 and ${THEME_KIT_MAX_STATUS_CHROMA}.`,
    );
  }
  const light = modeEntries("light", input.light, statusChroma);
  const dark = modeEntries("dark", input.dark, statusChroma);
  const fonts: [string, string][] = [];
  if (input.fonts?.sans) fonts.push(["font-sans", input.fonts.sans]);
  if (input.fonts?.mono) fonts.push(["font-mono", input.fonts.mono]);
  if (input.fonts?.terminal) fonts.push(["font-terminal", input.fonts.terminal]);
  return block(":root, .light", [...light, ...fonts]) + block(".dark", dark);
}
