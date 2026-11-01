// sandy_delegate_status: what a parent sees of its delegated children at a glance. The ledger decides which
// delegations the caller may see (its own children only, never a child's); everything about the running
// child is read live from SANDY through StatusHost and never cached. A value SANDY does not have is null, never 0.
import type Database from "better-sqlite3";
import { THINKING_LEVELS, type ThinkingLevel } from "./catalog.ts";
import { sandyReasoningLevel } from "./launch.ts";
import { getDelegation, getDelegationByChild, type DelegationRow } from "./ledger.ts";
import { getLatestQuestion } from "./questions.ts";
import { latestStop, type DelegationListEntry, type DelegationStop, type LiveDelegationListEntry } from "./list.ts";
import type { TurnEvent, WatchdogHost } from "./watchdog.ts";

type Db = Database.Database;

// An active child with no SANDY event for longer than this is reported stale. A long tool call emits no
// events, so this is generous.
export const STALE_AFTER_MS = 10 * 60_000;

// Rows one status call returns without a delegationId, newest first.
export const STATUS_ROW_LIMIT = 50;

export type UsageSnapshot = {
  // thread/tokenUsage/updated total.totalTokens: all tokens the thread has used.
  totalTokens: number | null;
  // thread/contextWindowUsage/updated usedTokens: what the model's context holds now.
  contextTokens: number | null;
  contextWindow: number | null;
};

// A provider or system failure SANDY recorded on the thread (provider/error, system/error).
export type FailureRecord = { at: number; source: string; message: string };

export interface StatusHost extends Pick<WatchdogHost, "threadState" | "latestTurnEvents"> {
  // The model and reasoning level SANDY runs the thread with; null when SANDY reports none.
  executionOptions(threadId: string): Promise<{ model: string; reasoningLevel: string } | null>;
  // The newest token and context events; a field SANDY has no event for is null.
  usage(threadId: string): Promise<UsageSnapshot | null>;
  // createdAt of the thread's newest event of any type; null without events.
  lastEventAt(threadId: string): Promise<number | null>;
  // The newest provider/error or system/error of the thread; null without one.
  latestFailure(threadId: string): Promise<FailureRecord | null>;
  now(): number;
}

export type DelegationStatus = {
  delegationId: string;
  threadId: string | null;
  agent: string;
  agentVersion: number | null;
  // The ledger state.
  state: string;
  // SANDY's thread status (idle, active, error ...); null while unbound or when SANDY no longer has the thread.
  threadStatus: string | null;
  // One word for the whole: running|starting|completed|failed|interrupted|idle|error|refused|stopped|archived|gone|reserved.
  status: string;
  model: string | null;
  thinking: string | null;
  reasoningLevel: string | null;
  tokens: { total: number | null; context: number | null; contextWindow: number | null };
  runtime: {
    // now - bound time (null while unbound).
    sinceBoundMs: number | null;
    // The last turn's duration: running ones count up to now. null without a turn.
    lastTurnMs: number | null;
    lastTurnRunning: boolean;
  };
  lastActivityAt: number | null;
  stale: boolean;
  // The provider's message when the child's last turn failed or the thread is in error; else null.
  error: string | null;
  stop: DelegationStop | null;
  // The child's question waiting for its answer (open) or for the child to take it (answered); else null.
  question: QuestionStatus | null;
  // Set when reading SANDY failed for this child: the other SANDY fields are then unknown (null).
  sandyError?: string;
};

export type StatusRefusal =
  | { code: "child_caller"; message: string }
  | { code: "not_your_delegation"; delegationId: string; message: string };

export type StatusResult =
  | { ok: true; delegations: DelegationStatus[]; staleAfterMs: number; truncated: boolean }
  | { ok: false; refusal: StatusRefusal };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const reasoningOf = (thinking: string | null): string | null =>
  thinking !== null && THINKING_LEVELS.includes(thinking as ThinkingLevel) ? sandyReasoningLevel(thinking as ThinkingLevel) : null;

// The newest turn/started and what completed it (a turn/completed after it), from the newest events.
function lastTurn(events: readonly TurnEvent[]): { startedAt: number | null; completed: TurnEvent | null } {
  let started: TurnEvent | null = null;
  for (const event of events) if (event.type === "started") started = event;
  const completed = events.filter((event) => event.type === "completed" && (started === null || event.seq > started.seq)).at(-1) ?? null;
  // A completion with no start in view still closes a turn.
  return { startedAt: started?.at ?? null, completed };
}

function summaryStatus(row: DelegationRow, thread: { status: string; archived: boolean } | null, completed: TurnEvent | null): string {
  if (row.state === "refused" || row.state === "stopped" || row.state === "error") return row.state;
  if (row.childThreadId === null) return row.state;
  if (thread === null) return "gone";
  if (thread.archived) return "archived";
  if (thread.status === "error") return "error";
  if (thread.status === "idle") return completed?.outcome ?? (completed !== null ? "completed" : "idle");
  if (thread.status === "active" || thread.status === "stopping") return "running";
  return "starting";
}

export type QuestionStatus = { questionId: string; state: "open" | "answered"; question: string; options: string[]; askedAt: number; expiresAt: number };

function pendingQuestion(db: Db, delegationId: string): QuestionStatus | null {
  const latest = getLatestQuestion(db, delegationId);
  if (latest === null || (latest.state !== "open" && latest.state !== "answered")) return null;
  return { questionId: latest.questionId, state: latest.state, question: latest.question, options: latest.options, askedAt: latest.createdAt, expiresAt: latest.expiresAt };
}

