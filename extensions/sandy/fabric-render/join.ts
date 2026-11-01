// Pure join of a thread's log rows into fabric_exec views. SANDY gives its own item id to a tool call, not
// pi's toolCallId, so the fabric-render entry that pi appends while the call runs is matched by its position:
// it lies between the call's item/started and item/completed rows.
import type { Exec, ExecAudit } from "./contract.ts";

export type Row = { seq: number; createdAt: number; type: string; data: unknown };

export const RENDER_ENTRY_TYPE = "fabric-render";
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Rows worth keeping: fabric_exec calls and fabric-render entries. Everything else is dropped as it is read. */
export function isRelevant(row: Row): boolean {
  if (row.type === "item/started" || row.type === "item/completed") {
    const item = obj(obj(row.data)?.item);
    return item?.type === "toolCall" && item.tool === "fabric_exec";
  }
  return renderEntryOf(row) !== null;
}

/** The fabric-render entry data of a provider/unhandled row, or null. */
export function renderEntryOf(row: Row): Record<string, unknown> | null {
  if (row.type !== "provider/unhandled") return null;
  const message = obj(obj(obj(obj(row.data)?.rawEvent)?.params)?.message);
  if (message?.type !== "entry_appended") return null;
  const entry = obj(message.entry);
  if (entry?.type !== "custom" || entry.customType !== RENDER_ENTRY_TYPE) return null;
  const data = obj(entry.data);
  return data && data.schemaVersion === 1 ? data : null;
}

const resultText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  const o = obj(value);
  if (o && typeof o.text === "string") return o.text;
  return value === undefined || value === null ? null : JSON.stringify(value).slice(0, 4000);
};

const auditsOf = (value: unknown): ExecAudit[] =>
  Array.isArray(value) ? value.filter((a): a is ExecAudit => obj(a) !== null && typeof obj(a)!.ref === "string") : [];

export function joinExecs(rows: readonly Row[]): Exec[] {
  const calls = new Map<string, { start: Row; end?: Row }>();
  const entries: Row[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (renderEntryOf(row)) { entries.push(row); continue; }
    const item = obj(obj(row.data)?.item);
    const id = str(item?.id);
    if (!id) continue;
    if (row.type === "item/started") calls.set(id, { start: row });
    else if (row.type === "item/completed") { const c = calls.get(id); if (c) c.end = row; else calls.set(id, { start: row, end: row }); }
  }
  const execs: Exec[] = [];
  const used = new Set<number>();
  for (const [itemId, { start, end }] of calls) {
    const startItem = obj(obj(start.data)?.item)!;
    const endItem = obj(obj(end?.data)?.item);
    const args = obj(startItem.arguments) ?? {};
    const display = obj(args.display);
    const entry = entries.find((e) => !used.has(e.seq) && e.seq > start.seq && e.seq <= (end?.seq ?? Infinity));
    if (entry) used.add(entry.seq);
    const data = entry ? renderEntryOf(entry) : null;
    const entryDisplay = obj(data?.display);
    const failed = data ? data.success === false : endItem?.status === "failed" || endItem?.status === "error";
    execs.push({
      itemId,
      startSeq: start.seq,
      at: start.createdAt,
      name: str(entryDisplay?.name) ?? str(display?.name),
      description: str(entryDisplay?.description) ?? str(display?.description),
      code: (str(args.code) ?? "").slice(0, 6000),
      codeHead: (str(args.code) ?? "").split("\n").slice(0, 3).join("\n").slice(0, 240),
      status: end ? (failed ? "failed" : "completed") : "running",
      source: data ? "entry" : "call",
      phases: Array.isArray(data?.phases) ? (data!.phases as unknown[]).filter((p): p is string => typeof p === "string") : [],
      auditCount: typeof data?.auditCount === "number" ? data.auditCount : 0,
      truncated: data?.truncated === true,
      audits: auditsOf(data?.audits),
      resultText: resultText(endItem?.result),
    });
  }
  return execs.sort((a, b) => a.startSeq - b.startSeq);
}
