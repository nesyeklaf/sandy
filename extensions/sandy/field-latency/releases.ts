import type { Sample } from "./contract.ts";
import { loadCounts, type LoadBucket } from "./load.ts";
import { contentDoneValue, formatDevice, percentile, primaryMs, textTable, type DeviceInfo } from "./stats.ts";
import { UNKNOWN_RELEASE } from "./release.ts";

export interface ReleaseSample {
  release: string;
  sample: Sample;
}

export interface Metric {
  n: number;
  value: number | null;
}

export interface ReleaseRow {
  release: string;
  firstSeen: number;
  n: number;
  load: Record<LoadBucket, number>;
  switchFirstP75: Metric;
  switchFirstContentP75: Metric;
  switchRevisitP75: Metric;
  switchRevisitContentP75: Metric;
  openP75: Metric;
  scrollSmoothnessP25: Metric;
}

export type MetricKey =
  | "switchFirstP75"
  | "switchFirstContentP75"
  | "switchRevisitP75"
  | "switchRevisitContentP75"
  | "openP75"
  | "scrollSmoothnessP25";

export interface MetricDelta {
  metric: MetricKey;
  previous: number | null;
  latest: number | null;
  delta: number | null;
  deltaPct: number | null;
  previousN: number;
  latestN: number;
}

export interface ReleaseCompare {
  previous: string;
  latest: string;
  deltas: MetricDelta[];
}

export const METRICS: readonly { key: MetricKey; title: string; unit: string; higherIsBetter: boolean }[] = [
  { key: "switchFirstP75", title: "switch first p75", unit: "ms", higherIsBetter: false },
  { key: "switchFirstContentP75", title: "switch first content p75", unit: "ms", higherIsBetter: false },
  { key: "switchRevisitP75", title: "switch revisit p75", unit: "ms", higherIsBetter: false },
  { key: "switchRevisitContentP75", title: "switch revisit content p75", unit: "ms", higherIsBetter: false },
  { key: "openP75", title: "open p75", unit: "ms", higherIsBetter: false },
  { key: "scrollSmoothnessP25", title: "scroll smoothness p25", unit: "%", higherIsBetter: true },
];

function metric(values: readonly number[], p: number): Metric {
  return { n: values.length, value: percentile(values, p) };
}

function readyValues(samples: readonly Sample[]): number[] {
  return samples
    .filter((sample) => !sample.timedOut)
    .map(primaryMs)
    .filter((value): value is number => value !== null);
}

function contentValues(samples: readonly Sample[]): number[] {
  return samples.map(contentDoneValue).filter((value): value is number => value !== null);
}

export function summarizeReleases(items: readonly ReleaseSample[], firstSeen: ReadonlyMap<string, number>): ReleaseRow[] {
  const byRelease = new Map<string, Sample[]>();
  for (const { release, sample } of items) {
    const list = byRelease.get(release) ?? [];
    list.push(sample);
    byRelease.set(release, list);
  }
  const rows: ReleaseRow[] = [];
  for (const [release, samples] of byRelease) {
    const switches = samples.filter((sample) => sample.kind === "switch");
    rows.push({
      release,
      firstSeen: firstSeen.get(release) ?? Math.min(...samples.map((sample) => sample.at)),
      n: samples.length,
      load: loadCounts(samples),
      switchFirstP75: metric(readyValues(switches.filter((sample) => sample.visit === "first")), 75),
      switchFirstContentP75: metric(contentValues(switches.filter((sample) => sample.visit === "first")), 75),
      switchRevisitP75: metric(readyValues(switches.filter((sample) => sample.visit === "revisit")), 75),
      switchRevisitContentP75: metric(contentValues(switches.filter((sample) => sample.visit === "revisit")), 75),
      openP75: metric(readyValues(samples.filter((sample) => sample.kind === "open")), 75),
      scrollSmoothnessP25: metric(
        samples.filter((sample) => sample.scroll !== null).map((sample) => sample.scroll?.smoothnessPct ?? 0),
        25,
      ),
    });
  }
  return rows.sort((a, b) => a.firstSeen - b.firstSeen);
}

function delta(previous: number | null, latest: number | null): { delta: number | null; deltaPct: number | null } {
  if (previous === null || latest === null) return { delta: null, deltaPct: null };
  const change = Math.round((latest - previous) * 10) / 10;
  return { delta: change, deltaPct: previous === 0 ? null : Math.round(((latest - previous) / previous) * 1000) / 10 };
}

export function compareLastTwo(rows: readonly ReleaseRow[]): ReleaseCompare | null {
  const known = rows.filter((row) => row.release !== UNKNOWN_RELEASE);
  if (known.length < 2) return null;
  const previous = known[known.length - 2];
  const latest = known[known.length - 1];
  if (!previous || !latest) return null;
  return {
    previous: previous.release,
    latest: latest.release,
    deltas: METRICS.map(({ key }) => ({
      metric: key,
      previous: previous[key].value,
      latest: latest[key].value,
      ...delta(previous[key].value, latest[key].value),
      previousN: previous[key].n,
      latestN: latest[key].n,
    })),
  };
}

function cell(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

function dateText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function formatReleaseTable(rows: readonly ReleaseRow[]): string[] {
  const header = ["first seen", "release", "n", "load idle/busy/?", ...METRICS.map((entry) => `${entry.title} (${entry.unit})`)];
  const body = rows.map((row) => [
    dateText(row.firstSeen),
    row.release,
    String(row.n),
    `${row.load.idle}/${row.load.busy}/${row.load.unknown}`,
    ...METRICS.map((entry) => {
      const found = row[entry.key];
      return found.n > 0 ? `${cell(found.value)} (n ${found.n})` : "-";
    }),
  ]);
  return textTable(header, body);
}

export function releaseTitle(since: string): string {
  return `Field latency by release since ${since} (p75 of ms until painted; content: until the thread content stopped changing; scroll: p25 of smoothness %, higher is better; load: samples with little / much main-thread lag in the 5 s before / unknown)`;
}

export function formatReleases(rows: readonly ReleaseRow[], compare: ReleaseCompare | null, since: string, device: DeviceInfo | null = null): string {
  if (rows.length === 0) return `No samples since ${since}.`;
  return [releaseTitle(since), formatDevice(device), ...formatReleaseTable(rows), ...formatCompare(compare)].join("\n");
}

export function formatCompare(compare: ReleaseCompare | null): string[] {
  const lines: string[] = [];
  if (compare === null) {
    lines.push("", "Compare: needs two releases with a known version or script hash.");
    return lines;
  }
  lines.push("", `Compare ${compare.previous} -> ${compare.latest}`);
  for (const entry of compare.deltas) {
    const info = METRICS.find((item) => item.key === entry.metric);
    if (!info) continue;
    const change =
      entry.delta === null
        ? "no data on one side"
        : `${entry.delta > 0 ? "+" : ""}${entry.delta} ${info.unit}${entry.deltaPct === null ? "" : ` (${entry.deltaPct > 0 ? "+" : ""}${entry.deltaPct}%)`}`;
    lines.push(`  ${info.title.padEnd(24)} ${cell(entry.previous)} -> ${cell(entry.latest)}  ${change}  n ${entry.previousN} -> ${entry.latestN}`);
  }
  return lines;
}
