import { SIDES, type Holon, type HolonKind, type Side } from "./format.ts";
import { compareDrift, type Drift, type DriftKind, type HolonEvaluation, type HolonLight, type SideView } from "./evaluate.ts";
import { formatInstant } from "./time.ts";

export const MAX_CHILDREN = 7;

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
  light: string;
  readOnly: boolean;
  exclusive: boolean;
  drift: DriftKind | null;
}

interface ViewNode {
  id: string;
  kind: HolonKind;
  role: string;
  title: string;
  status: Holon["status"];
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
    status: Holon["status"];
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

export interface ComputedHolon {
  holon: Holon;
  evaluation: Pick<HolonEvaluation, "light" | "sides" | "seams" | "drift">;
  driftBelow: number;
  childCount: number;
}

export interface ViewSource {
  get(id: string): ComputedHolon | null;
  children(id: string): ComputedHolon[];
  seamsTo(id: string): { from: string; index: number }[];
}

export interface CheckFile {
  path: string;
  id: string | null;
  error: string | null;
}

export interface CheckHolon {
  id: string;
  path: string;
  partOf: string | null;
  carriedBy: readonly string[];
  seamTargets: readonly string[];
}

export interface CheckConfirmation {
  path: string;
  holon: string | null;
  error: string | null;
}

export function childWarning(id: string, childCount: number): string | null {
  return childCount > MAX_CHILDREN ? `${id} has ${childCount} children: a level may be missing in between` : null;
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".holon") ? name.slice(0, -".holon".length) : name;
}

export function pickWinner(paths: readonly string[]): string {
  return [...paths].sort()[0]!;
}

export function checkModel(files: readonly CheckFile[], holons: readonly CheckHolon[], confirmations: readonly CheckConfirmation[]): CheckOutput {
  const errors: CheckError[] = [];
  const warnings: CheckWarning[] = [];
  const byId = new Map<string, CheckHolon>();
  for (const holon of holons) byId.set(holon.id, holon);
  for (const file of files) {
    if (file.error !== null) {
      errors.push({ holon: file.id, file: file.path, message: file.error });
      continue;
    }
    if (file.id === null) continue;
    const winner = byId.get(file.id);
    if (winner !== undefined && winner.path !== file.path) {
      errors.push({ holon: file.id, file: file.path, message: `duplicate id ${file.id}, also in ${winner.path}` });
    }
  }
  const children = new Map<string, number>();
  for (const holon of holons) {
    if (basename(holon.path) !== holon.id) {
      errors.push({ holon: holon.id, file: holon.path, message: `id ${holon.id} differs from the file name ${basename(holon.path)}.holon` });
    }
    if (holon.partOf !== null) {
      if (byId.has(holon.partOf)) children.set(holon.partOf, (children.get(holon.partOf) ?? 0) + 1);
      else errors.push({ holon: holon.id, file: holon.path, message: `partOf names unknown holon ${holon.partOf}` });
    }
    for (const target of holon.seamTargets) {
      if (!byId.has(target)) errors.push({ holon: holon.id, file: holon.path, message: `seam to unknown holon ${target}` });
    }
    for (const carrier of holon.carriedBy) {
      if (!byId.has(carrier)) errors.push({ holon: holon.id, file: holon.path, message: `carriedBy names unknown holon ${carrier}` });
    }
  }
  const state = new Map<string, "walking" | "done">();
  for (const start of byId.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && byId.has(current) && !state.has(current)) {
      state.set(current, "walking");
      path.push(current);
      current = byId.get(current)!.partOf;
    }
    if (current !== null && state.get(current) === "walking") {
      const cycle = path.slice(path.indexOf(current));
      const first = [...cycle].sort()[0]!;
      const rotated = [...cycle.slice(cycle.indexOf(first)), ...cycle.slice(0, cycle.indexOf(first)), first];
      errors.push({ holon: first, file: byId.get(first)!.path, message: `partOf cycle: ${rotated.join(" -> ")}` });
    }
    for (const id of path) state.set(id, "done");
  }
  for (const [id, count] of children) {
    const message = childWarning(id, count);
    if (message !== null) warnings.push({ holon: id, message });
  }
  for (const confirmation of confirmations) {
    if (confirmation.error !== null) errors.push({ holon: confirmation.holon, file: confirmation.path, message: confirmation.error });
    else if (confirmation.holon !== null && !byId.has(confirmation.holon)) {
      warnings.push({ holon: confirmation.holon, message: `${confirmation.path} confirms unknown holon ${confirmation.holon}` });
    }
  }
  errors.sort((a, b) => (a.file === b.file ? (a.message < b.message ? -1 : 1) : a.file < b.file ? -1 : 1));
  warnings.sort((a, b) => (a.holon === b.holon ? (a.message < b.message ? -1 : 1) : a.holon < b.holon ? -1 : 1));
  return { format: "holon-check/v0", holons: byId.size, errors, warnings };
}

