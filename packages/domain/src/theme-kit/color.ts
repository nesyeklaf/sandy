export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

const RADIANS = Math.PI / 180;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function encodeSrgb(linear: number): number {
  const value = clamp01(linear);
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decodeSrgb(encoded: number): number {
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

export function oklchToLinearRgb(color: Oklch): LinearRgb {
  const a = color.c * Math.cos(color.h * RADIANS);
  const b = color.c * Math.sin(color.h * RADIANS);
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function linearRgbToOklch(rgb: LinearRgb): Oklch {
  const l = Math.cbrt(
    0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b,
  );
  const m = Math.cbrt(
    0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b,
  );
  const s = Math.cbrt(
    0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b,
  );
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) / RADIANS + 360) % 360;
  return { l: lightness, c: chroma, h: chroma < 1e-4 ? 0 : hue };
}

export function relativeLuminance(color: Oklch): number {
  const rgb = oklchToLinearRgb(color);
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function formatOklch(color: Oklch): string {
  return `oklch(${round(color.l, 3)} ${round(color.c, 3)} ${round(color.h, 1)})`;
}

export function formatHex(color: Oklch): string {
  const rgb = oklchToLinearRgb(color);
  return (
    "#" +
    [rgb.r, rgb.g, rgb.b]
      .map((channel) =>
        Math.round(encodeSrgb(channel) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function mixOklab(a: Oklch, b: Oklch, weightA: number): Oklch {
  const toLab = (color: Oklch) => ({
    l: color.l,
    a: color.c * Math.cos(color.h * RADIANS),
    b: color.c * Math.sin(color.h * RADIANS),
  });
  const x = toLab(a);
  const y = toLab(b);
  const w = weightA;
  const lab = {
    l: x.l * w + y.l * (1 - w),
    a: x.a * w + y.a * (1 - w),
    b: x.b * w + y.b * (1 - w),
  };
  const chroma = Math.hypot(lab.a, lab.b);
  const hue = (Math.atan2(lab.b, lab.a) / RADIANS + 360) % 360;
  return { l: lab.l, c: chroma, h: chroma < 1e-4 ? 0 : hue };
}

export function mixOklch(a: Oklch, b: Oklch, weightA: number): Oklch {
  const delta = ((b.h - a.h + 540) % 360) - 180;
  return {
    l: a.l * weightA + b.l * (1 - weightA),
    c: a.c * weightA + b.c * (1 - weightA),
    h: (((a.h + delta * (1 - weightA)) % 360) + 360) % 360,
  };
}

const OKLCH_PATTERN =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/;

export function parseColor(input: string): Oklch | null {
  const text = input.trim().toLowerCase();
  const oklch = OKLCH_PATTERN.exec(text);
  if (oklch) {
    const lightness = Number(oklch[1]);
    return {
      l: oklch[2] === "%" ? lightness / 100 : lightness,
      c: Number(oklch[3]),
      h: Number(oklch[4]),
    };
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (!hex) return null;
  const digits =
    hex[1]!.length === 3
      ? [...hex[1]!].map((digit) => digit + digit).join("")
      : hex[1]!;
  const channel = (offset: number) =>
    decodeSrgb(parseInt(digits.slice(offset, offset + 2), 16) / 255);
  return linearRgbToOklch({ r: channel(0), g: channel(2), b: channel(4) });
}
