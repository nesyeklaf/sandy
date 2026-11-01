import type { Sample } from "./contract.ts";

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

export interface Group {
  kind: Sample["kind"];
  label: string;
  n: number;
  timedOut: number;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  max: number | null;
  eventP75: number | null;
  styleLayoutP75: number | null;
  blockingP75: number | null;
  domNodesP50: number | null;
  traced: number;
  tracedP50: number | null;
  phasesP50: Record<string, number>;
  topScripts: { source: string; totalMs: number }[];
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
      scroll: kind === "scroll" ? scrollGroup(list) : null,
    });
  }
  return groups.sort((a, b) => (b.p75 ?? 0) - (a.p75 ?? 0));
}

function cell(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

export interface DeviceInfo {
  benchmarkIndex: number | null;
  cores: number;
  deviceMemoryGb: number | null;
  devicePixelRatio: number;
  userAgent: string;
  lastSeen: number;
}

export function formatDevice(device: DeviceInfo | null): string {
  if (device === null) return "device: no benchmark recorded yet";
  const memory = device.deviceMemoryGb === null ? "" : `, ${device.deviceMemoryGb} GB`;
  const index = device.benchmarkIndex === null ? "no benchmark" : `benchmark ${device.benchmarkIndex} iterations/s`;
  return `device: ${index}, ${device.cores} cores${memory}, dpr ${device.devicePixelRatio}`;
}

export function textTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)));
  const line = (row: readonly string[]) => row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function formatScrollGroups(groups: readonly Group[]): string[] {
  if (groups.length === 0) return [];
  const header = ["container", "n", "smooth% p25", "smooth% p50", "dropped p50", "frame p95 p75 ms", "frame max ms", "refresh ms", "duration p50 ms"];
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
  ]);
  return ["", "Scroll sessions (user-initiated; smooth% = presented / expected frames, higher is better)", ...textTable(header, rows)];
}

export function formatReport(groups: readonly Group[], since: string, device: DeviceInfo | null = null): string {
  if (groups.length === 0) return `No samples since ${since}.`;
  const interactions = groups.filter((group) => group.kind !== "scroll");
  const scrolls = groups.filter((group) => group.kind === "scroll");
  const header = ["kind", "label", "n", "p50", "p75", "p95", "max", "event p75", "style+layout p75", "nodes", "traced p50", "phases p50"];
  const rows = interactions.map((group) => [
    group.kind,
    group.label,
    group.timedOut > 0 ? `${group.n} (${group.timedOut} timeout)` : String(group.n),
    cell(group.p50),
    cell(group.p75),
    cell(group.p95),
    cell(group.max),
    cell(group.eventP75),
    cell(group.styleLayoutP75),
    cell(group.domNodesP50),
    group.traced > 0 ? `${cell(group.tracedP50)} (n ${group.traced})` : "-",
    formatPhases(group.phasesP50),
  ]);
  const title = `Field latency since ${since} (ms; open and switch: until painted, slow: event duration)`;
  const main = interactions.length > 0 ? textTable(header, rows) : [];
  return [title, formatDevice(device), ...main, ...formatScrollGroups(scrolls)].join("\n");
}