export function driftOutput(entries: Iterable<{ id: string; drift: readonly Drift[] }>, nowMs: number, commit: string): DriftOutput {
  const drift: DriftEntry[] = [];
  for (const entry of entries) for (const item of entry.drift) drift.push({ holon: entry.id, ...item });
  drift.sort((a, b) => (a.holon === b.holon ? compareDrift(a, b) : a.holon < b.holon ? -1 : 1));
  return { format: "holon-drift/v0", drift, computedAt: formatInstant(nowMs), commit };
}

function node<Role extends string>(item: ComputedHolon, role: Role) {
  return {
    id: item.holon.id,
    kind: item.holon.kind,
    role,
    title: item.holon.title,
    status: item.holon.status,
    light: item.evaluation.light,
    driftBelow: item.driftBelow,
  };
}

export function viewOutput(source: ViewSource, id: string, nowMs: number, commit: string): ViewOutput | null {
  const focus = source.get(id);
  if (focus === null) return null;
  const { holon, evaluation } = focus;
  const title = (other: string) => source.get(other)?.holon.title ?? other;
  const parent = holon.partOf === null ? null : source.get(holon.partOf);
  const children = source.children(id);
  const seams: ViewSeam[] = holon.seams.map((seam, index) => ({
    from: holon.id,
    fromTitle: holon.title,
    to: seam.to,
    toTitle: title(seam.to),
    contract: seam.contract,
    light: evaluation.seams[index]!.light,
    readOnly: seam.readOnly,
    exclusive: seam.exclusive,
    drift: evaluation.seams[index]!.drift,
  }));
  const incoming = source.seamsTo(id).filter((entry) => entry.from !== id);
  incoming.sort((a, b) => (a.from === b.from ? a.index - b.index : a.from < b.from ? -1 : 1));
  for (const entry of incoming) {
    const from = source.get(entry.from);
    const seam = from?.holon.seams[entry.index];
    const result = from?.evaluation.seams[entry.index];
    if (from === null || from === undefined || seam === undefined || result === undefined) continue;
    seams.push({
      from: from.holon.id,
      fromTitle: from.holon.title,
      to: holon.id,
      toTitle: holon.title,
      contract: seam.contract,
      light: result.light,
      readOnly: seam.readOnly,
      exclusive: seam.exclusive,
      drift: result.drift,
    });
  }
  const warnings: string[] = [];
  for (const item of [focus, ...(parent === null ? [] : [parent]), ...children]) {
    const message = childWarning(item.holon.id, item.childCount);
    if (message !== null) warnings.push(message);
  }
  return {
    format: "holon-view/v0",
    focus: {
      id: holon.id,
      kind: holon.kind,
      role: "system",
      title: holon.title,
      status: holon.status,
      why: holon.why,
      contract: holon.contract,
      carriedBy: holon.carriedBy.map((carrier) => ({ id: carrier, title: title(carrier) })),
      light: evaluation.light,
      drift: evaluation.drift.map((item) => ({ ...item })),
      driftBelow: focus.driftBelow,
      sides: Object.fromEntries(SIDES.map((side) => [side, { ...evaluation.sides[side] }])) as Record<Side, SideView>,
      code: [...holon.code],
    },
    parent: parent === null ? null : node(parent, "environment"),
    children: children.map((child) => ({ ...node(child, "part"), childCount: child.childCount })),
    seams,
    warnings,
    computedAt: formatInstant(nowMs),
    commit,
  };
}