const nullSandy = (row: DelegationRow): DelegationStatus => ({
  delegationId: row.delegationId, threadId: row.childThreadId, agent: row.agent, agentVersion: row.agentVersion, state: row.state,
  threadStatus: null, status: row.state, model: row.model, thinking: row.thinking, reasoningLevel: reasoningOf(row.thinking),
  tokens: { total: null, context: null, contextWindow: null },
  runtime: { sinceBoundMs: null, lastTurnMs: null, lastTurnRunning: false },
  lastActivityAt: null, stale: false, error: null, stop: null, question: null,
});

// One delegation's status. A failing SANDY read leaves that child's SANDY fields null and names the error.
export async function delegationStatus(db: Db, host: StatusHost, row: DelegationRow): Promise<DelegationStatus> {
  const base = { ...nullSandy(row), stop: latestStop(db, row.delegationId), question: pendingQuestion(db, row.delegationId) };
  const now = host.now();
  const sinceBoundMs = row.boundAt === null ? null : Math.max(0, now - row.boundAt);
  if (row.childThreadId === null) return { ...base, runtime: { ...base.runtime, sinceBoundMs } };
  const threadId = row.childThreadId;
  try {
    const thread = await host.threadState(threadId);
    if (thread === null) return { ...base, status: summaryStatus(row, null, null), runtime: { ...base.runtime, sinceBoundMs } };
    const [options, usage, lastEventAt, events] = await Promise.all([
      host.executionOptions(threadId), host.usage(threadId), host.lastEventAt(threadId), host.latestTurnEvents(threadId, 6),
    ]);
    const { startedAt, completed } = lastTurn(events ?? []);
    const running = thread.status === "active" || thread.status === "starting" || thread.status === "stopping";
    const lastTurnRunning = running && startedAt !== null && completed === null;
    let lastTurnMs: number | null = null;
    if (startedAt !== null) lastTurnMs = Math.max(0, (completed !== null && !lastTurnRunning ? completed.at : now) - startedAt);
    let error: string | null = null;
    if (completed?.outcome === "failed") error = completed.error ?? null;
    if (error === null && (thread.status === "error" || completed?.outcome === "failed")) {
      error = (await host.latestFailure(threadId))?.message ?? null;
    }
    return {
      ...base,
      threadStatus: thread.status,
      status: summaryStatus(row, thread, completed),
      model: options?.model ?? row.model,
      reasoningLevel: options?.reasoningLevel ?? base.reasoningLevel,
      tokens: { total: usage?.totalTokens ?? null, context: usage?.contextTokens ?? null, contextWindow: usage?.contextWindow ?? null },
      runtime: { sinceBoundMs, lastTurnMs, lastTurnRunning },
      lastActivityAt: lastEventAt,
      stale: thread.status === "active" && lastEventAt !== null && now - lastEventAt > STALE_AFTER_MS,
      error,
    };
  } catch (error) {
    return { ...base, runtime: { ...base.runtime, sinceBoundMs }, sandyError: message(error) };
  }
}

// Runs fn over items, at most limit at a time, keeping the order.
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const STATUS_CONCURRENCY = 5;

// `sandy work delegate list` entries with the live fields of sandy_delegate_status. An entry without a child, or whose
// SANDY read fails, keeps its ledger fields and gets null SANDY fields.
export async function enrichDelegations(db: Db, host: StatusHost, entries: readonly DelegationListEntry[]): Promise<LiveDelegationListEntry[]> {
  return mapLimited(entries, STATUS_CONCURRENCY, async (entry) => {
    const status = await delegationStatus(db, host, getDelegation(db, entry.delegationId)!);
    const { threadStatus, status: summary, tokens, runtime, lastActivityAt, stale, error, question, sandyError } = status;
    return { ...entry, threadStatus, status: summary, tokens, runtime, lastActivityAt, stale, error, question, ...(sandyError === undefined ? {} : { sandyError }) };
  });
}

export function ownDelegations(db: Db, callerThreadId: string, limit: number): DelegationRow[] {
  return db.prepare(
    `SELECT delegation_id AS delegationId FROM delegations WHERE parent_thread_id = ? AND kind = 'delegate' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(callerThreadId, limit + 1).map((entry) => getDelegation(db, (entry as { delegationId: string }).delegationId)!);
}

// sandy_delegate_status for the calling thread: the one delegation named, or all of its own. Authority comes
// from the ledger alone: a delegation whose parent is another thread, or no delegation, is
// not_your_delegation (the same answer, so ids of other parents are not probed), and a delegate child
// may not ask at all.
export async function statusFor(db: Db, host: StatusHost, callerThreadId: string, delegationId?: string): Promise<StatusResult> {
  if (getDelegationByChild(db, callerThreadId) !== null) {
    return { ok: false, refusal: { code: "child_caller", message: "a delegate child cannot query delegations" } };
  }
  let rows: DelegationRow[];
  let truncated = false;
  if (delegationId !== undefined) {
    const row = getDelegation(db, delegationId);
    if (row === null || row.parentThreadId !== callerThreadId) {
      return { ok: false, refusal: { code: "not_your_delegation", delegationId, message: `delegation ${delegationId} was not started by this thread` } };
    }
    rows = [row];
  } else {
    rows = ownDelegations(db, callerThreadId, STATUS_ROW_LIMIT);
    truncated = rows.length > STATUS_ROW_LIMIT;
    rows = rows.slice(0, STATUS_ROW_LIMIT);
  }
  return { ok: true, delegations: await mapLimited(rows, STATUS_CONCURRENCY, (row) => delegationStatus(db, host, row)), staleAfterMs: STALE_AFTER_MS, truncated };
}
