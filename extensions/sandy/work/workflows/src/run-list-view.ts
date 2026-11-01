import type { WorkflowRunSummary } from "./ui-contract.js";

export type RunListTone = "active" | "completed" | "failed" | "muted";

export interface RunListRow {
  id: string;
  originThreadId: string;
  name: string;
  tone: RunListTone;
  statusLabel: string;
  active: boolean;
  /** "3/5 agents", "2/5 agents · 1 failed"; null before the first agent call. */
  progress: string | null;
  /** 0..1 share of settled agent calls; null before the first agent call. */
  progressFraction: number | null;
  /** The phase a live run is in; null once the run is over. */
  phase: string | null;
  /** "just now", "5m ago", "2h ago"; null for a run that never started. */
  started: string | null;
  /** "45s", "3m 12s", "1h 5m"; null for a run that never started. */
  duration: string | null;
}

export function isSummaryActive(run: WorkflowRunSummary): boolean {
  return run.status === "queued" || run.status === "running";
}

export function formatRunDuration(
  startedAt: number | null,
  finishedAt: number | null,
  now: number,
): string | null {
  if (startedAt === null) return null;
  const totalSeconds = Math.round(
    Math.max(0, (finishedAt ?? now) - startedAt) / 1_000,
  );
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  // Two units are enough in a list row.
  if (hours > 0) return `${hours}h ${minutes}m`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatStartedAgo(
  startedAt: number | null,
  now: number,
): string | null {
  if (startedAt === null) return null;
  const seconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function toneFor(status: WorkflowRunSummary["status"]): RunListTone {
  switch (status) {
    case "queued":
    case "running":
      return "active";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "muted";
  }
}

function statusLabelFor(status: WorkflowRunSummary["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function buildRunListRow(
  run: WorkflowRunSummary,
  now: number,
): RunListRow {
  const active = isSummaryActive(run);
  const { total, settled, failed } = run.calls;
  return {
    id: run.id,
    originThreadId: run.originThreadId,
    name: run.name,
    tone: toneFor(run.status),
    statusLabel: statusLabelFor(run.status),
    active,
    progress:
      total === 0
        ? null
        : `${settled}/${total} agents${failed > 0 ? ` · ${failed} failed` : ""}`,
    progressFraction: total === 0 ? null : settled / total,
    phase: active ? run.currentPhase : null,
    started: formatStartedAgo(run.startedAt, now),
    duration: formatRunDuration(run.startedAt, run.finishedAt, now),
  };
}

/** Live runs first, then the rest; each group newest first. */
export function buildRunListRows(
  runs: readonly WorkflowRunSummary[],
  now: number,
): RunListRow[] {
  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  return [
    ...newestFirst.filter(isSummaryActive),
    ...newestFirst.filter((run) => !isSummaryActive(run)),
  ].map((run) => buildRunListRow(run, now));
}
