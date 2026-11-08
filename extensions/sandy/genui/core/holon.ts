import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

export const HOLON_VIEW_FORMAT = "holon-view/v0";

export type HolonTone = "neutral" | "good" | "warn" | "bad" | "info";

export const SIDE_NAMES = ["I", "It", "We", "They"] as const;
export type SideName = (typeof SIDE_NAMES)[number];

export const SIDE_HINTS: Record<SideName, string> = {
  I: "can someone explain it",
  It: "does it keep the contract",
  We: "does the whole above count on it",
  They: "does it hold up among its neighbours",
};

const SIDE_LIGHTS = ["hard", "soft", "claimed", "open", "refuted", "expired"] as const;
export type SideLight = (typeof SIDE_LIGHTS)[number];
export type Light = SideLight | "drift";

export interface LightLook {
  readonly glyph: string;
  readonly label: string;
  readonly tone: HolonTone;
}

export const LIGHTS: Record<Light, LightLook> = {
  hard: { glyph: "●", label: "hard", tone: "good" },
  soft: { glyph: "◐", label: "soft", tone: "info" },
  claimed: { glyph: "◌", label: "claimed", tone: "neutral" },
  open: { glyph: "○", label: "open", tone: "neutral" },
  refuted: { glyph: "✕", label: "refuted", tone: "bad" },
  expired: { glyph: "◇", label: "expired", tone: "warn" },
  drift: { glyph: "◇", label: "drift", tone: "warn" },
};

export const DRIFT_KINDS = {
  break: { label: "break", tone: "bad" },
  expired: { label: "expired", tone: "warn" },
  "orphan-below": { label: "orphan below", tone: "warn" },
  "orphan-above": { label: "orphan above", tone: "warn" },
  contradiction: { label: "contradiction", tone: "bad" },
} as const satisfies Record<string, { readonly label: string; readonly tone: HolonTone }>;
export type DriftKind = keyof typeof DRIFT_KINDS;

export interface HolonDrift {
  readonly kind: DriftKind;
  readonly side: SideName | null;
  readonly seam: string | null;
  readonly detail: string;
}

export interface HolonSide {
  readonly light: SideLight;
  readonly kind: string | null;
  readonly source: string | null;
  readonly at: string | null;
  readonly expires: string | null;
  readonly by: string | null;
  readonly detail: string | null;
}

export const HOLON_KINDS = [
  "context", "system", "container", "component", "operation",
  "initiative", "project", "task", "step",
  "field", "topic", "concept", "claim", "source",
  "vision", "area", "goal", "habit", "data-point",
  "organisation", "team", "person",
] as const;
export type HolonKind = (typeof HOLON_KINDS)[number];

export const HOLON_STATUSES = ["proposed", "active", "retired"] as const;
export type HolonStatus = (typeof HOLON_STATUSES)[number];

export type HolonRole = "system" | "environment" | "part";

export interface HolonSummary {
  readonly id: string;
  readonly kind: HolonKind;
  readonly role: HolonRole;
  readonly title: string;
  readonly status: HolonStatus;
  readonly light: Light;
  readonly driftBelow: number;
}

export interface HolonChild extends HolonSummary {
  readonly childCount: number;
}

export interface HolonFocus extends HolonSummary {
  readonly why: string;
  readonly contract: string;
  readonly carriedBy: readonly { readonly id: string; readonly title: string }[];
  readonly drift: readonly HolonDrift[];
  readonly sides: Readonly<Record<SideName, HolonSide>>;
  readonly code: readonly string[];
}

export interface HolonSeam {
  readonly from: string;
  readonly fromTitle: string;
  readonly to: string;
  readonly toTitle: string;
  readonly contract: string;
  readonly light: Light;
  readonly readOnly: boolean;
  readonly exclusive: boolean;
  readonly drift: DriftKind | null;
}

export interface HolonView {
  readonly focus: HolonFocus;
  readonly parent: HolonSummary | null;
  readonly children: readonly HolonChild[];
  readonly seams: readonly HolonSeam[];
  readonly warnings: readonly string[];
  readonly computedAt: string;
  readonly commit: string;
}

export type HolonRead = { readonly ok: true; readonly view: HolonView } | { readonly ok: false; readonly error: string };

class ViewError extends Error {}

type Fields = { readonly [key: string]: Value };

function fail(path: string, expected: string): never {
  throw new ViewError(`Holon: ${path} should be ${expected}`);
}

function object(value: Value | undefined, path: string): Fields {
  if (value === undefined || !isPlainObject(value)) return fail(path, "an object");
  return value;
}

function list(value: Value | undefined, path: string): readonly Value[] {
  return Array.isArray(value) ? value : fail(path, "a list");
}

function text(fields: Fields, key: string, path: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : fail(`${path}.${key}`, "a string");
}

function textOrNull(fields: Fields, key: string, path: string): string | null {
  const value = fields[key];
  if (value === null) return null;
  return typeof value === "string" ? value : fail(`${path}.${key}`, "a string or null");
}

