// `sandy work delegate list`: the ledger rows, newest first, as a table or JSON.
import type Database from "better-sqlite3";
import { THINKING_LEVELS, type ThinkingLevel } from "./catalog.ts";
import { sandyReasoningLevel } from "./launch.ts";
import type { DelegationRow } from "./ledger.ts";
import type { DelegationStatus } from "./status.ts";

type Db = Database.Database;

export type DelegationListEntry = Pick<DelegationRow, "delegationId" | "state" | "agent" | "parentThreadId" | "rootThreadId" | "childThreadId" | "model" | "thinking" | "createdAt"> & {
  reasoningLevel: string | null;
  ackedAt: number | null;
  briefDeliveredAt: number | null;
  // The delegation's latest stop request (of its child or of an unbound spawn), null without one.
  stop: DelegationStop | null;
};

export type DelegationStop = { threadId: string; reason: string; stoppedAt: number | null; attempts: number; lastError: string | null };

// The delegation's latest stop request (of its child or of an unbound spawn), null without one.
export function latestStop(db: Db, delegationId: string): DelegationStop | null {
  const row = db.prepare(
    `SELECT child_thread_id AS threadId, reason, stopped_at AS stoppedAt, attempts, last_error AS lastError
     FROM delegation_stops WHERE delegation_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
  ).get(delegationId) as DelegationStop | undefined;
  return row ?? null;
}

export function listDelegations(db: Db, filter: { parentThreadId?: string; limit: number }): DelegationListEntry[] {
  const rows = db.prepare(
    `SELECT d.delegation_id AS delegationId, d.state, d.agent, d.parent_thread_id AS parentThreadId, d.root_thread_id AS rootThreadId,
       d.child_thread_id AS childThreadId, d.model, d.thinking, d.created_at AS createdAt,
       (SELECT MIN(acked_at) FROM delegation_acks a WHERE a.delegation_id = d.delegation_id) AS ackedAt,
       b.delivered_at AS briefDeliveredAt,
       s.child_thread_id AS stopThreadId, s.reason AS stopReason, s.stopped_at AS stoppedAt, s.attempts AS stopAttempts, s.last_error AS stopLastError
     FROM delegations d LEFT JOIN delegation_briefs b ON b.delegation_id = d.delegation_id
     LEFT JOIN delegation_stops s ON s.rowid = (
       SELECT rowid FROM delegation_stops WHERE delegation_id = d.delegation_id ORDER BY requested_at DESC, rowid DESC LIMIT 1)
     WHERE d.kind = 'delegate' AND (? IS NULL OR d.parent_thread_id = ?)
     ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
  ).all(filter.parentThreadId ?? null, filter.parentThreadId ?? null, filter.limit) as (Omit<DelegationListEntry, "reasoningLevel" | "stop"> & {
    stopThreadId: string | null; stopReason: string; stoppedAt: number | null; stopAttempts: number; stopLastError: string | null;
  })[];
  return rows.map(({ stopThreadId, stopReason, stoppedAt, stopAttempts, stopLastError, ...row }) => ({
    ...row,
    reasoningLevel: THINKING_LEVELS.includes(row.thinking as ThinkingLevel) ? sandyReasoningLevel(row.thinking as ThinkingLevel) : null,
    stop: stopThreadId === null ? null : { threadId: stopThreadId, reason: stopReason, stoppedAt, attempts: stopAttempts, lastError: stopLastError },
  }));
}

// What the live read adds to a list entry (see enrichDelegations in status.ts).
export type LiveFields = Pick<DelegationStatus, "threadStatus" | "status" | "tokens" | "runtime" | "lastActivityAt" | "stale" | "error" | "question" | "sandyError">;
export type LiveDelegationListEntry = DelegationListEntry & LiveFields;

const isLive = (entry: DelegationListEntry): entry is LiveDelegationListEntry => "tokens" in entry;
const count = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : String(value));
const seconds = (ms: number | null): string => (ms === null ? "—" : `${Math.round(ms / 1000)}s`);

// Columns only for entries read live; an unknown value is "—", never 0.
const LIVE_COLUMNS: [string, (entry: LiveDelegationListEntry) => string][] = [
  ["STATUS", (entry) => entry.status + (entry.stale ? " (stale)" : "")],
  ["TOKENS", (entry) => count(entry.tokens.total)],
  ["CONTEXT", (entry) => (entry.tokens.context === null ? "—" : `${entry.tokens.context}/${count(entry.tokens.contextWindow)}`)],
  ["TURN", (entry) => seconds(entry.runtime.lastTurnMs)],
  ["ERROR", (entry) => (entry.error ?? entry.sandyError ?? "-").replace(/\s+/g, " ").slice(0, 80)],
];

const COLUMNS: [string, (entry: DelegationListEntry) => string][] = [
  ["DELEGATION", (entry) => entry.delegationId],
  ["STATE", (entry) => entry.state],
  ["AGENT", (entry) => entry.agent],
  ["PARENT", (entry) => entry.parentThreadId],
  ["CHILD", (entry) => entry.childThreadId ?? "-"],
  ["MODEL", (entry) => entry.model ?? "-"],
  ["REASONING", (entry) => entry.reasoningLevel ?? "-"],
  ["ACKED", (entry) => (entry.ackedAt === null ? "no" : new Date(entry.ackedAt).toISOString())],
  ["BRIEF", (entry) => (entry.briefDeliveredAt === null ? "no" : "delivered")],
  ["STOP", (entry) => stopCell(entry.stop)],
  ["CREATED", (entry) => new Date(entry.createdAt).toISOString()],
];

// "-", "stopped", or "pending" with the failed attempts and the last error.
function stopCell(stop: DelegationListEntry["stop"]): string {
  if (stop === null) return "-";
  if (stop.stoppedAt !== null) return "stopped";
  return stop.attempts === 0 ? "pending" : `pending (${stop.attempts} attempts: ${stop.lastError ?? "unconfirmed"})`;
}

export function formatDelegationTable(entries: DelegationListEntry[]): string {
  if (entries.length === 0) return "no delegations\n";
  const live = entries.every(isLive);
  const columns: [string, (entry: DelegationListEntry) => string][] = live
    ? [...COLUMNS, ...LIVE_COLUMNS.map(([title, cell]): [string, (entry: DelegationListEntry) => string] => [title, (entry) => cell(entry as LiveDelegationListEntry)])]
    : COLUMNS;
  const cells = [columns.map(([title]) => title), ...entries.map((entry) => columns.map(([, cell]) => cell(entry)))];
  const widths = columns.map((_, index) => Math.max(...cells.map((row) => row[index].length)));
  return cells.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()).join("\n") + "\n";
}
