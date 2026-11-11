import type { Sample } from "./contract.ts";
import { loadBucket, type LoadBucket } from "./load.ts";

export function normalizeLabel(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  const head = flat.split(/: | — | - /)[0] ?? flat;
  return head.length > 60 ? `${head.slice(0, 59)}…` : head;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export function primaryMs(sample: Sample): number | null {
  if (sample.kind === "slow") return sample.eventMs;
  if (sample.kind === "scroll") return sample.scroll?.p95FrameMs ?? null;
  return sample.readyMs ?? sample.mountMs;
}

export function contentDoneValue(sample: Sample): number | null {
  return sample.contentDone === "settled" && !sample.timedOut ? sample.contentDoneMs : null;
}

export interface LoadMetric {
  n: number;
  p75: number | null;
}

export type LoadSplit = Record<LoadBucket, LoadMetric>;

export function summarizeLoad(samples: readonly Sample[]): LoadSplit {
  const split: LoadSplit = { idle: { n: 0, p75: null }, busy: { n: 0, p75: null }, unknown: { n: 0, p75: null } };
  for (const bucket of ["idle", "busy", "unknown"] as const) {
    const values = finite(samples.filter((sample) => !sample.timedOut && loadBucket(sample.load) === bucket).map(primaryMs));
    split[bucket] = { n: values.length, p75: percentile(values, 75) };
  }
  return split;
}

function loadCell(metric: LoadMetric): string {
  return metric.n === 0 ? "-" : `${cell(metric.p75)} (n ${metric.n})`;
}

export interface Group {
  kind: Sample["kind"];
  label: string;
  n: number;
  timedOut: number;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  max: number | null;
  contentN: number;
  contentCapped: number;
  contentAborted: number;
  contentP50: number | null;
  contentP75: number | null;
  eventP75: number | null;
  styleLayoutP75: number | null;
  blockingP75: number | null;
  domNodesP50: number | null;
  traced: number;
  tracedP50: number | null;
  phasesP50: Record<string, number>;
  topScripts: { source: string; totalMs: number }[];
  load: LoadSplit;
  scroll: ScrollGroup | null;
}

export interface ScrollGroup {
  smoothnessP25: number | null;
  smoothnessP50: number | null;
  droppedP50: number | null;
  refreshMsP50: number | null;
  durationMsP50: number | null;
}

function groupKey(sample: Sample): string {
  return sample.kind === "switch" ? `${sample.label} (${sample.visit ?? "?"})` : sample.label;
}

function finite(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function scrollGroup(samples: readonly Sample[]): ScrollGroup | null {
  const stats = samples.map((sample) => sample.scroll).filter((scroll) => scroll !== null);
  if (stats.length === 0) return null;
  return {
    smoothnessP25: percentile(stats.map((scroll) => scroll.smoothnessPct), 25),
    smoothnessP50: percentile(stats.map((scroll) => scroll.smoothnessPct), 50),
    droppedP50: percentile(stats.map((scroll) => scroll.dropped), 50),
    refreshMsP50: percentile(stats.map((scroll) => scroll.refreshMs), 50),
    durationMsP50: percentile(stats.map((scroll) => scroll.durationMs), 50),
  };
}

function phaseMedians(samples: readonly Sample[]): Record<string, number> {
  const byPhase = new Map<string, number[]>();
  for (const sample of samples) {
    for (const [phase, value] of Object.entries(sample.phases ?? {})) {
      const list = byPhase.get(phase) ?? [];
      list.push(value);
      byPhase.set(phase, list);
    }
  }
  const medians: Record<string, number> = {};
  for (const [phase, values] of byPhase) {
    const median = percentile(values, 50);
    if (median !== null) medians[phase] = median;
  }
  return medians;
}

export function formatPhases(phases: Record<string, number>): string {
  const parts = Object.entries(phases).map(([phase, value]) => `${phase} ${Math.round(value)}`);
  return parts.length > 0 ? parts.join(" · ") : "-";
}

export function summarize(samples: readonly Sample[]): Group[] {
  const byKey = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.kind}\u0000${groupKey(sample)}`;
    const list = byKey.get(key) ?? [];
    list.push(sample);
    byKey.set(key, list);
  }
  const groups: Group[] = [];
  for (const [key, list] of byKey) {
    const [kind, label] = key.split("\u0000") as [Sample["kind"], string];
    const primary = finite(list.filter((sample) => !sample.timedOut).map(primaryMs));
    const content = finite(list.map(contentDoneValue));
    const scriptTotals = new Map<string, number>();
    for (const sample of list) {
      for (const script of sample.scripts) {
        scriptTotals.set(script.source, (scriptTotals.get(script.source) ?? 0) + script.durationMs);
      }
    }
    groups.push({
      kind,
      label,
      n: list.length,
      timedOut: list.filter((sample) => sample.timedOut).length,
      p50: percentile(primary, 50),
      p75: percentile(primary, 75),
      p95: percentile(primary, 95),
      max: primary.length === 0 ? null : Math.max(...primary),
      contentN: content.length,
      contentCapped: list.filter((sample) => sample.contentDone === "capped").length,
      contentAborted: list.filter((sample) => sample.contentDone === "aborted").length,
      contentP50: percentile(content, 50),
      contentP75: percentile(content, 75),
      eventP75: percentile(finite(list.map((sample) => sample.eventMs)), 75),
      styleLayoutP75: percentile(list.map((sample) => sample.styleLayoutMs), 75),
      blockingP75: percentile(list.map((sample) => sample.blockingMs), 75),
      domNodesP50: percentile(list.map((sample) => sample.domNodes), 50),
      traced: list.filter((sample) => sample.tracedMs !== null).length,
      tracedP50: percentile(finite(list.map((sample) => sample.tracedMs)), 50),
      phasesP50: phaseMedians(list),
      topScripts: [...scriptTotals]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([source, totalMs]) => ({ source, totalMs: Math.round(totalMs) })),
      load: summarizeLoad(list),
      scroll: kind === "scroll" ? scrollGroup(list) : null,
    });
  }
  return groups.sort((a, b) => (b.p75 ?? 0) - (a.p75 ?? 0));
}

function cell(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

export interface DeviceInfo {
  id: string | null;
  label: string;
  userAgent: string | null;
  platform: string | null;
  benchmarkIndex: number | null;
  cores: number | null;
  deviceMemoryGb: number | null;
  devicePixelRatio: number | null;
  screen: string | null;
  refreshMs: number | null;
  gpu: string | null;
  lastSeen: number | null;
}

export function hardwareText(device: DeviceInfo): string {
  const index = device.benchmarkIndex === null ? "no benchmark" : `benchmark ${device.benchmarkIndex} iterations/s`;
  const parts = [
    index,
    device.cores === null ? null : `${device.cores} cores`,
    device.deviceMemoryGb === null ? null : `${device.deviceMemoryGb} GB`,
    device.devicePixelRatio === null ? null : `dpr ${device.devicePixelRatio}`,
    device.screen,
    device.refreshMs === null || device.refreshMs <= 0 ? null : `${Math.round(1000 / device.refreshMs)} Hz`,
    device.gpu === null ? null : `GPU ${device.gpu}`,
  ];
  return parts.filter((part) => part !== null).join(", ");
}

export function formatDevice(device: DeviceInfo | null): string {
  if (device === null) return "device: no benchmark recorded yet";
  return `device: ${hardwareText(device)}`;
}

export function textTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)));
  const line = (row: readonly string[]) => row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function countCell(group: Group): string {
  const notes = [
    group.timedOut > 0 ? `${group.timedOut} timeout` : null,
    group.contentCapped > 0 ? `${group.contentCapped} capped` : null,
    group.contentAborted > 0 ? `${group.contentAborted} aborted` : null,
  ].filter((note) => note !== null);
  return notes.length > 0 ? `${group.n} (${notes.join(", ")})` : String(group.n);
}

function formatScrollGroups(groups: readonly Group[]): string[] {
  if (groups.length === 0) return [];
  const header = ["container", "n", "smooth% p25", "smooth% p50", "dropped p50", "frame p95 p75 ms", "frame max ms", "refresh ms", "duration p50 ms", "idle frame p75", "busy frame p75"];
  const rows = groups.map((group) => [
    group.label,
    String(group.n),
    cell(group.scroll?.smoothnessP25 ?? null),
    cell(group.scroll?.smoothnessP50 ?? null),
    cell(group.scroll?.droppedP50 ?? null),
    cell(group.p75),
    cell(group.max),
    group.scroll?.refreshMsP50 === null || group.scroll === null ? "-" : String(group.scroll.refreshMsP50),
    cell(group.scroll?.durationMsP50 ?? null),
    loadCell(group.load.idle),
    loadCell(group.load.busy),
  ]);
  return ["", "Scroll sessions (user-initiated; smooth% = presented / expected frames, higher is better)", ...textTable(header, rows)];
}

export function formatGroups(groups: readonly Group[]): string[] {
  const interactions = groups.filter((group) => group.kind !== "scroll");
  const scrolls = groups.filter((group) => group.kind === "scroll");
  const header = ["kind", "label", "n", "p50", "p75", "p95", "max", "content p50", "content p75", "event p75", "style+layout p75", "nodes", "traced p50", "idle p75", "busy p75", "phases p50"];
  const rows = interactions.map((group) => [
    group.kind,
    group.label,
    countCell(group),
    cell(group.p50),
    cell(group.p75),
    cell(group.p95),
    cell(group.max),
    group.contentN > 0 ? `${cell(group.contentP50)} (n ${group.contentN})` : "-",
    group.contentN > 0 ? cell(group.contentP75) : "-",
    cell(group.eventP75),
    cell(group.styleLayoutP75),
    cell(group.domNodesP50),
    group.traced > 0 ? `${cell(group.tracedP50)} (n ${group.traced})` : "-",
    loadCell(group.load.idle),
    loadCell(group.load.busy),
    formatPhases(group.phasesP50),
  ]);
  const main = interactions.length > 0 ? textTable(header, rows) : [];
  return [...main, ...formatScrollGroups(scrolls)];
}

export function formatReport(groups: readonly Group[], since: string, device: DeviceInfo | null = null): string {
  if (groups.length === 0) return `No samples since ${since}.`;
  return [reportTitle(since), formatDevice(device), ...formatGroups(groups)].join("\n");
}

export function reportTitle(since: string): string {
  return `Field latency since ${since} (ms; open and switch: until painted, switch content: until the thread content stopped changing, slow: event duration; idle/busy p75: samples with little or much main-thread lag in the 5 s before)`;
}

export interface WriterRow {
  writer: string;
  n: number;
  sharePct: number;
  contentN: number;
  contentP50: number | null;
}

export function lastWriter(sample: Sample): string {
  if (sample.contentWrites === null) return "unknown";
  return sample.contentWrites === 0 || sample.contentSource === null ? "none" : sample.contentSource;
}

export function summarizeWriters(samples: readonly Sample[]): WriterRow[] {
  const switches = samples.filter((sample) => sample.kind === "switch");
  const byWriter = new Map<string, Sample[]>();
  for (const sample of switches) {
    const writer = lastWriter(sample);
    const list = byWriter.get(writer) ?? [];
    list.push(sample);
    byWriter.set(writer, list);
  }
  const rows = [...byWriter].map(([writer, list]) => {
    const content = finite(list.map(contentDoneValue));
    return {
      writer,
      n: list.length,
      sharePct: Math.round((list.length / switches.length) * 1000) / 10,
      contentN: content.length,
      contentP50: percentile(content, 50),
    };
  });
  return rows.sort((a, b) => b.n - a.n || a.writer.localeCompare(b.writer));
}

export function formatWriters(rows: readonly WriterRow[]): string[] {
  if (rows.length === 0) return [];
  const table = rows.map((row) => [row.writer, String(row.n), `${row.sharePct}%`, row.contentN > 0 ? `${cell(row.contentP50)} (n ${row.contentN})` : "-"]);
  return ["", "Switch last content writer (who changed the thread last after it was ready; unknown = stored before 0.3.4)", ...textTable(["writer", "n", "share", "content p50"], table)];
}
