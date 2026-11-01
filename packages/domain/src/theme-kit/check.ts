import {
  contrastRatio,
  mixOklab,
  mixOklch,
  parseColor,
  type Oklch,
} from "./color.js";
import { THEME_KIT_TEXT_CONTRAST } from "./generate.js";

export type ThemeIssueSeverity = "error" | "warning";

export interface ThemeIssue {
  severity: ThemeIssueSeverity;
  mode: "light" | "dark" | "both";
  token: string;
  message: string;
}

export const THEME_REQUIRED_TOKENS = [
  "canvas",
  "ink",
  "primary",
  "primary-foreground",
  "muted-foreground",
  "subtle-foreground",
  "readback-foreground",
  "destructive",
  "destructive-text",
  "warning-text",
  "attention",
  "success-foreground",
  "diff-added",
  "diff-removed",
  "pr-merged",
] as const;

const TEXT_ON_CANVAS = [
  "ink",
  "muted-foreground",
  "subtle-foreground",
  "readback-foreground",
  "primary",
  "destructive-text",
  "warning-text",
  "attention",
  "success-foreground",
  "diff-added",
  "diff-removed",
  "pr-merged",
] as const;

const STATUS_TOKENS = [
  "attention",
  "success-foreground",
  "diff-added",
  "diff-removed",
  "pr-merged",
  "warning-text",
  "destructive-text",
] as const;

const MAX_COMFORT_CHROMA = 0.12;
const MIN_DARK_CANVAS_LIGHTNESS = 0.2;
const MAX_LIGHT_CANVAS_LIGHTNESS = 0.97;
const ACHROMATIC_CHROMA = 0.02;
const CHROMATIC_CHROMA = 0.04;

type Tokens = Map<string, string>;

function extractBlock(css: string, selector: RegExp): string | null {
  const match = selector.exec(css);
  if (!match) return null;
  const open = css.indexOf("{", match.index);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return null;
}

function readTokens(body: string): Tokens {
  const tokens: Tokens = new Map();
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

function resolveColor(value: string, tokens: Tokens, depth = 0): Oklch | null {
  if (depth > 8) return null;
  const text = value.trim();
  const variable = /^var\(--([a-z0-9-]+)\)$/i.exec(text);
  if (variable) {
    const target = tokens.get(variable[1]!);
    return target === undefined ? null : resolveColor(target, tokens, depth + 1);
  }
  const mix = /^color-mix\(\s*in\s+(oklab|oklch)\s*,(.*)\)$/is.exec(text);
  if (mix) {
    const [first, second] = splitArguments(mix[2]!);
    if (first === undefined || second === undefined) return null;
    const weight = /\s([\d.]+)%$/.exec(first);
    const left = resolveColor(first.replace(/\s[\d.]+%$/, ""), tokens, depth + 1);
    const right = resolveColor(second.replace(/\s[\d.]+%$/, ""), tokens, depth + 1);
    if (!left || !right) return null;
    const share = weight ? Number(weight[1]) / 100 : 0.5;
    return mix[1] === "oklab" ? mixOklab(left, right, share) : mixOklch(left, right, share);
  }
  return parseColor(text);
}

function mixesAchromaticInOklch(value: string, tokens: Tokens): boolean {
  const mix = /^color-mix\(\s*in\s+oklch\s*,(.*)\)$/is.exec(value.trim());
  if (!mix) return false;
  const [first, second] = splitArguments(mix[1]!);
  if (first === undefined || second === undefined) return false;
  const colors = [first, second]
    .map((part) => resolveColor(part.replace(/\s[\d.]+%$/, ""), tokens))
    .filter((color): color is Oklch => color !== null);
  if (colors.length !== 2) return false;
  const [a, b] = colors as [Oklch, Oklch];
  return (
    (a.c < ACHROMATIC_CHROMA && b.c > CHROMATIC_CHROMA) ||
    (b.c < ACHROMATIC_CHROMA && a.c > CHROMATIC_CHROMA)
  );
}

function checkMode(
  mode: "light" | "dark",
  tokens: Tokens,
  issues: ThemeIssue[],
): void {
  const push = (severity: ThemeIssueSeverity, token: string, message: string) =>
    issues.push({ severity, mode, token, message });

  for (const token of THEME_REQUIRED_TOKENS) {
    if (!tokens.has(token)) push("error", token, `--${token} is not set.`);
  }
  const canvas = tokens.has("canvas") ? resolveColor(tokens.get("canvas")!, tokens) : null;
  if (!canvas) return;

  if (mode === "dark" && canvas.l < MIN_DARK_CANVAS_LIGHTNESS) {
    push("warning", "canvas", "Canvas is near black; bright text on it blooms for many eyes. Lift it toward L 0.24 to 0.3.");
  }
  if (mode === "light" && canvas.l > MAX_LIGHT_CANVAS_LIGHTNESS) {
    push("warning", "canvas", "Canvas is near white and glares; lower it toward L 0.93 to 0.96.");
  }

  for (const token of TEXT_ON_CANVAS) {
    const raw = tokens.get(token);
    if (raw === undefined) continue;
    const color = resolveColor(raw, tokens);
    if (!color) {
      push("error", token, `--${token}: could not read '${raw}'.`);
      continue;
    }
    const ratio = contrastRatio(color, canvas);
    if (ratio < THEME_KIT_TEXT_CONTRAST) {
      push("error", token, `Contrast ${ratio.toFixed(1)}:1 on the canvas; text needs ${THEME_KIT_TEXT_CONTRAST}:1.`);
    }
  }

  for (const [background, foreground] of [
    ["primary", "primary-foreground"],
    ["destructive", "destructive-foreground"],
  ] as const) {
    const back = tokens.has(background) ? resolveColor(tokens.get(background)!, tokens) : null;
    const front = tokens.has(foreground) ? resolveColor(tokens.get(foreground)!, tokens) : null;
    if (!back || !front) continue;
    const ratio = contrastRatio(front, back);
    if (ratio < THEME_KIT_TEXT_CONTRAST) {
      push("error", foreground, `Contrast ${ratio.toFixed(1)}:1 on --${background}; needs ${THEME_KIT_TEXT_CONTRAST}:1.`);
    }
  }

  for (const token of STATUS_TOKENS) {
    const color = tokens.has(token) ? resolveColor(tokens.get(token)!, tokens) : null;
    if (color && color.c > MAX_COMFORT_CHROMA) {
      push("warning", token, `Chroma ${color.c.toFixed(2)} is saturated; above ${MAX_COMFORT_CHROMA} status colors tire the eye on a muted canvas.`);
    }
  }

  for (const [token, value] of tokens) {
    if (mixesAchromaticInOklch(value, tokens)) {
      push("warning", token, "Mixes a colored value into a near-grey one in oklch; the hue is undefined and can swing (a violet selection on graphite). Mix in oklab.");
    }
  }
}

export function checkThemeCss(css: string): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  const shared = extractBlock(css, /:root\s*,\s*\.light\s*\{/);
  const darkBody = extractBlock(css, /\.dark\s*\{/);
  if (shared === null) {
    issues.push({ severity: "error", mode: "both", token: ":root, .light", message: "The \":root, .light\" block is missing." });
  }
  if (darkBody === null) {
    issues.push({ severity: "error", mode: "both", token: ".dark", message: "The \".dark\" block is missing." });
  }
  if (shared === null || darkBody === null) return issues;
  const lightTokens = readTokens(shared);
  const darkTokens: Tokens = new Map([...lightTokens, ...readTokens(darkBody)]);
  checkMode("light", lightTokens, issues);
  checkMode("dark", darkTokens, issues);
  return issues;
}
