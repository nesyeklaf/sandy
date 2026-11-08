import {
  SIDES,
  isHumanKind,
  type Confirmation,
  type Evidence,
  type EvidenceSide,
  type Holon,
  type Proof,
  type Side,
} from "./format.ts";
import { DAY_MS, contractHash, formatDate, formatInstant, parseInstant } from "./time.ts";

export const SIDE_LIGHTS = ["refuted", "expired", "open", "claimed", "soft", "hard"] as const;
export type SideLight = (typeof SIDE_LIGHTS)[number];
export type HolonLight = "drift" | "open" | "claimed" | "soft" | "hard";
export const DRIFT_KINDS = ["break", "contradiction", "expired", "orphan-above", "orphan-below"] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

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

export interface SeamEvaluation {
  to: string;
  light: SideLight;
  drift: DriftKind | null;
}

export interface HolonEvaluation {
  light: HolonLight;
  sides: Record<Side, SideView>;
  seams: SeamEvaluation[];
  drift: Drift[];
  validFromMs: number | null;
  validUntilMs: number | null;
  usesCommit: boolean;
}

export interface SeamWriter {
  from: string;
  readOnly: boolean;
}

export interface EvalContext {
  partOf(id: string): string | null | undefined;
  latestEvidence(holon: string, side: EvidenceSide): Evidence | null;
  latestConfirmation(holon: string, side: EvidenceSide): Confirmation | null;
  writersTo(target: string): SeamWriter[];
}

export interface CodeChanges {
  changedPaths(build: string, commit: string): readonly string[] | null;
}

export interface EvalEnv {
  nowMs: number;
  commit: string;
  code: CodeChanges;
}

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

export function weakestSide(lights: readonly SideLight[]): SideLight {
  let weakest: SideLight = "hard";
  for (const light of lights) if (SIDE_LIGHTS.indexOf(light) < SIDE_LIGHTS.indexOf(weakest)) weakest = light;
  return weakest;
}

const SIDE_ORDER: Record<string, number> = { I: 0, It: 1, We: 2, They: 3 };

export function compareDrift(a: Drift, b: Drift): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const sa = a.side === null ? -1 : SIDE_ORDER[a.side]!;
  const sb = b.side === null ? -1 : SIDE_ORDER[b.side]!;
  if (sa !== sb) return sa - sb;
  const ma = a.seam ?? "";
  const mb = b.seam ?? "";
  return ma < mb ? -1 : ma > mb ? 1 : 0;
}

interface ProofResult {
  view: SideView;
  expiryMs: number | null;
  usesCommit: boolean;
}

function walksTo(start: string, targets: ReadonlySet<string>, ctx: EvalContext): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = start;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (targets.has(current)) return true;
    seen.add(current);
    current = ctx.partOf(current);
  }
  return false;
}

export function isDescendant(id: string, ancestor: string, ctx: EvalContext): boolean {
  const parent = ctx.partOf(id);
  return parent !== null && parent !== undefined && walksTo(parent, new Set([ancestor]), ctx);
}

function codeTouched(code: readonly string[], changed: readonly string[]): string | null {
  for (const path of changed) {
    for (const entry of code) {
      if (entry.endsWith("/") ? path.startsWith(entry) : path === entry) return path;
    }
  }
  return null;
}

function earliest(values: readonly (number | null)[]): number | null {
  let result: number | null = null;
  for (const value of values) if (value !== null && (result === null || value < result)) result = value;
  return result;
}

function evaluateProof(
  holon: Holon,
  side: EvidenceSide,
  proof: Proof | undefined | null,
  currentHash: string,
  ctx: EvalContext,
  env: EvalEnv,
): ProofResult {
  if (proof === undefined || proof === null) {
    return {
      view: { light: "open", kind: null, source: null, at: null, expires: null, by: null, detail: "No proof declared" },
      expiryMs: null,
      usesCommit: false,
    };
  }
  const declared = (at: string | null, expires: string | null, by: string | null) => ({ kind: proof.kind, source: proof.source, at, expires, by });
  const neverChecked: ProofResult = {
    view: { light: "open", ...declared(null, null, null), detail: "Declared, never checked" },
    expiryMs: null,
    usesCommit: false,
  };
  const everyMs = proof.everyDays === null ? null : proof.everyDays * DAY_MS;
  if (isHumanKind(proof.kind)) {
    const confirmation = ctx.latestConfirmation(holon.id, side);
    if (confirmation === null) return neverChecked;
    const atMs = parseInstant(confirmation.at);
    const expiryMs = earliest([parseInstant(confirmation.expires), everyMs === null ? null : atMs + everyMs]);
    const fields = declared(confirmation.at, expiryMs === null ? null : formatDate(expiryMs), confirmation.by);
    const expired = confirmation.contractHash !== currentHash
      ? "Checked against an older contract"
      : expiryMs !== null && env.nowMs >= expiryMs
        ? `Expired on ${formatDate(expiryMs)}`
        : null;
    if (expired !== null) return { view: { light: "expired", ...fields, detail: expired }, expiryMs, usesCommit: false };
    if (confirmation.result === "refuted") {
      return { view: { light: "refuted", ...fields, detail: `Refuted by ${confirmation.by}: ${confirmation.answer}` }, expiryMs, usesCommit: false };
    }
    const own = !confirmation.by.startsWith("agent:") && walksTo(confirmation.by, new Set(holon.carriedBy), ctx);
    return {
      view: own
        ? { light: "claimed", ...fields, detail: "Confirmed by its own carrier" }
        : { light: "soft", ...fields, detail: `Confirmed by ${confirmation.by}` },
      expiryMs,
      usesCommit: false,
    };
  }
  const evidence = ctx.latestEvidence(holon.id, side);
  if (evidence === null) return neverChecked;
  const atMs = parseInstant(evidence.at);
  const expiryMs = earliest([evidence.expires === null ? null : parseInstant(evidence.expires), everyMs === null ? null : atMs + everyMs]);
  const fields = declared(evidence.at, expiryMs === null ? null : formatInstant(expiryMs), null);
  let expired: string | null = null;
  if (evidence.contractHash !== currentHash) expired = "Checked against an older contract";
  else if (expiryMs !== null && env.nowMs >= expiryMs) expired = `Expired on ${formatDate(expiryMs)}`;
  else if (evidence.build !== env.commit) {
    const changed = env.code.changedPaths(evidence.build, env.commit);
    if (changed === null) expired = `Build ${evidence.build} is no known commit`;
    else {
      const touched = codeTouched(holon.code, changed);
      if (touched !== null) expired = `Code changed since build ${evidence.build.slice(0, 12)}: ${touched}`;
    }
  }
  if (expired !== null) return { view: { light: "expired", ...fields, detail: expired }, expiryMs, usesCommit: true };
  return {
    view: { light: evidence.result === "pass" ? "hard" : "refuted", ...fields, detail: evidence.detail },
    expiryMs,
    usesCommit: true,
  };
}

