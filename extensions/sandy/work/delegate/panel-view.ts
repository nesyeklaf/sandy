// Pure formatting and selection for the Delegates panel (app.tsx); tests/panel-view.test.ts.
import type { PanelRow } from "./panel-types.ts";

const compact = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

// "Σ 12.3k / ctx 40k of 200k"; "—" for each part SANDY has no event for.
export function formatTokens(tokens: PanelRow["tokens"]): string {
  const total = tokens.total === null ? "—" : compact(tokens.total);
  const context = tokens.context === null ? "—" : compact(tokens.context);
  const window = tokens.contextWindow === null ? "" : ` of ${compact(tokens.contextWindow)}`;
  return `Σ ${total} / ctx ${context}${window}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type StatusTone = "running" | "waiting" | "done" | "failed" | "ended";

// The badge colour group of sandy_delegate_status's one-word status; an open question reads as waiting.
export function statusTone(row: Pick<PanelRow, "status" | "question">): StatusTone {
  if (row.question?.state === "open") return "waiting";
  if (row.status === "running" || row.status === "starting" || row.status === "reserved") return "running";
  if (row.status === "completed" || row.status === "idle") return "done";
  if (row.status === "failed" || row.status === "error" || row.status === "refused" || row.status === "interrupted") return "failed";
  return "ended";
}

const ENDED = new Set(["stopped", "refused", "error", "archived", "gone"]);
export const isEnded = (row: Pick<PanelRow, "status" | "state">): boolean => ENDED.has(row.status) || ENDED.has(row.state);

// The model line: "model · reasoning", either part "—" when unknown.
export const formatModel = (row: Pick<PanelRow, "model" | "reasoningLevel">): string => `${row.model ?? "—"} · ${row.reasoningLevel ?? "—"}`;

// The row's labelled reasoning column, "reasoning high" or "reasoning —".
export const formatReasoning = (level: string | null): string => `reasoning ${level ?? "—"}`;

// The row's runtime column: the last turn ("…" while it runs), else the time since the child was bound.
export const formatRuntime = (runtime: PanelRow["runtime"]): string =>
  runtime.lastTurnMs !== null ? `${formatDuration(runtime.lastTurnMs)}${runtime.lastTurnRunning ? "…" : ""}` : formatDuration(runtime.sinceBoundMs);

const STOPPABLE = new Set(["running", "starting", "reserved"]);

// Rows by the header's state words; each row counts once, an open question before its status.
export type FleetCounts = { running: number; idle: number; asksYou: number; failed: number; ended: number };

export function fleetCounts(rows: Pick<PanelRow, "status" | "question">[]): FleetCounts {
  const counts: FleetCounts = { running: 0, idle: 0, asksYou: 0, failed: 0, ended: 0 };
  for (const row of rows) {
    const tone = statusTone(row);
    if (tone === "waiting") counts.asksYou += 1;
    else if (tone === "done") counts.idle += 1;
    else counts[tone] += 1;
  }
  return counts;
}

// "1 running · 2 idle · 1 asks you"; zero counts are left out, "none" when there are no rows.
export function formatFleetCounts(counts: FleetCounts): string {
  const parts = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.idle > 0 ? `${counts.idle} idle` : null,
    counts.asksYou > 0 ? `${counts.asksYou} asks you` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.ended > 0 ? `${counts.ended} ended` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "none" : parts.join(" · ");
}

// Stop all has something to stop only while a child is running or waiting to start.
export const canStopAll = (rows: Pick<PanelRow, "status">[]): boolean => rows.some((row) => STOPPABLE.has(row.status));

// Below this panel width the detail replaces the list (with Back) instead of expanding inline.
export const NARROW_PANEL_PX = 480;
export const panelLayout = (width: number): "narrow" | "wide" => (width > 0 && width < NARROW_PANEL_PX ? "narrow" : "wide");

type ComposerRow = Pick<PanelRow, "status" | "question"> & { acknowledged?: boolean };

// A failure the owner has not acknowledged yet; an acknowledged one lives only in the Delegates tab.
export const needsAck = (row: ComposerRow): boolean => statusTone(row) === "failed" && row.acknowledged !== true;

// Composer: a child is open while it runs, asks the parent or failed unacknowledged; done, ended and
// acknowledged children live only in the Delegates tab.
export const isOpenRow = (row: ComposerRow): boolean => {
  const tone = statusTone(row);
  return tone === "running" || tone === "waiting" || needsAck(row);
};

export const openRows = <Row extends ComposerRow>(rows: Row[]): Row[] => rows.filter(isOpenRow);

// Composer: the parent's context segment over its open children, "2 delegates · 1 asks you · +3 done · Σ 74k";
// Σ covers every child, "Σ —" when none has a token total.
export function fleetSegmentText(rows: (ComposerRow & Pick<PanelRow, "tokens">)[]): string {
  const open = openRows(rows);
  const counts = fleetCounts(open);
  const totals = rows.map((row) => row.tokens.total).filter((total): total is number => total !== null);
  const parts = [`${open.length} delegate${open.length === 1 ? "" : "s"}`];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.asksYou > 0) parts.push(`${counts.asksYou} asks you`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (rows.length > open.length) parts.push(`+${rows.length - open.length} done`);
  parts.push(`Σ ${totals.length === 0 ? "—" : compact(totals.reduce((sum, total) => sum + total, 0))}`);
  return parts.join(" · ");
}

// Composer: the fleet banner lists the children that need the parent (an open question or a failure not
// acknowledged yet); no rows hides the banner.
export const bannerRows = <Row extends ComposerRow>(rows: Row[]): Row[] =>
  rows.filter((row) => statusTone(row) === "waiting" || needsAck(row));

// One state word for a row: "asks you" for an open question, else the status.
export const stateLabel = (row: Pick<PanelRow, "status" | "question">): string => (row.question?.state === "open" ? "asks you" : row.status);

// Composer: a child thread's own segment, "scout · reader · asks you".
export const childSegmentText = (row: Pick<PanelRow, "agent" | "agentVersion" | "role" | "status" | "question">): string =>
  [`${row.agent}${row.agentVersion !== null ? ` v${row.agentVersion}` : ""}`, row.role ?? "—", stateLabel(row)].join(" · ");

// j/k and the arrow keys move the selection, clamped to the list; other keys leave it.
export function moveSelection(key: string, index: number, count: number): number {
  if (count === 0) return 0;
  if (key === "j" || key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "k" || key === "ArrowUp") return Math.max(0, index - 1);
  return Math.min(Math.max(0, index), count - 1);
}

// One line for a merge result, as the panel shows it.
export function mergeMessage(result: { status: string; message?: string; branch?: string; into?: string; commit?: string; files?: string[]; clean?: boolean }): string {
  switch (result.status) {
    case "merged":
      return `merged ${result.branch} into ${result.into} (${result.commit})`;
    case "up_to_date":
      return `${result.branch} is already merged into ${result.into}`;
    case "dirty":
      return `refused: ${result.message}${result.files && result.files.length > 0 ? ` (${result.files.join(", ")})` : ""}`;
    case "conflict":
      return `${result.message}: ${(result.files ?? []).join(", ")}${result.clean ? "; checkout left clean" : "; checkout NOT clean, check it"}`;
    default:
      return `merge failed: ${result.message}${result.clean === false ? " (checkout NOT clean, check it)" : ""}`;
  }
}
