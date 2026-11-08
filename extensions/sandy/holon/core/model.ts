import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  confirmationPath,
  parseConfirmation,
  parseHolon,
  type Confirmation,
  type Evidence,
  type EvidenceSide,
  type Holon,
} from "./format.ts";
import { evaluateHolon, type EvalContext, type EvalEnv, type HolonEvaluation, type SeamWriter } from "./evaluate.ts";
import {
  checkModel,
  driftOutput,
  pickWinner,
  viewOutput,
  type CheckConfirmation,
  type CheckFile,
  type CheckOutput,
  type ComputedHolon,
  type DriftOutput,
  type ViewOutput,
  type ViewSource,
} from "./outputs.ts";
import { parseInstant } from "./time.ts";
import { scanRoot } from "./scan.ts";

export interface SourceFile {
  path: string;
  text: string;
}

export interface HolonFileResult {
  path: string;
  holon: Holon | null;
  error: string | null;
}

export interface ConfirmationFileResult {
  path: string;
  confirmation: Confirmation | null;
  holon: string | null;
  error: string | null;
}

export function readHolonFile(path: string, text: string): HolonFileResult {
  const parsed = parseHolon(text);
  return parsed.ok ? { path, holon: parsed.value, error: null } : { path, holon: null, error: parsed.error };
}

export function readConfirmationFile(path: string, text: string): ConfirmationFileResult {
  const folder = /^\.holons\/confirmations\/([^/]+)\//.exec(path)?.[1] ?? null;
  const parsed = parseConfirmation(text);
  if (!parsed.ok) return { path, confirmation: null, holon: folder, error: parsed.error };
  const expected = confirmationPath(parsed.value);
  if (expected !== path) {
    return { path, confirmation: null, holon: parsed.value.holon, error: `file name does not match its holon, at, side and by: expected ${expected}` };
  }
  return { path, confirmation: parsed.value, holon: parsed.value.holon, error: null };
}

export function sideKey(holon: string, side: EvidenceSide): string {
  return `${holon}\u0000${side}`;
}

export function newerEvidence(a: Evidence, b: Evidence): boolean {
  return parseInstant(a.at) >= parseInstant(b.at);
}

export function newerConfirmation(a: { at: string; path: string }, b: { at: string; path: string }): boolean {
  return a.at > b.at || (a.at === b.at && a.path > b.path);
}

export class Model implements ViewSource {
  readonly holons = new Map<string, { holon: Holon; path: string }>();
  readonly files: HolonFileResult[];
  readonly confirmationFiles: ConfirmationFileResult[];
  private readonly childIds = new Map<string, string[]>();
  private readonly incoming = new Map<string, { from: string; index: number; readOnly: boolean }[]>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly confirmations = new Map<string, { confirmation: Confirmation; path: string }>();
  private computed = new Map<string, ComputedHolon>();

  constructor(files: HolonFileResult[], confirmationFiles: ConfirmationFileResult[], evidence: readonly Evidence[]) {
    this.files = files;
    this.confirmationFiles = confirmationFiles;
    const byId = new Map<string, HolonFileResult[]>();
    for (const file of files) {
      if (file.holon === null) continue;
      const list = byId.get(file.holon.id) ?? [];
      list.push(file);
      byId.set(file.holon.id, list);
    }
    for (const [id, list] of byId) {
      const winner = pickWinner(list.map((file) => file.path));
      this.holons.set(id, { holon: list.find((file) => file.path === winner)!.holon!, path: winner });
    }
    for (const { holon } of this.holons.values()) {
      if (holon.partOf !== null && this.holons.has(holon.partOf)) {
        const list = this.childIds.get(holon.partOf) ?? [];
        list.push(holon.id);
        this.childIds.set(holon.partOf, list);
      }
      holon.seams.forEach((seam, index) => {
        const list = this.incoming.get(seam.to) ?? [];
        list.push({ from: holon.id, index, readOnly: seam.readOnly });
        this.incoming.set(seam.to, list);
      });
    }
    for (const list of this.childIds.values()) list.sort();
    for (const record of evidence) this.addEvidence(record);
    for (const file of confirmationFiles) {
      if (file.confirmation === null) continue;
      const key = sideKey(file.confirmation.holon, file.confirmation.side);
      const current = this.confirmations.get(key);
      const candidate = { confirmation: file.confirmation, path: file.path };
      if (current === undefined || newerConfirmation({ at: file.confirmation.at, path: file.path }, { at: current.confirmation.at, path: current.path })) {
        this.confirmations.set(key, candidate);
      }
    }
  }