function contradictionWriters(holon: Holon, target: string, ctx: EvalContext): string[] {
  const writers = new Set<string>();
  for (const writer of ctx.writersTo(target)) {
    if (writer.readOnly || writer.from === holon.id) continue;
    if (isDescendant(writer.from, holon.id, ctx)) continue;
    writers.add(writer.from);
  }
  return [...writers].sort();
}

function listWriters(writers: readonly string[]): string {
  if (writers.length === 1) return `${writers[0]} writes`;
  return `${writers.slice(0, -1).join(", ")} and ${writers[writers.length - 1]} write`;
}

export function evaluateHolon(holon: Holon, ctx: EvalContext, env: EvalEnv): HolonEvaluation {
  const hash = contractHash(holon.contract);
  const expiries: number[] = [];
  let usesCommit = false;
  const drift: Drift[] = [];
  const sides = {} as Record<Side, SideView>;
  for (const side of SIDES) {
    const result = evaluateProof(holon, side, holon.proofs[side], hash, ctx, env);
    sides[side] = result.view;
    if (result.expiryMs !== null) expiries.push(result.expiryMs);
    usesCommit ||= result.usesCommit;
    if (result.view.light === "refuted") drift.push({ kind: "break", side, seam: null, detail: result.view.detail });
    if (result.view.light === "expired") drift.push({ kind: "expired", side, seam: null, detail: result.view.detail });
  }
  const seams: SeamEvaluation[] = holon.seams.map((seam) => {
    const result = evaluateProof(holon, `seam:${seam.to}`, seam.proof, contractHash(seam.contract), ctx, env);
    if (result.expiryMs !== null) expiries.push(result.expiryMs);
    usesCommit ||= result.usesCommit;
    const kinds: DriftKind[] = [];
    if (result.view.light === "refuted") {
      kinds.push("break");
      drift.push({ kind: "break", side: null, seam: seam.to, detail: `Seam to ${seam.to}: ${result.view.detail}` });
    }
    if (result.view.light === "expired") {
      kinds.push("expired");
      drift.push({ kind: "expired", side: null, seam: seam.to, detail: `Seam to ${seam.to}: ${result.view.detail}` });
    }
    if (seam.exclusive) {
      const writers = contradictionWriters(holon, seam.to, ctx);
      if (writers.length > 0) {
        kinds.push("contradiction");
        drift.push({
          kind: "contradiction",
          side: null,
          seam: seam.to,
          detail: `Promises to be the only writer to ${seam.to}, but ${listWriters(writers)} to it too`,
        });
      }
    }
    kinds.sort();
    return { to: seam.to, light: result.view.light, drift: kinds[0] ?? null };
  });
  if (holon.status === "proposed") drift.push({ kind: "orphan-below", side: null, seam: null, detail: "Proposed: a Why nothing fulfils yet" });
  if (holon.why.trim() === "") drift.push({ kind: "orphan-above", side: null, seam: null, detail: "No Why: nothing above asks for it" });
  drift.sort(compareDrift);
  let validFromMs: number | null = null;
  let validUntilMs: number | null = null;
  for (const expiry of expiries) {
    if (expiry <= env.nowMs) validFromMs = validFromMs === null ? expiry : Math.max(validFromMs, expiry);
    else validUntilMs = validUntilMs === null ? expiry : Math.min(validUntilMs, expiry);
  }
  const weakest = weakestSide(SIDES.map((side) => sides[side].light));
  const light: HolonLight = drift.length > 0 ? "drift" : weakest === "refuted" || weakest === "expired" ? "drift" : weakest;
  return { light, sides, seams, drift, validFromMs, validUntilMs, usesCommit };
}
