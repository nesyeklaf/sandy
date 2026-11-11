export const SIDES = ["I", "It", "We", "They"] as const;
export type Side = (typeof SIDES)[number];

export type HolonKind =
  | "context" | "system" | "container" | "component" | "operation"
  | "initiative" | "project" | "task" | "step"
  | "field" | "topic" | "concept" | "claim" | "source"
  | "vision" | "area" | "goal" | "habit" | "data-point"
  | "organisation" | "team" | "person";

export type HolonStatus = "proposed" | "active" | "retired";
export type SideLight = "refuted" | "expired" | "open" | "claimed" | "soft" | "hard";
export type HolonLight = "drift" | "open" | "claimed" | "soft" | "hard";
export type DriftKind = "break" | "contradiction" | "expired" | "orphan-above" | "orphan-below";

const GLYPHS: Record<SideLight | HolonLight, string> = {
  hard: "●",
  soft: "◐",
  claimed: "◌",
  open: "○",
  refuted: "✕",
  expired: "◇",
  drift: "◇",
};

export function glyph(light: SideLight | HolonLight): string {
  return GLYPHS[light];
}

export interface Drift {
  kind: DriftKind;
  side: Side | null;
  seam: string | null;
  detail: string;
}

export interface SideView {
  light: SideLight;
  kind: string | null;
  source: string | null;
  at: string | null;
  expires: string | null;
  by: string | null;
  detail: string;
}

export interface CheckError {
  holon: string | null;
  file: string;
  message: string;
}

export interface CheckWarning {
  holon: string;
  message: string;
}

export interface CheckOutput {
  format: "holon-check/v0";
  holons: number;
  errors: CheckError[];
  warnings: CheckWarning[];
}

export interface DriftEntry extends Drift {
  holon: string;
}

export interface DriftOutput {
  format: "holon-drift/v0";
  drift: DriftEntry[];
  computedAt: string;
  commit: string;
}

export interface ViewSeam {
  from: string;
  fromTitle: string;
  to: string;
  toTitle: string;
  contract: string;
  light: SideLight;
  readOnly: boolean;
  exclusive: boolean;
  drift: DriftKind | null;
}

interface ViewNode {
  id: string;
  kind: HolonKind;
  role: string;
  title: string;
  status: HolonStatus;
  light: HolonLight;
  driftBelow: number;
}

export interface ViewOutput {
  format: "holon-view/v0";
  focus: {
    id: string;
    kind: HolonKind;
    role: "system";
    title: string;
    status: HolonStatus;
    why: string;
    contract: string;
    carriedBy: { id: string; title: string }[];
    light: HolonLight;
    drift: Drift[];
    driftBelow: number;
    sides: Record<Side, SideView>;
    code: string[];
  };
  parent: (ViewNode & { role: "environment" }) | null;
  children: (ViewNode & { role: "part"; childCount: number })[];
  seams: ViewSeam[];
  warnings: string[];
  computedAt: string;
  commit: string;
}

export interface EvidenceRecordedOutput {
  format: "holon-evidence-recorded/v0";
  recorded: number;
  reevaluated: number;
  unknownHolons: string[];
}

export interface ConfirmedOutput {
  format: "holon-confirmed/v0";
  path: string;
  confirmation: { holon: string; side: string };
  light: SideLight;
}
