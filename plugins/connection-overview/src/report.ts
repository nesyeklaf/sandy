import type { ConnectionState } from "./classify.js";
import { evaluateStatus, type SourceHealth } from "./coverage.js";
import type { DestinationRow } from "./store.js";

export const NOT_MEASURED = [
  "hosts that are not Linux",
  "remote and sandbox environments",
  "unreadable pids",
  "connections shorter than about 1 s",
  "unconnected UDP (sendto without connect)",
  "sandy CLI processes started outside the server and daemon trees",
  "the clients themselves (browser, desktop, phone)",
];

export const OVERVIEW_ROW_LIMIT = 2_000;

const STATE_ORDER: readonly ConnectionState[] = [
  "red",
  "yellow",
  "undetermined",
  "unverifiable",
  "inferred",
  "third-party",
  "allowed",
];

export interface StatusReport {
  exitCode: 0 | 1 | 2;
  since: number;
  problems: string[];
  counts: Record<string, number>;
  sources: SourceHealth[];
  gaps: { sourceId: string; start: number; end: number; reason: string }[];
  capReached: boolean;
  notMeasured: string[];
}

export function buildStatusReport(
  input: {
    rows: readonly DestinationRow[];
    sources: SourceHealth[];
    gaps: StatusReport["gaps"];
    capReached: boolean;
  },
  since: number,
): StatusReport {
  const result = evaluateStatus({
    sources: input.sources,
    gaps: input.gaps,
    redCount: input.rows.filter((row) => row.state === "red").length,
    capReached: input.capReached,
  });
  const counts: Record<string, number> = {};
  for (const row of input.rows)
    counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    exitCode: result.exitCode,
    since,
    problems: result.problems,
    counts,
    sources: input.sources,
    gaps: input.gaps,
    capReached: input.capReached,
    notMeasured: NOT_MEASURED,
  };
}

export function isIncoming(row: Pick<DestinationRow, "direction">): boolean {
  return row.direction === "in";
}

export function attentionOrder(
  rows: readonly DestinationRow[],
): DestinationRow[] {
  return [...rows].sort(
    (left, right) =>
      STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state) ||
      right.lastSeen - left.lastSeen,
  );
}
