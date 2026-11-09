import { SIDES, glyph, type CheckOutput, type ConfirmedOutput, type DriftOutput, type EvidenceRecordedOutput, type ViewOutput } from "./core/outputs.ts";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function renderCheck(output: CheckOutput): string {
  const lines = [`${output.errors.length === 0 ? "●" : "✕"} ${plural(output.holons, "holon")}, ${plural(output.errors.length, "error")}, ${plural(output.warnings.length, "warning")}`];
  for (const error of output.errors) lines.push(`✕ ${error.file}${error.holon === null ? "" : ` (${error.holon})`}: ${error.message}`);
  for (const warning of output.warnings) lines.push(`! ${warning.holon}: ${warning.message}`);
  return `${lines.join("\n")}\n`;
}

export function renderDrift(output: DriftOutput): string {
  if (output.drift.length === 0) return `● no drift at ${output.computedAt}, commit ${output.commit}\n`;
  const lines = [`◇ ${plural(output.drift.length, "drift")} at ${output.computedAt}, commit ${output.commit}`];
  for (const item of output.drift) {
    const where = item.side ?? (item.seam === null ? "" : `seam ${item.seam}`);
    lines.push(`◇ ${item.holon}  ${item.kind}${where === "" ? "" : `  ${where}`}  ${item.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderEvidenceRecorded(output: EvidenceRecordedOutput, root: string): string {
  const lines = [`● recorded ${plural(output.recorded, "evidence record")}, ${output.reevaluated} holons re-evaluated`];
  for (const id of output.unknownHolons) lines.push(`! no holon ${id} under ${root}; kept for when it appears`);
  return `${lines.join("\n")}\n`;
}

export function renderConfirmed(output: ConfirmedOutput): string {
  return `● wrote ${output.path}; ${output.confirmation.side} is now ${output.light}\n`;
}

export function renderView(view: ViewOutput): string {
  const { focus } = view;
  const lines = [
    `${glyph(focus.light)} ${focus.title} (${focus.id}, ${focus.kind}, ${focus.status})${focus.driftBelow > 0 ? `  ◇ ${focus.driftBelow} below` : ""}`,
    `  Why: ${focus.why === "" ? "(none)" : focus.why}`,
    `  Contract: ${focus.contract}`,
    `  Carried by: ${focus.carriedBy.length === 0 ? "(nobody)" : focus.carriedBy.map((item) => item.title).join(", ")}`,
  ];
  for (const side of SIDES) {
    const view_ = focus.sides[side];
    const source = view_.kind === null ? "" : ` ${view_.kind}${view_.source === null ? "" : ` ${view_.source}`}`;
    lines.push(`  ${side.padEnd(4)} ${glyph(view_.light)} ${view_.light}${source}: ${view_.detail}`);
  }
  for (const item of focus.drift) lines.push(`  ◇ ${item.kind}${item.side === null ? "" : ` ${item.side}`}${item.seam === null ? "" : ` seam ${item.seam}`}: ${item.detail}`);
  if (view.parent !== null) lines.push(`Part of: ${glyph(view.parent.light)} ${view.parent.title} (${view.parent.id})`);
  if (view.children.length > 0) {
    lines.push("Parts:");
    for (const child of view.children) {
      lines.push(`  ${glyph(child.light)} ${child.title} (${child.id})${child.driftBelow > 0 ? `  ◇ ${child.driftBelow}` : ""}`);
    }
  }
  if (view.seams.length > 0) {
    lines.push("Seams:");
    for (const seam of view.seams) {
      const marks = [seam.readOnly ? "read-only" : null, seam.exclusive ? "exclusive" : null, seam.drift].filter((item) => item !== null);
      lines.push(`  ${glyph(seam.light)} ${seam.from} → ${seam.to}: ${seam.contract}${marks.length > 0 ? ` [${marks.join(", ")}]` : ""}`);
    }
  }
  for (const warning of view.warnings) lines.push(`! ${warning}`);
  lines.push(`computed at ${view.computedAt}, commit ${view.commit}`);
  return `${lines.join("\n")}\n`;
}
