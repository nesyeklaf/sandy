export type TraceKind = "switch" | "open";

export interface TraceRecord {
  id: number;
  kind: TraceKind;
  label: string;
  start: number;
  end: number;
  phases: Record<string, number>;
}

export interface TraceMeasure {
  readonly startTime: number;
  readonly duration: number;
  readonly detail: unknown;
}

interface TraceDetail {
  kind: TraceKind;
  id: number;
  label: string;
  phase: string;
}

interface Partial {
  kind: TraceKind;
  label: string;
  phases: Record<string, number>;
}

const MATCH_SLACK_MS = 2;
const MAX_PARTIAL = 50;

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export function parseTraceDetail(detail: unknown): TraceDetail | null {
  if (typeof detail !== "object" || detail === null) return null;
  const sandy = field(detail, "sandy");
  if (typeof sandy !== "object" || sandy === null) return null;
  const kind = field(sandy, "interaction");
  const id = field(sandy, "id");
  const label = field(sandy, "label");
  const phase = field(sandy, "phase");
  if (kind !== "switch" && kind !== "open") return null;
  if (typeof id !== "number" || typeof label !== "string" || typeof phase !== "string") return null;
  return { kind, id, label: label.slice(0, 120), phase: phase.slice(0, 40) };
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export class TraceBook {
  private readonly partial = new Map<number, Partial>();
  private done: TraceRecord[] = [];

  add(entry: TraceMeasure): TraceRecord | null {
    const detail = parseTraceDetail(entry.detail);
    if (detail === null) return null;
    if (detail.phase !== "total") {
      const known = this.partial.get(detail.id) ?? { kind: detail.kind, label: detail.label, phases: {} };
      known.phases[detail.phase] = roundMs((known.phases[detail.phase] ?? 0) + entry.duration);
      this.partial.set(detail.id, known);
      if (this.partial.size > MAX_PARTIAL) {
        const oldest = this.partial.keys().next().value;
        if (oldest !== undefined) this.partial.delete(oldest);
      }
      return null;
    }
    const phases = this.partial.get(detail.id)?.phases ?? {};
    this.partial.delete(detail.id);
    const record: TraceRecord = {
      id: detail.id,
      kind: detail.kind,
      label: detail.label,
      start: entry.startTime,
      end: entry.startTime + entry.duration,
      phases,
    };
    this.done.push(record);
    return record;
  }

  claim(kind: TraceKind, start: number): TraceRecord | null {
    const index = this.done.findIndex((record) => record.kind === kind && Math.abs(record.start - start) <= MATCH_SLACK_MS);
    if (index < 0) return null;
    const [record] = this.done.splice(index, 1);
    return record ?? null;
  }

  takeUnclaimed(endedBefore: number): TraceRecord[] {
    const old = this.done.filter((record) => record.end <= endedBefore);
    this.done = this.done.filter((record) => record.end > endedBefore);
    return old;
  }
}