  static load(root: string, evidence: readonly Evidence[]): Model {
    const scan = scanRoot(root);
    return new Model(
      scan.holonFiles.map((file) => readHolonFile(file.path, readFileSync(join(root, file.path), "utf8"))),
      scan.confirmationFiles.map((file) => readConfirmationFile(file.path, readFileSync(join(root, file.path), "utf8"))),
      evidence,
    );
  }

  addEvidence(record: Evidence): void {
    const key = sideKey(record.holon, record.side);
    const current = this.evidence.get(key);
    if (current === undefined || newerEvidence(record, current)) this.evidence.set(key, record);
  }

  context(): EvalContext {
    return {
      partOf: (id) => {
        const entry = this.holons.get(id);
        return entry === undefined ? undefined : entry.holon.partOf;
      },
      latestEvidence: (holon, side) => this.evidence.get(sideKey(holon, side)) ?? null,
      latestConfirmation: (holon, side) => this.confirmations.get(sideKey(holon, side))?.confirmation ?? null,
      writersTo: (target): SeamWriter[] => (this.incoming.get(target) ?? []).map(({ from, readOnly }) => ({ from, readOnly })),
    };
  }

  childrenOf(id: string): readonly string[] {
    return this.childIds.get(id) ?? [];
  }

  evaluate(env: EvalEnv): Map<string, HolonEvaluation> {
    const ctx = this.context();
    const evaluations = new Map<string, HolonEvaluation>();
    for (const [id, { holon }] of this.holons) evaluations.set(id, evaluateHolon(holon, ctx, env));
    const driftBelow = rollUp(this.holons.keys(), (id) => this.holons.get(id)!.holon.partOf, (id) => evaluations.get(id)!.drift.length);
    this.computed = new Map();
    for (const [id, { holon }] of this.holons) {
      this.computed.set(id, { holon, evaluation: evaluations.get(id)!, driftBelow: driftBelow.get(id)!, childCount: this.childrenOf(id).length });
    }
    return evaluations;
  }

  get(id: string): ComputedHolon | null {
    return this.computed.get(id) ?? null;
  }

  children(id: string): ComputedHolon[] {
    return this.childrenOf(id).map((child) => this.computed.get(child)!);
  }

  seamsTo(id: string): { from: string; index: number }[] {
    return (this.incoming.get(id) ?? []).map(({ from, index }) => ({ from, index }));
  }

  check(): CheckOutput {
    const files: CheckFile[] = this.files.map((file) => ({ path: file.path, id: file.holon?.id ?? null, error: file.error }));
    const confirmations: CheckConfirmation[] = this.confirmationFiles.map((file) => ({ path: file.path, holon: file.holon, error: file.error }));
    return checkModel(
      files,
      [...this.holons.values()].map(({ holon, path }) => ({
        id: holon.id,
        path,
        partOf: holon.partOf,
        carriedBy: holon.carriedBy,
        seamTargets: holon.seams.map((seam) => seam.to),
      })),
      confirmations,
    );
  }

  drift(env: EvalEnv): DriftOutput {
    const evaluations = this.evaluate(env);
    return driftOutput([...evaluations].map(([id, evaluation]) => ({ id, drift: evaluation.drift })), env.nowMs, env.commit);
  }

  view(id: string, env: EvalEnv): ViewOutput | null {
    this.evaluate(env);
    return viewOutput(this, id, env.nowMs, env.commit);
  }
}

export function rollUp(ids: Iterable<string>, partOf: (id: string) => string | null | undefined, own: (id: string) => number): Map<string, number> {
  const totals = new Map<string, number>();
  const known = new Set(ids);
  for (const id of known) totals.set(id, own(id));
  for (const id of known) {
    const amount = own(id);
    if (amount === 0) continue;
    const seen = new Set<string>([id]);
    let current = partOf(id);
    while (current !== null && current !== undefined && known.has(current) && !seen.has(current)) {
      seen.add(current);
      totals.set(current, totals.get(current)! + amount);
      current = partOf(current);
    }
  }
  return totals;
}
