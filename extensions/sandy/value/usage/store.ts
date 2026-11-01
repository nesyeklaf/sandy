// The usage ledger, in the plugin's own database.
//
// sandy prunes a thread's older token usage events once the thread has a few
// hundred newer events, keeping only the latest one. So the plugin copies each
// turn's usage here as it arrives, and the page and the header read from here
// rather than from sandy's events.
import type { Database } from "better-sqlite3";
import type { PiCall } from "./pi-calls.js";

import type { ContextRow } from "./context.js";
import type { LimitSample } from "./limits.js";
import type { TranscriptRead } from "./subagent-files.js";
import type { TimingRows } from "./timing.js";
import { addTokens, totalOf, ZERO_TOKENS, type Tokens } from "./breakdown.js";

/**
 * APPEND-ONLY. Statement index is the migration id. Never edit or reorder a
 * shipped statement; only push new ones.
 */
export const MIGRATIONS = [
  // One row per sandy token usage event: that turn's usage, and the provider's
  // running total for the thread at the time.
  `CREATE TABLE IF NOT EXISTS usage (
     event_id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     input INTEGER NOT NULL,
     cache_read INTEGER NOT NULL,
     output INTEGER NOT NULL,
     running_total INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS usage_created_at_idx ON usage (created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_thread_idx ON usage (thread_id, created_at)`,
  // What the page shows for a thread, and how far its events have been read.
  `CREATE TABLE IF NOT EXISTS threads (
     thread_id TEXT PRIMARY KEY,
     title TEXT,
     project_id TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     last_seq INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // When the thread was archived or deleted, or null while it is active, so
  // the page can list active and archived threads apart.
  `ALTER TABLE threads ADD COLUMN archived_at INTEGER`,
  // One row per sandy context window event: how many tokens the thread's context
  // held then. sandy prunes these as it does usage events.
  `CREATE TABLE IF NOT EXISTS context (
     event_id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_tokens INTEGER NOT NULL,
     context_window INTEGER,
     auto_compact_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS context_thread_idx ON context (thread_id, created_at)`,
  // When each turn started and finished.
  `CREATE TABLE IF NOT EXISTS turn_times (
     thread_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     started_at INTEGER,
     completed_at INTEGER,
     PRIMARY KEY (thread_id, turn_id)
   )`,
  `CREATE INDEX IF NOT EXISTS turn_times_started_idx ON turn_times (started_at)`,
  // Each tool a turn waited on: a shell command, a tool call, a file read.
  `CREATE TABLE IF NOT EXISTS item_times (
     thread_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     turn_id TEXT,
     kind TEXT NOT NULL,
     label TEXT,
     started_at INTEGER,
     completed_at INTEGER,
     PRIMARY KEY (thread_id, item_id)
   )`,
  `CREATE INDEX IF NOT EXISTS item_times_turn_idx ON item_times (thread_id, turn_id)`,
  // Each question the agent asked you, from asking to your answer.
  `CREATE TABLE IF NOT EXISTS waits (
     thread_id TEXT NOT NULL,
     interaction_id TEXT NOT NULL,
     turn_id TEXT,
     kind TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     resolved_at INTEGER,
     PRIMARY KEY (thread_id, interaction_id)
   )`,
  // Reads the past nine days again, the page's longest range and some, so
  // their timings are recorded. Usage and context rows already recorded are
  // ignored by their event ids.
  `UPDATE threads SET last_seq = 0 WHERE thread_id IN (
     SELECT DISTINCT thread_id FROM usage
     WHERE created_at > (CAST(strftime('%s', 'now') AS INTEGER) - 9 * 86400) * 1000
   )`,
  // The Claude Code session behind the thread, which names its subagents' transcripts.
  `ALTER TABLE threads ADD COLUMN session_id TEXT`,
  // How far into each subagent transcript the plugin has read.
  `CREATE TABLE IF NOT EXISTS subagent_files (
     path TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     description TEXT,
     offset INTEGER NOT NULL
   )`,
  // One row per model call a subagent made. sandy never reports these, so the
  // thread's own usage leaves them out.
  `CREATE TABLE IF NOT EXISTS subagent_calls (
     thread_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     input INTEGER NOT NULL,
     cache_read INTEGER NOT NULL,
     output INTEGER NOT NULL,
     PRIMARY KEY (thread_id, message_id)
   )`,
  `CREATE INDEX IF NOT EXISTS subagent_calls_created_at_idx ON subagent_calls (created_at)`,
  // One row per reading of a subscription's usage limit window, polled from
  // the providers, so the page can tell the pace each is used at.
  `CREATE TABLE IF NOT EXISTS limit_samples (
     provider_id TEXT NOT NULL,
     account_key TEXT NOT NULL,
     label TEXT NOT NULL,
     kind TEXT NOT NULL,
     model TEXT,
     sampled_at INTEGER NOT NULL,
     used_percent REAL NOT NULL,
     resets_at INTEGER NOT NULL,
     PRIMARY KEY (provider_id, account_key, label, sampled_at)
   )`,
  `CREATE INDEX IF NOT EXISTS limit_samples_sampled_at_idx ON limit_samples (sampled_at)`,
  // Value: which model and which host each turn ran on, so cost and quota can be split by account and machine.
  `ALTER TABLE usage ADD COLUMN model TEXT`,
  `ALTER TABLE usage ADD COLUMN host_id TEXT`,
  `ALTER TABLE threads ADD COLUMN host_id TEXT`,
  `ALTER TABLE threads ADD COLUMN model TEXT`,
  // Every model call Pi made, from its own session file, since sandy reports one event per turn and that holds only the turn's last call.
  `CREATE TABLE IF NOT EXISTS pi_calls (
     call_key TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     host_id TEXT,
     created_at INTEGER NOT NULL,
     model TEXT NOT NULL,
     input INTEGER NOT NULL,
     cache_read INTEGER NOT NULL,
     output INTEGER NOT NULL,
     cost_usd REAL
   )`,
  `CREATE INDEX IF NOT EXISTS pi_calls_thread_idx ON pi_calls (thread_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS pi_calls_created_at_idx ON pi_calls (created_at)`,
];

export interface ThreadInfo {
  threadId: string;
  title: string | null;
  projectId: string;
  providerId: string;
  /** When it was archived or deleted; null while it is active. */
  archivedAt: number | null;
  /** The host its environment runs on; null without an environment. */
  hostId?: string | null;
  /** The model the thread resolved to when it was read; null when unknown. */
  model?: string | null;
}

export interface UsageRow {
  eventId: string;
  createdAt: number;
  tokens: Tokens;
  runningTotal: number;
}

export interface HourUsage extends Tokens {
  /** Start of the hour, in epoch milliseconds. */
  hour: number;
}

export interface ThreadUsage extends Tokens {
  threadId: string;
  title: string | null;
  projectId: string;
  providerId: string;
  archivedAt: number | null;
  turns: number;
}

export interface ThreadHour {
  threadId: string;
  /** Start of the hour, in epoch milliseconds. */
  hour: number;
  total: number;
}

export interface UsageAt extends Tokens {
  /** When sandy recorded the usage, in epoch milliseconds. */
  at: number;
}

export interface ThreadTotal {
  tokens: Tokens;
  /**
   * The best total for the thread's whole life. The sum of recorded turns
   * misses turns sandy pruned before they were recorded; the provider's running
   * total misses turns before its last restart. Each undercounts in a
   * different way, so this is the larger of the two.
   */
  total: number;
  turns: number;
  /** Claude Code subagents the thread ran, and the tokens they used, which sandy does not report. */
  subagents: { count: number; tokens: number };
}

const HOUR_MS = 3_600_000;

/** One recorded turn's tokens and where it ran; model and host are null on rows from before they were recorded. */
export interface TurnRow {
  at: number;
  hostId: string | null;
  model: string | null;
  input: number;
  cacheRead: number;
  output: number;
  /** Dollars the provider priced the turn at, when it said; null leaves it to the price table. */
  costUsd?: number | null;
}

/**
 * Every usage row, one per call. Pi's own file lists each call, so a thread
 * with calls from there counts those, and its sandy turn events only count as
 * turns (their tokens would add one call per turn on top).
 */
const CALLS = `(
  SELECT thread_id, created_at, 1 AS is_turn,
         CASE WHEN thread_id IN (SELECT thread_id FROM pi_calls) THEN 0 ELSE input END AS input,
         CASE WHEN thread_id IN (SELECT thread_id FROM pi_calls) THEN 0 ELSE cache_read END AS cache_read,
         CASE WHEN thread_id IN (SELECT thread_id FROM pi_calls) THEN 0 ELSE output END AS output
  FROM usage
  UNION ALL SELECT thread_id, created_at, 0, input, cache_read, output FROM pi_calls
  UNION ALL SELECT thread_id, created_at, 0, input, cache_read, output FROM subagent_calls
)`;

export function createStore(db: Database) {
  const insertLimitSample = db.prepare(
    `INSERT OR IGNORE INTO limit_samples
       (provider_id, account_key, label, kind, model, sampled_at, used_percent, resets_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectLimitSamples = db.prepare(
    `SELECT provider_id AS providerId, nullif(account_key, '') AS accountKey, label, kind, model,
            sampled_at AS sampledAt, used_percent AS usedPercent, resets_at AS resetsAt
     FROM limit_samples WHERE sampled_at >= ? ORDER BY sampled_at`,
  );
  const deleteLimitSamples = db.prepare(`DELETE FROM limit_samples WHERE sampled_at < ?`);
  const selectProviderSlots = db.prepare(
    // Bound numbers arrive as reals, so the slot is cast back to a whole number.
    `SELECT CAST((u.created_at - ?) / ? AS INTEGER) AS slot, sum(u.input + u.cache_read + u.output) AS total
     FROM (SELECT thread_id, created_at, input, cache_read, output FROM usage
       UNION ALL
       SELECT thread_id, created_at, input, cache_read, output FROM subagent_calls) u
       JOIN threads t ON t.thread_id = u.thread_id
     WHERE t.provider_id = ? AND u.created_at >= ? AND u.created_at < ?
     GROUP BY slot`,
  );
  const recordLimits = db.transaction((samples: readonly LimitSample[]) => {
    for (const sample of samples) {
      insertLimitSample.run(
        sample.providerId,
        sample.accountKey ?? "",
        sample.label,
        sample.kind,
        sample.model,
        sample.sampledAt,
        sample.usedPercent,
        sample.resetsAt,
      );
    }
  });
  const selectProviderTokens = db.prepare(
    `SELECT coalesce(t.provider_id, '') AS providerId, sum(u.input + u.cache_read + u.output) AS total
     FROM (SELECT thread_id, created_at, input, cache_read, output FROM usage
       UNION ALL
       SELECT thread_id, created_at, input, cache_read, output FROM subagent_calls) u
       LEFT JOIN threads t ON t.thread_id = u.thread_id
     WHERE u.created_at >= ? AND u.created_at < ?
     GROUP BY t.provider_id`,
  );
  const insertUsage = db.prepare(
    `INSERT OR IGNORE INTO usage
       (event_id, thread_id, created_at, input, cache_read, output, running_total, model, host_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertThread = db.prepare(
    `INSERT INTO threads (thread_id, title, project_id, provider_id, last_seq, archived_at, host_id, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET
       title = excluded.title,
       project_id = excluded.project_id,
       provider_id = excluded.provider_id,
       last_seq = max(threads.last_seq, excluded.last_seq),
       archived_at = excluded.archived_at,
       host_id = coalesce(excluded.host_id, threads.host_id),
       model = coalesce(excluded.model, threads.model)`,
  );
  const fillHost = db.prepare(`UPDATE usage SET host_id = ? WHERE thread_id = ? AND host_id IS NULL`);
  const updateArchived = db.prepare(`UPDATE threads SET archived_at = ? WHERE thread_id = ?`);
  const selectThreadHours = db.prepare(
    `SELECT thread_id AS threadId, (created_at / ${HOUR_MS}) * ${HOUR_MS} AS hour,
            sum(input + cache_read + output) AS total
     FROM (SELECT thread_id, created_at, input, cache_read, output, 1 AS is_turn FROM usage
       UNION ALL
       SELECT thread_id, created_at, input, cache_read, output, 0 FROM subagent_calls) WHERE created_at >= ?
     GROUP BY thread_id, hour ORDER BY hour`,
  );
  // Calls of a thread Pi reported are priced from there; the rest from sandy's turn events.
  const selectTurnRows = db.prepare(
    `SELECT created_at AS at, host_id AS hostId, model, input, cache_read AS cacheRead, output, NULL AS costUsd
     FROM usage WHERE created_at >= ? AND thread_id NOT IN (SELECT thread_id FROM pi_calls)
     UNION ALL
     SELECT created_at, host_id, model, input, cache_read, output, cost_usd FROM pi_calls WHERE created_at >= ?
     ORDER BY 1`,
  );
  const selectCursor = db.prepare(`SELECT last_seq FROM threads WHERE thread_id = ?`);
  const selectArchived = db.prepare(`SELECT archived_at FROM threads WHERE thread_id = ?`);
  const selectMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const insertMeta = db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`);
  const selectHours = db.prepare(
    `SELECT (created_at / ${HOUR_MS}) * ${HOUR_MS} AS hour,
            sum(input) AS input, sum(cache_read) AS cacheRead, sum(output) AS output
     FROM ${CALLS} WHERE created_at >= ?
     GROUP BY hour ORDER BY hour`,
  );
  const selectThreads = db.prepare(
    `SELECT u.thread_id AS threadId, t.title AS title,
            coalesce(t.project_id, '') AS projectId, coalesce(t.provider_id, '') AS providerId,
            t.archived_at AS archivedAt,
            sum(u.input) AS input, sum(u.cache_read) AS cacheRead, sum(u.output) AS output,
            sum(u.is_turn) AS turns
     FROM ${CALLS} u LEFT JOIN threads t ON t.thread_id = u.thread_id
     WHERE u.created_at >= ?
     GROUP BY u.thread_id
     ORDER BY sum(u.input) + sum(u.cache_read) + sum(u.output) DESC`,
  );
  const selectThreadTotal = db.prepare(
    `SELECT coalesce(sum(input), 0) AS input, coalesce(sum(cache_read), 0) AS cacheRead,
            coalesce(sum(output), 0) AS output, count(*) AS turns,
            coalesce(max(running_total), 0) AS runningTotal
     FROM usage WHERE thread_id = ?`,
  );

  const selectRows = db.prepare(
    `SELECT at, input, cacheRead, output FROM (
       SELECT created_at AS at, input, cache_read AS cacheRead, output
       FROM ${CALLS} WHERE thread_id = ?
       ORDER BY created_at DESC LIMIT ?
     ) ORDER BY at`,
  );

  const insertContext = db.prepare(
    `INSERT OR IGNORE INTO context
       (event_id, thread_id, created_at, used_tokens, context_window, auto_compact_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectLatestContext = db.prepare(
    `SELECT event_id AS eventId, created_at AS createdAt, used_tokens AS usedTokens,
            context_window AS contextWindow, auto_compact_at AS autoCompactAt
     FROM context WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const selectLatestContexts = db.prepare(
    `SELECT c.thread_id AS threadId, c.used_tokens AS usedTokens FROM context c
     WHERE c.rowid = (SELECT rowid FROM context WHERE thread_id = c.thread_id
                      ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  );
  const selectActiveLatestContexts = db.prepare(
    `SELECT c.used_tokens AS usedTokens FROM context c JOIN threads t ON t.thread_id = c.thread_id
     WHERE t.archived_at IS NULL
       AND c.rowid = (SELECT rowid FROM context WHERE thread_id = c.thread_id
                      ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  );
  const selectActiveWithoutContext = db.prepare(
    `SELECT thread_id AS threadId FROM threads t
     WHERE t.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM context c WHERE c.thread_id = t.thread_id)`,
  );
  // A start and an end arrive in separate events, so each upsert keeps the
  // earliest start and the latest end it has seen.
  const upsertTurnTime = db.prepare(
    `INSERT INTO turn_times (thread_id, turn_id, started_at, completed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id, turn_id) DO UPDATE SET
       started_at = coalesce(min(turn_times.started_at, excluded.started_at), turn_times.started_at, excluded.started_at),
       completed_at = coalesce(max(turn_times.completed_at, excluded.completed_at), turn_times.completed_at, excluded.completed_at)`,
  );
  const upsertItemTime = db.prepare(
    `INSERT INTO item_times (thread_id, item_id, turn_id, kind, label, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, item_id) DO UPDATE SET
       turn_id = coalesce(item_times.turn_id, excluded.turn_id),
       label = coalesce(item_times.label, excluded.label),
       started_at = coalesce(min(item_times.started_at, excluded.started_at), item_times.started_at, excluded.started_at),
       completed_at = coalesce(max(item_times.completed_at, excluded.completed_at), item_times.completed_at, excluded.completed_at)`,
  );
  const upsertWait = db.prepare(
    `INSERT INTO waits (thread_id, interaction_id, turn_id, kind, started_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, interaction_id) DO UPDATE SET
       turn_id = coalesce(waits.turn_id, excluded.turn_id),
       started_at = min(waits.started_at, excluded.started_at),
       resolved_at = coalesce(max(waits.resolved_at, excluded.resolved_at), waits.resolved_at, excluded.resolved_at)`,
  );
  const recordTimings = db.transaction((threadId: string, rows: TimingRows) => {
    for (const turn of rows.turns) upsertTurnTime.run(threadId, turn.turnId, turn.startedAt, turn.completedAt);
    for (const item of rows.items) {
      upsertItemTime.run(threadId, item.itemId, item.turnId, item.kind, item.label, item.startedAt, item.completedAt);
    }
    for (const wait of rows.waits) {
      upsertWait.run(threadId, wait.interactionId, wait.turnId, wait.kind, wait.startedAt, wait.resolvedAt);
    }
  });
  const selectTurnTimes = db.prepare(
    `SELECT turn_id AS turnId, started_at AS startedAt, completed_at AS completedAt
     FROM turn_times WHERE thread_id = ? ORDER BY started_at`,
  );
  const selectItemTimes = db.prepare(
    `SELECT item_id AS itemId, turn_id AS turnId, kind, label, started_at AS startedAt, completed_at AS completedAt
     FROM item_times WHERE thread_id = ? ORDER BY started_at`,
  );
  const selectWaits = db.prepare(
    `SELECT interaction_id AS interactionId, turn_id AS turnId, kind, started_at AS startedAt, resolved_at AS resolvedAt
     FROM waits WHERE thread_id = ? ORDER BY started_at`,
  );
  const recordContext = db.transaction((threadId: string, rows: ContextRow[]) => {
    let inserted = 0;
    for (const row of rows) {
      const result = insertContext.run(
        row.eventId,
        threadId,
        row.createdAt,
        row.usedTokens,
        row.contextWindow,
        row.autoCompactAt,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  });

  const selectSubagentTotal = db.prepare(
    `SELECT coalesce(sum(input), 0) AS input, coalesce(sum(cache_read), 0) AS cacheRead,
            coalesce(sum(output), 0) AS output, count(DISTINCT agent_id) AS agents
     FROM subagent_calls WHERE thread_id = ?`,
  );
  const selectTurnTimesSince = db.prepare(
    `SELECT thread_id AS threadId, started_at AS at, completed_at - started_at AS ms FROM turn_times
     WHERE started_at >= ? AND completed_at IS NOT NULL AND completed_at >= started_at
     ORDER BY started_at`,
  );
  const selectSubagentsSince = db.prepare(
    `SELECT thread_id AS threadId, count(DISTINCT agent_id) AS count,
            sum(input + cache_read + output) AS tokens
     FROM subagent_calls WHERE created_at >= ? GROUP BY thread_id`,
  );
  const selectPeakContextSince = db.prepare(
    `SELECT thread_id AS threadId, max(used_tokens) AS peak FROM context WHERE created_at >= ? GROUP BY thread_id`,
  );
  const selectWaitingSince = db.prepare(
    `SELECT thread_id AS threadId, count(*) AS count, sum(resolved_at - started_at) AS ms FROM waits
     WHERE started_at >= ? AND resolved_at IS NOT NULL GROUP BY thread_id`,
  );
  const selectCommandsSince = db.prepare(
    `SELECT thread_id AS threadId, label, completed_at - started_at AS ms FROM item_times
     WHERE kind = 'commandExecution' AND started_at >= ? AND completed_at IS NOT NULL AND label IS NOT NULL`,
  );
  // Turn ids are qualified with the thread's, so one TimingRows can hold every thread's turns.
  const selectTurnsSince = db.prepare(
    `SELECT thread_id || ':' || turn_id AS turnId, started_at AS startedAt, completed_at AS completedAt
     FROM turn_times WHERE started_at >= ?`,
  );
  const selectItemsSince = db.prepare(
    `SELECT i.item_id AS itemId, i.thread_id || ':' || i.turn_id AS turnId, i.kind, i.label,
            i.started_at AS startedAt, i.completed_at AS completedAt
     FROM item_times i JOIN turn_times t ON t.thread_id = i.thread_id AND t.turn_id = i.turn_id
     WHERE t.started_at >= ?`,
  );
  const selectWaitsSince = db.prepare(
    `SELECT w.interaction_id AS interactionId, w.thread_id || ':' || w.turn_id AS turnId, w.kind,
            w.started_at AS startedAt, w.resolved_at AS resolvedAt
     FROM waits w JOIN turn_times t ON t.thread_id = w.thread_id AND t.turn_id = w.turn_id
     WHERE t.started_at >= ?`,
  );
  const selectClaudeCode = db.prepare(`SELECT thread_id FROM threads WHERE provider_id = 'claude-code'`);
  const selectSessionId = db.prepare(`SELECT session_id FROM threads WHERE thread_id = ?`);
  const updateSessionId = db.prepare(`UPDATE threads SET session_id = ? WHERE thread_id = ?`);
  const selectOffsets = db.prepare(`SELECT path, offset FROM subagent_files WHERE thread_id = ?`);
  const upsertFile = db.prepare(
    `INSERT INTO subagent_files (path, thread_id, agent_id, description, offset) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET offset = excluded.offset,
       description = coalesce(excluded.description, subagent_files.description)`,
  );
  const upsertCall = db.prepare(
    `INSERT INTO subagent_calls (thread_id, agent_id, message_id, created_at, input, cache_read, output)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, message_id) DO UPDATE SET
       input = excluded.input, cache_read = excluded.cache_read, output = excluded.output`,
  );
  const insertPiCall = db.prepare(
    `INSERT OR IGNORE INTO pi_calls
       (call_key, thread_id, host_id, created_at, model, input, cache_read, output, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectPiThreads = db.prepare(
    `SELECT t.thread_id AS threadId, t.host_id AS hostId FROM threads t
     WHERE t.provider_id = 'pi' AND t.thread_id IN (SELECT thread_id FROM usage WHERE created_at >= ?)`,
  );
  const selectPiCalls = db.prepare(
    `SELECT created_at AS at, host_id AS hostId, model, input, cache_read AS cacheRead, output, cost_usd AS costUsd
     FROM pi_calls WHERE created_at >= ? ORDER BY created_at`,
  );
  const selectPiHost = db.prepare(`SELECT host_id FROM threads WHERE thread_id = ? AND provider_id = 'pi'`);
  const recordPiCalls = db.transaction((threadId: string, hostId: string | null, calls: PiCall[]) => {
    let added = 0;
    for (const call of calls) {
      const result = insertPiCall.run(call.key, threadId, hostId, call.createdAt, call.model, call.input, call.cacheRead, call.output, call.costUsd);
      added += Number(result.changes);
    }
    return added;
  });
  const recordSubagents = db.transaction((threadId: string, reads: TranscriptRead[]) => {
    let calls = 0;
    for (const read of reads) {
      for (const call of read.calls) {
        upsertCall.run(threadId, read.agentId, call.messageId, call.createdAt, call.input, call.cacheRead, call.output);
        calls += 1;
      }
      upsertFile.run(read.path, threadId, read.agentId, read.description, read.offset);
    }
    return calls;
  });

  const record = db.transaction((thread: ThreadInfo, rows: UsageRow[], lastSeq: number) => {
    let inserted = 0;
    for (const row of rows) {
      const result = insertUsage.run(
        row.eventId,
        thread.threadId,
        row.createdAt,
        row.tokens.input,
        row.tokens.cacheRead,
        row.tokens.output,
        row.runningTotal,
        thread.model ?? null,
        thread.hostId ?? null,
      );
      inserted += Number(result.changes);
    }
    upsertThread.run(thread.threadId, thread.title, thread.projectId, thread.providerId, lastSeq, thread.archivedAt, thread.hostId ?? null, thread.model ?? null);
    // Rows stored before the host was known get it now.
    if (thread.hostId) fillHost.run(thread.hostId, thread.threadId);
    return inserted;
  });

  const selectStamps = db.prepare(
    `SELECT event_id AS eventId, model, host_id AS hostId FROM usage WHERE thread_id = ? ORDER BY created_at`,
  );

  return {
    /** Which model and host each recorded turn of the thread is attributed to. */
    stamps(threadId: string): Array<{ eventId: string; model: string | null; hostId: string | null }> {
      return selectStamps.all(threadId) as Array<{ eventId: string; model: string | null; hostId: string | null }>;
    },

    /** The last event sequence read for this thread, or null if never read. */
    cursor(threadId: string): number | null {
      const row = selectCursor.get(threadId) as { last_seq: number } | undefined;
      return row?.last_seq ?? null;
    },

    /** Stores new usage rows and moves the thread's cursor. Returns rows added. */
    record(thread: ThreadInfo, rows: UsageRow[], lastSeq: number): number {
      return record(thread, rows, lastSeq);
    },

    /** How long each finished turn that started since `since` took, by thread. */
    turnTimesSince(since: number): Map<string, Array<{ at: number; ms: number }>> {
      const byThread = new Map<string, Array<{ at: number; ms: number }>>();
      const rows = selectTurnTimesSince.all(since) as Array<{ threadId: string; at: number; ms: number }>;
      for (const { threadId, at, ms } of rows) {
        byThread.set(threadId, [...(byThread.get(threadId) ?? []), { at, ms }]);
      }
      return byThread;
    },

    /** Each thread's subagents and their tokens since `since`. */
    subagentsSince(since: number): Map<string, { count: number; tokens: number }> {
      const rows = selectSubagentsSince.all(since) as Array<{ threadId: string; count: number; tokens: number }>;
      return new Map(rows.map((row) => [row.threadId, { count: row.count, tokens: row.tokens }]));
    },

    /** Each thread's largest context since `since`. */
    peakContextsSince(since: number): Map<string, number> {
      const rows = selectPeakContextSince.all(since) as Array<{ threadId: string; peak: number }>;
      return new Map(rows.map((row) => [row.threadId, row.peak]));
    },

    /** How many questions each thread asked you since `since`, and how long the answers took. */
    waitingSince(since: number): Map<string, { count: number; ms: number }> {
      const rows = selectWaitingSince.all(since) as Array<{ threadId: string; count: number; ms: number }>;
      return new Map(rows.map((row) => [row.threadId, { count: row.count, ms: row.ms }]));
    },

    /** Every finished shell command since `since`, with its command line and how long it ran. */
    commandsSince(since: number): Array<{ threadId: string; label: string; ms: number }> {
      return selectCommandsSince.all(since) as Array<{ threadId: string; label: string; ms: number }>;
    },

    claudeCodeThreads(): string[] {
      return (selectClaudeCode.all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },

    /** Records the calls Pi's session file lists. A call already recorded, even under another thread, is left as it is. Returns the calls added. */
    recordPiCalls(threadId: string, hostId: string | null, calls: PiCall[]): number {
      return recordPiCalls(threadId, hostId, calls);
    },

    /** Pi threads with a turn since `since`, and the host each runs on. */
    piThreadsSince(since: number): Array<{ threadId: string; hostId: string | null }> {
      return selectPiThreads.all(since) as Array<{ threadId: string; hostId: string | null }>;
    },

    /** Only the calls read from Pi's session files, one row each. */
    piCallRowsSince(since: number): TurnRow[] {
      return selectPiCalls.all(since) as TurnRow[];
    },

    /** The host a Pi thread runs on, or null for another provider's thread or before the host is known. */
    piHost(threadId: string): string | null {
      return (selectPiHost.get(threadId) as { host_id: string | null } | undefined)?.host_id ?? null;
    },

    /** The Claude Code session id recorded for the thread, or null before one is known. */
    sessionId(threadId: string): string | null {
      const row = selectSessionId.get(threadId) as { session_id: string | null } | undefined;
      return row?.session_id ?? null;
    },

    setSessionId(threadId: string, sessionId: string): void {
      updateSessionId.run(sessionId, threadId);
    },

    /** How far into each of the thread's subagent transcripts the plugin has read. */
    subagentOffsets(threadId: string): Map<string, number> {
      const rows = selectOffsets.all(threadId) as Array<{ path: string; offset: number }>;
      return new Map(rows.map((row) => [row.path, row.offset]));
    },

    /** Stores subagent calls and how far each transcript was read. Returns the calls read. */
    recordSubagents(threadId: string, reads: TranscriptRead[]): number {
      return recordSubagents(threadId, reads);
    },

    /** Stores turn, tool, and wait times, merging a start and an end that arrived apart. */
    recordTimings(threadId: string, rows: TimingRows): void {
      recordTimings(threadId, rows);
    },

    /** Everything recorded about when the thread's turns ran. */
    /** Every thread's turns that started since, with their tools and waits. */
    timingsSince(since: number): TimingRows {
      return {
        turns: selectTurnsSince.all(since) as TimingRows["turns"],
        items: selectItemsSince.all(since) as TimingRows["items"],
        waits: selectWaitsSince.all(since) as TimingRows["waits"],
      };
    },
    threadTimings(threadId: string): TimingRows {
      return {
        turns: selectTurnTimes.all(threadId) as TimingRows["turns"],
        items: selectItemTimes.all(threadId) as TimingRows["items"],
        waits: selectWaits.all(threadId) as TimingRows["waits"],
      };
    },

    /** Stores new context rows. Returns rows added. */
    recordContext(threadId: string, rows: ContextRow[]): number {
      return recordContext(threadId, rows);
    },

    /** Active threads with no context recorded, such as those read before the plugin recorded context. */
    activeWithoutContext(): string[] {
      return (selectActiveWithoutContext.all() as Array<{ threadId: string }>).map((row) => row.threadId);
    },

    /** Each thread's latest recorded context size. */
    latestContexts(): Map<string, number> {
      const rows = selectLatestContexts.all() as Array<{ threadId: string; usedTokens: number }>;
      return new Map(rows.map((row) => [row.threadId, row.usedTokens]));
    },

    /** The latest recorded context size of each thread that is not archived or deleted. */
    activeLatestContexts(): number[] {
      return (selectActiveLatestContexts.all() as Array<{ usedTokens: number }>).map((row) => row.usedTokens);
    },

    /** The thread's latest recorded context size, or null before any. */
    latestContext(threadId: string): ContextRow | null {
      return (selectLatestContext.get(threadId) as ContextRow | undefined) ?? null;
    },

    /** When the ledger was first opened; set once, on the first call. */
    startedAt(now: number): number {
      insertMeta.run("started_at", String(now));
      const row = selectMeta.get("started_at") as { value: string };
      return Number(row.value);
    },

    /** Stores one reading of each limit window. */
    recordLimitSamples(samples: readonly LimitSample[]): void {
      recordLimits(samples);
    },

    limitSamplesSince(since: number): LimitSample[] {
      return selectLimitSamples.all(since) as LimitSample[];
    },

    pruneLimitSamples(before: number): void {
      deleteLimitSamples.run(before);
    },

    /** One provider's tokens in each `size` slot from `from` up to `to`, oldest first, subagents included. */
    providerSlots(providerId: string, from: number, to: number, size: number): number[] {
      const count = Math.max(0, Math.ceil((to - from) / size));
      const slots = Array.from({ length: count }, () => 0);
      const rows = selectProviderSlots.all(from, size, providerId, from, to) as Array<{ slot: number; total: number }>;
      for (const row of rows) if (row.slot >= 0 && row.slot < count) slots[row.slot] = row.total;
      return slots;
    },

    /** Each provider's tokens in [from, to), subagents included. */
    providerTokens(from: number, to: number): Map<string, number> {
      const rows = selectProviderTokens.all(from, to) as Array<{ providerId: string; total: number }>;
      return new Map(rows.map((row) => [row.providerId, row.total]));
    },

    /** Every recorded turn since `since` with the model and host it ran on, oldest first. Subagent calls are left out: they carry no model. */
    turnRowsSince(since: number): TurnRow[] {
      return selectTurnRows.all(since, since) as TurnRow[];
    },

    hoursSince(since: number): HourUsage[] {
      return selectHours.all(since) as HourUsage[];
    },

    threadsSince(since: number): ThreadUsage[] {
      return selectThreads.all(since) as ThreadUsage[];
    },

    /** Each thread's tokens per hour since `since`, for the page's sparklines. */
    threadHoursSince(since: number): ThreadHour[] {
      return selectThreadHours.all(since) as ThreadHour[];
    },

    /** True when the thread was archived or deleted, as last recorded. */
    isArchived(threadId: string): boolean {
      const row = selectArchived.get(threadId) as { archived_at: number | null } | undefined;
      return row?.archived_at != null;
    },

    /** Marks a thread archived or deleted at `at`, or active again when null. */
    setArchived(threadId: string, at: number | null): void {
      updateArchived.run(at, threadId);
    },

    /** The thread's most recent usage rows, oldest first. */
    threadRows(threadId: string, limit: number): UsageAt[] {
      return selectRows.all(threadId, limit) as UsageAt[];
    },

    threadTotal(threadId: string): ThreadTotal {
      const row = selectThreadTotal.get(threadId) as Tokens & {
        turns: number;
        runningTotal: number;
      };
      const own = addTokens(ZERO_TOKENS, row);
      const sub = selectSubagentTotal.get(threadId) as Tokens & { agents: number };
      const subagentTokens = addTokens(ZERO_TOKENS, sub);
      return {
        tokens: addTokens(own, subagentTokens),
        // The provider's running total covers only the thread's own turns.
        total: Math.max(totalOf(own), row.runningTotal) + totalOf(subagentTokens),
        turns: row.turns,
        subagents: { count: sub.agents, tokens: totalOf(subagentTokens) },
      };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