function count(fields: Fields, key: string, path: string): number {
  const value = fields[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${path}.${key}`, "a count");
}

function flag(fields: Fields, key: string, path: string): boolean {
  const value = fields[key];
  return typeof value === "boolean" ? value : fail(`${path}.${key}`, "true or false");
}

function oneOf<T extends string>(value: Value | undefined, allowed: readonly T[], path: string): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fail(path, `one of ${allowed.join(", ")}`);
}

const LIGHT_NAMES: readonly Light[] = [...SIDE_LIGHTS, "drift"];
const DRIFT_NAMES = Object.keys(DRIFT_KINDS) as DriftKind[];

function readSide(value: Value | undefined, path: string): HolonSide {
  const fields = object(value, path);
  return {
    light: oneOf(fields.light, SIDE_LIGHTS, `${path}.light`),
    kind: textOrNull(fields, "kind", path),
    source: textOrNull(fields, "source", path),
    at: textOrNull(fields, "at", path),
    expires: textOrNull(fields, "expires", path),
    by: textOrNull(fields, "by", path),
    detail: textOrNull(fields, "detail", path),
  };
}

function readDrift(value: Value | undefined, path: string): HolonDrift {
  const fields = object(value, path);
  const side = fields.side;
  return {
    kind: oneOf(fields.kind, DRIFT_NAMES, `${path}.kind`),
    side: side === null ? null : oneOf(side, SIDE_NAMES, `${path}.side`),
    seam: textOrNull(fields, "seam", path),
    detail: text(fields, "detail", path),
  };
}

function readSummary(fields: Fields, path: string, role: HolonRole): HolonSummary {
  return {
    id: text(fields, "id", path),
    kind: oneOf(fields.kind, HOLON_KINDS, `${path}.kind`),
    role: oneOf(fields.role, [role], `${path}.role`),
    title: text(fields, "title", path),
    status: oneOf(fields.status, HOLON_STATUSES, `${path}.status`),
    light: oneOf(fields.light, LIGHT_NAMES, `${path}.light`),
    driftBelow: count(fields, "driftBelow", path),
  };
}

function readFocus(value: Value | undefined): HolonFocus {
  const path = "focus";
  const fields = object(value, path);
  const sides = object(fields.sides, `${path}.sides`);
  return {
    ...readSummary(fields, path, "system"),
    why: text(fields, "why", path),
    contract: text(fields, "contract", path),
    carriedBy: list(fields.carriedBy, `${path}.carriedBy`).map((entry, index) => {
      const carrier = object(entry, `${path}.carriedBy[${index}]`);
      return { id: text(carrier, "id", `${path}.carriedBy[${index}]`), title: text(carrier, "title", `${path}.carriedBy[${index}]`) };
    }),
    drift: list(fields.drift, `${path}.drift`).map((entry, index) => readDrift(entry, `${path}.drift[${index}]`)),
    sides: {
      I: readSide(sides.I, `${path}.sides.I`),
      It: readSide(sides.It, `${path}.sides.It`),
      We: readSide(sides.We, `${path}.sides.We`),
      They: readSide(sides.They, `${path}.sides.They`),
    },
    code: list(fields.code, `${path}.code`).map((entry, index) => (typeof entry === "string" ? entry : fail(`${path}.code[${index}]`, "a string"))),
  };
}

function readChild(value: Value | undefined, index: number): HolonChild {
  const path = `children[${index}]`;
  const fields = object(value, path);
  return { ...readSummary(fields, path, "part"), childCount: count(fields, "childCount", path) };
}

function readSeam(value: Value | undefined, index: number): HolonSeam {
  const path = `seams[${index}]`;
  const fields = object(value, path);
  return {
    from: text(fields, "from", path),
    fromTitle: text(fields, "fromTitle", path),
    to: text(fields, "to", path),
    toTitle: text(fields, "toTitle", path),
    contract: text(fields, "contract", path),
    light: oneOf(fields.light, LIGHT_NAMES, `${path}.light`),
    readOnly: flag(fields, "readOnly", path),
    exclusive: flag(fields, "exclusive", path),
    drift: fields.drift === null ? null : oneOf(fields.drift, DRIFT_NAMES, `${path}.drift`),
  };
}

function readView(value: Value | undefined): HolonView {
  const fields = object(value, "view");
  if (fields.format !== HOLON_VIEW_FORMAT) {
    return fail("format", `"${HOLON_VIEW_FORMAT}" (got ${typeof fields.format === "string" ? `"${fields.format}"` : "none"})`);
  }
  return {
    focus: readFocus(fields.focus),
    parent: fields.parent === null ? null : readSummary(object(fields.parent, "parent"), "parent", "environment"),
    children: list(fields.children, "children").map(readChild),
    seams: list(fields.seams, "seams").map(readSeam),
    warnings: list(fields.warnings, "warnings").map((entry, index) => (typeof entry === "string" ? entry : fail(`warnings[${index}]`, "a string"))),
    computedAt: text(fields, "computedAt", "view"),
    commit: text(fields, "commit", "view"),
  };
}

export function readHolonView(value: Value | undefined): HolonRead {
  if (value === undefined || value === null) return { ok: false, error: "Holon needs a holon-view/v0 object, usually Holon(Load(\"view.json\"))" };
  try {
    return { ok: true, view: readView(value) };
  } catch (cause) {
    if (cause instanceof ViewError) return { ok: false, error: cause.message };
    throw cause;
  }
}
