// The delegation ledger: admission of children into the slots of a root, their binding to child threads,
// and the queue of inputs for idle children. The ledger is the only authority on delegation identity;
// thread metadata is a hint. Every check-then-write runs in one IMMEDIATE transaction, so it holds the
// DB write lock from the first read and concurrent admissions on one DB file cannot overshoot a limit.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createSnapshot, getAgent, THINKING_LEVELS, type ThinkingLevel } from "./catalog.ts";
import type { DelegateSettings } from "./settings.ts";

type Db = Database.Database;

export type DelegationKind = "delegate" | "workflow-worker";
export type DelegationState = "reserved" | "starting" | "active" | "idle" | "error" | "refused" | "stopped";

// reserved: admitted, spawn or delivery in flight; starting: bound to its child thread, not yet running;
// active: running. These hold a slot of the root; idle and the end states do not, except a row with an
// unconfirmed stop request (see listSlotHolders).
export const SLOT_STATES: readonly DelegationState[] = ["reserved", "starting", "active"];
export const END_STATES: readonly DelegationState[] = ["error", "refused", "stopped"];

// A state list as the inside of an SQL IN (...) list. The names are the constants' own, never user input.
export const sqlList = (states: readonly string[]): string => states.map((state) => `'${state}'`).join(", ");

// Moves allowed through transition(). idle -> reserved is not here: only readmit and admitNextQueued
// take a slot for an idle child, because they count the root's slots first.
const TRANSITIONS: Record<DelegationState, readonly DelegationState[]> = {
  reserved: ["starting", "active", "idle", "error", "refused", "stopped"],
  starting: ["active", "idle", "error", "refused", "stopped"],
  active: ["idle", "error", "refused", "stopped"],
  idle: ["error", "refused", "stopped"],
  error: [],
  refused: [],
  stopped: [],
};

export type DelegationRow = {
  delegationId: string;
  kind: DelegationKind;
  state: DelegationState;
  rootThreadId: string;
  parentThreadId: string;
  childThreadId: string | null;
  agent: string;
  agentVersion: number | null;
  snapshotHash: string | null;
  model: string | null;
  thinking: string | null;
  clientRequestId: string | null;
  inputHash: string;
  createdAt: number;
  updatedAt: number;
  boundAt: number | null;
  // The child's newest turn event seq when an input was last delivered to it; null: never.
  idleAfterSeq: number | null;
  // Bumped by every claim and settlement of a delivery; fences the active -> idle commit.
  deliveryGeneration: number;
  // The token of the readmission that moved the row to reserved; null otherwise.
  reservationOwner: string | null;
};

const DELEGATION_SELECT = `
  SELECT delegation_id AS delegationId, kind, state, root_thread_id AS rootThreadId,
    parent_thread_id AS parentThreadId, child_thread_id AS childThreadId, agent,
    agent_version AS agentVersion, snapshot_hash AS snapshotHash, model, thinking,
    client_request_id AS clientRequestId, input_hash AS inputHash, created_at AS createdAt,
    updated_at AS updatedAt, bound_at AS boundAt, idle_after_seq AS idleAfterSeq,
    delivery_generation AS deliveryGeneration, reservation_owner AS reservationOwner
  FROM delegations`;

export function getDelegation(db: Db, delegationId: string): DelegationRow | null {
  return (db.prepare(`${DELEGATION_SELECT} WHERE delegation_id = ?`).get(delegationId) as DelegationRow | undefined) ?? null;
}

export function getDelegationByChild(db: Db, childThreadId: string): DelegationRow | null {
  return (db.prepare(`${DELEGATION_SELECT} WHERE child_thread_id = ?`).get(childThreadId) as DelegationRow | undefined) ?? null;
}

// True when the thread is the parent (caller) of any delegation.
export function isDelegationParent(db: Db, threadId: string): boolean {
  return db.prepare("SELECT 1 FROM delegations WHERE parent_thread_id = ? LIMIT 1").get(threadId) !== undefined;
}

// The rows holding a slot of the root, oldest first: the rows in a slot state, and, whatever its state,
// every row with a stop request not confirmed yet (a refused child, or a stray spawn of a released
// reservation, may still run until SANDY confirms its stop) or with an open delivery (SANDY may still start a
// turn with the message; a stopped row's slot is held until the delivery closes and, when SANDY took it, the
// stop opened again by that is confirmed).
export function listSlotHolders(db: Db, rootThreadId: string): DelegationRow[] {
  return db
    .prepare(
      `${DELEGATION_SELECT} WHERE root_thread_id = ? AND (state IN (${sqlList(SLOT_STATES)})
         OR EXISTS (SELECT 1 FROM delegation_stops s WHERE s.delegation_id = delegations.delegation_id AND s.stopped_at IS NULL)
         OR EXISTS (SELECT 1 FROM delegation_deliveries d WHERE d.delegation_id = delegations.delegation_id AND d.state IN (${sqlList(OPEN_DELIVERY_STATES)})))
       ORDER BY created_at, rowid`,
    )
    .all(rootThreadId) as DelegationRow[];
}

// callerThreadId is the thread asking for the child; it becomes the row's parentThreadId and scopes
// clientRequestId. inputHash identifies the launch input, so a retried request is recognised.
// model/thinking override the catalog entry's defaults (kind "delegate"); a worker passes what it runs.
export type AdmitRequest = {
  rootThreadId: string;
  callerThreadId: string;
  kind: DelegationKind;
  agent: string;
  clientRequestId?: string;
  inputHash: string;
  model?: string;
  thinking?: ThinkingLevel;
};

export type AdmitRefusal =
  | { code: "nested_delegation"; callerThreadId: string; delegationId: string }
  | { code: "idempotency_conflict"; clientRequestId: string; delegationId: string }
  | { code: "unknown_agent"; agent: string }
  | { code: "model_not_allowed"; model: string; allowed: string[] }
  | { code: "limit_reached"; limit: number; running: DelegationRow[] };

export type AdmitResult = { ok: true; delegation: DelegationRow; reused: boolean } | { ok: false; refusal: AdmitRefusal };

type SlotLimit = Pick<DelegateSettings, "maxConcurrentChildren">;

// Admits a new child of the root into a slot, as a "reserved" row the caller then spawns and binds.
// Order: a caller that is itself a child is refused (depth 1); a known clientRequestId of this caller
// returns its delegation (same input) or a conflict (other input), whatever the root's slots are;
// a delegate's agent is resolved from the catalog and snapshotted; then the root's slots are counted.
export function admit(db: Db, request: AdmitRequest, settings: SlotLimit, now = Date.now()): AdmitResult {
  if (request.thinking !== undefined && !THINKING_LEVELS.includes(request.thinking)) {
    throw new Error(`thinking must be one of ${THINKING_LEVELS.join("|")}`);
  }
  return db
    .transaction((): AdmitResult => {
      const callerBinding = getDelegationByChild(db, request.callerThreadId);
      if (callerBinding !== null) {
        return { ok: false, refusal: { code: "nested_delegation", callerThreadId: request.callerThreadId, delegationId: callerBinding.delegationId } };
      }
      if (request.clientRequestId !== undefined) {
        const earlier = db
          .prepare(`${DELEGATION_SELECT} WHERE parent_thread_id = ? AND client_request_id = ?`)
          .get(request.callerThreadId, request.clientRequestId) as DelegationRow | undefined;
        if (earlier !== undefined) {
          if (earlier.inputHash === request.inputHash) return { ok: true, delegation: earlier, reused: true };
          return { ok: false, refusal: { code: "idempotency_conflict", clientRequestId: request.clientRequestId, delegationId: earlier.delegationId } };
        }
      }
      let launch = { agentVersion: null as number | null, snapshotHash: null as string | null, model: request.model ?? null, thinking: request.thinking ?? null as string | null };
      if (request.kind === "delegate") {
        const entry = getAgent(db, request.agent);
        if (entry === null) return { ok: false, refusal: { code: "unknown_agent", agent: request.agent } };
        const allowed = [entry.model, ...(entry.models ?? []).filter((model) => model !== entry.model)];
        if (request.model !== undefined && !allowed.includes(request.model)) {
          return { ok: false, refusal: { code: "model_not_allowed", model: request.model, allowed } };
        }
        const snapshot = createSnapshot(db, entry, now);
        launch = { agentVersion: entry.version, snapshotHash: snapshot.snapshotHash, model: request.model ?? entry.model, thinking: request.thinking ?? entry.thinking };
      }
      const running = listSlotHolders(db, request.rootThreadId);
      if (running.length >= settings.maxConcurrentChildren) {
        return { ok: false, refusal: { code: "limit_reached", limit: settings.maxConcurrentChildren, running } };
      }
      const delegationId = `dlg_${randomUUID()}`;
      db.prepare(
        `INSERT INTO delegations (delegation_id, kind, state, root_thread_id, parent_thread_id, child_thread_id, agent,
           agent_version, snapshot_hash, model, thinking, client_request_id, input_hash, created_at, updated_at, bound_at)
         VALUES (?, ?, 'reserved', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        delegationId, request.kind, request.rootThreadId, request.callerThreadId, request.agent,
        launch.agentVersion, launch.snapshotHash, launch.model, launch.thinking, request.clientRequestId ?? null,
        request.inputHash, now, now,
      );
      return { ok: true, delegation: getDelegation(db, delegationId)!, reused: false };
    })
    .immediate();
}

export type TransitionResult = { ok: true; delegation: DelegationRow } | { ok: false; state: DelegationState | null };

// Compare-and-set of a delegation's state along TRANSITIONS; { ok: false, state } names the state that
// did not allow the move (null: unknown id). Moving to an end state cancels the child's queued inputs and
// the admitted ones no delivery has claimed yet (nothing of them reached SANDY).
// A move out of a slot state frees a slot (unless the row has an unconfirmed stop request): the caller
// then runs admitNextQueued for the root.
export function transition(db: Db, delegationId: string, to: DelegationState, now = Date.now()): TransitionResult {
  return db
    .transaction((): TransitionResult => {
      const row = getDelegation(db, delegationId);
      if (row === null) return { ok: false, state: null };
      if (!TRANSITIONS[row.state].includes(to)) return { ok: false, state: row.state };
      db.prepare("UPDATE delegations SET state = ?, updated_at = ? WHERE delegation_id = ?").run(to, now, delegationId);
      if (END_STATES.includes(to)) {
        db.prepare("UPDATE pending_inputs SET state = 'cancelled', updated_at = ? WHERE delegation_id = ? AND state IN ('queued', 'admitted')").run(now, delegationId);
      }
      return { ok: true, delegation: getDelegation(db, delegationId)! };
    })
    .immediate();
}

// Binds a reserved delegation to the child thread its spawn returned and moves it to "starting".
export function bindChild(db: Db, delegationId: string, childThreadId: string, now = Date.now()): TransitionResult {
  return db
    .transaction((): TransitionResult => {
      const row = getDelegation(db, delegationId);
      if (row === null) return { ok: false, state: null };
      if (row.state !== "reserved" || row.childThreadId !== null) return { ok: false, state: row.state };
      db.prepare("UPDATE delegations SET state = 'starting', child_thread_id = ?, bound_at = ?, updated_at = ? WHERE delegation_id = ?")
        .run(childThreadId, now, now, delegationId);
      return { ok: true, delegation: getDelegation(db, delegationId)! };
    })
    .immediate();
}

// Why the plugin stops a child thread. no_ack: no valid policy ack within the watchdog window;
// unbound_spawn: the thread sandy_delegate's spawn returned, when its reservation was released or bound to
// another thread meanwhile; unmarked: the child's first turn started without the delegate marker, so it
// ran without the extension's gate; turn_no_ack: a turn of the child started without an ack recorded for it
// (see advanceTurns in watchdog.ts); parent_stop: the parent called sandy_delegate_stop.
export type StopReason = "no_ack" | "unbound_spawn" | "unmarked" | "turn_no_ack" | "parent_stop";

// A failed or unconfirmed stop is retried after 1 s, 2 s, 4 s, ... capped at this many ms (and at the
// watchdog window); it is never given up.
export const STOP_RETRY_CAP_MS = 5 * 60_000;

export function stopRetryDelayMs(attempts: number, windowMs: number): number {
  return Math.min(STOP_RETRY_CAP_MS, windowMs, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 30));
}

// stoppedAt: when SANDY confirmed the stop; until then the request is open. nextAttemptAt: the earliest
// time of the next attempt after a failed one (null: due now).
export type StopRequest = {
  childThreadId: string;
  delegationId: string;
  reason: StopReason;
  requestedAt: number;
  stoppedAt: number | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
};

const STOP_SELECT = `
  SELECT child_thread_id AS childThreadId, delegation_id AS delegationId, reason, requested_at AS requestedAt,
    stopped_at AS stoppedAt, attempts, last_error AS lastError, next_attempt_at AS nextAttemptAt
  FROM delegation_stops`;

// Records that the child thread must be stopped; the watchdog sweep carries it out. Idempotent per thread.
export function requestStop(db: Db, childThreadId: string, delegationId: string, reason: StopReason, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO delegation_stops (child_thread_id, delegation_id, reason, requested_at) VALUES (?, ?, ?, ?)")
    .run(childThreadId, delegationId, reason, now);
}

export function getStopRequest(db: Db, childThreadId: string): StopRequest | null {
  return (db.prepare(`${STOP_SELECT} WHERE child_thread_id = ?`).get(childThreadId) as StopRequest | undefined) ?? null;
}

// Stop requests not confirmed yet whose next attempt is due, oldest first.
export function dueStopRequests(db: Db, now: number): StopRequest[] {
  return db
    .prepare(`${STOP_SELECT} WHERE stopped_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY requested_at, rowid`)
    .all(now) as StopRequest[];
}

// SANDY confirmed the stop: the thread is no longer running (or is gone). Closes the request.
export function markStopConfirmed(db: Db, childThreadId: string, now = Date.now()): void {
  db.prepare("UPDATE delegation_stops SET stopped_at = ?, attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL WHERE child_thread_id = ? AND stopped_at IS NULL")
    .run(now, childThreadId);
}

// The stop call failed or SANDY could not confirm it: the request stays open, its next attempt is backed off.
export function markStopFailed(db: Db, childThreadId: string, error: string, windowMs: number, now = Date.now()): void {
  db.transaction(() => {
    const request = getStopRequest(db, childThreadId);
    if (request === null || request.stoppedAt !== null) return;
    const attempts = request.attempts + 1;
    db.prepare("UPDATE delegation_stops SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE child_thread_id = ?")
      .run(attempts, error, now + stopRetryDelayMs(attempts, windowMs), childThreadId);
  }).immediate();
}

// True when a bound child has not acked within the window after its bind. Only "starting" is unacked:
// the first valid ack moves a delegation to "active".
export function ackOverdue(row: DelegationRow, windowMs: number, now: number): boolean {
  return row.state === "starting" && row.boundAt !== null && now - row.boundAt >= windowMs;
}

// The watchdog's refusal, compare-and-set: a delegation still unacked past its window becomes "refused"
// (its queued inputs are cancelled) and its child gets a stop request; the row keeps its slot until SANDY
// confirms the stop. null when the
// row was acked, ended or is not overdue by the time the write lock is held.
export function refuseUnacked(db: Db, delegationId: string, windowMs: number, now = Date.now()): DelegationRow | null {
  return db
    .transaction((): DelegationRow | null => {
      const row = getDelegation(db, delegationId);
      if (row === null || !ackOverdue(row, windowMs, now)) return null;
      const moved = transition(db, delegationId, "refused", now);
      if (!moved.ok) return null;
      requestStop(db, row.childThreadId!, delegationId, "no_ack", now);
      return moved.delegation;
    })
    .immediate();
}

// Records that agents.configure gave the thread the delegate marker; only the first grant is kept.
export function recordMarkerGrant(db: Db, threadId: string, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO delegation_markers (thread_id, granted_at) VALUES (?, ?)").run(threadId, now);
}

// When agents.configure first gave the thread the delegate marker; null when it never did.
export function markerGrantedAt(db: Db, threadId: string): number | null {
  return (db.prepare("SELECT granted_at AS grantedAt FROM delegation_markers WHERE thread_id = ?").get(threadId) as { grantedAt: number } | undefined)?.grantedAt ?? null;
}

// The refusal of a bound, unacked child that ran without the marker, compare-and-set on "still starting
// and bound to this thread": the row becomes "refused" and its child gets a stop request; the row keeps
// its slot until SANDY confirms the stop. null when the row was acked, ended or rebound meanwhile.
export function refuseUnmarked(db: Db, delegationId: string, childThreadId: string, now = Date.now()): DelegationRow | null {
  return db
    .transaction((): DelegationRow | null => {
      const row = getDelegation(db, delegationId);
      if (row === null || row.state !== "starting" || row.childThreadId !== childThreadId) return null;
      const moved = transition(db, delegationId, "refused", now);
      if (!moved.ok) return null;
      requestStop(db, childThreadId, delegationId, "unmarked", now);
      return moved.delegation;
    })
    .immediate();
}

// The refusal of a child with a turn that started without its ack, compare-and-set on "not ended and bound
// to this thread": the row becomes "refused" (its queued inputs are cancelled) and its child gets a stop
// request; the row keeps its slot until SANDY confirms the stop. null when it ended or was rebound meanwhile.
export function refuseTurnUnacked(db: Db, delegationId: string, childThreadId: string, now = Date.now()): DelegationRow | null {
  return db
    .transaction((): DelegationRow | null => {
      const row = getDelegation(db, delegationId);
      if (row === null || END_STATES.includes(row.state) || row.childThreadId !== childThreadId) return null;
      const moved = transition(db, delegationId, "refused", now);
      if (!moved.ok) return null;
      requestStop(db, childThreadId, delegationId, "turn_no_ack", now);
      return moved.delegation;
    })
    .immediate();
}

// A turn of a child the turn rule has not decided yet: its turn/started seq and time, and the time after
// which an ack counts for it (the child's previous turn event; null: no earlier turn).
export type OpenTurn = { seq: number; at: number; lowerAt: number | null };

// Where the turn rule stands in a child's turn events: the last event taken into account (seq, time) and
// the open turn. null seq: no event read yet.
export type TurnState = { checkedSeq: number | null; lastAt: number | null; open: OpenTurn | null };

// A delegation's row of delegation_turn_cursors (a default one, not stored yet, for a delegation bound
// after turn scanning was introduced that was never scanned).
export type TurnCursor = TurnState & {
  delegationId: string;
  childThreadId: string;
  // Bound before turn scanning was introduced and its history not read through yet: the first scan takes the child's newest
  // turn event seq (enforceFromSeq), later scans read the history from the first event on (see advanceTurns,
  // grandfatherThroughSeq) until they reach its end.
  baselinePending: boolean;
  enforceFromSeq: number | null;
  // Type of the turn event at checkedSeq (null: none read yet, or stored before the event type was recorded).
  lastEventType: "started" | "completed" | null;
  // When a scan last tried to list the child's events, whatever came of it (the round robin order).
  scannedAt: number | null;
};

// An ack of the delegation's child not yet matched to a turn.
export type UnmatchedAck = { nonce: string; ackedAt: number };

type TurnCursorDbRow = {
  delegationId: string; childThreadId: string; baselinePending: number; enforceFromSeq: number | null; checkedSeq: number | null;
  lastAt: number | null; openSeq: number | null; openAt: number | null; openLowerAt: number | null; scannedAt: number | null;
  lastEventType: "started" | "completed" | null;
};

export function getTurnCursor(db: Db, delegationId: string, childThreadId: string): TurnCursor {
  const row = db.prepare(`
    SELECT delegation_id AS delegationId, child_thread_id AS childThreadId, baseline_pending AS baselinePending,
      enforce_from_seq AS enforceFromSeq, checked_seq AS checkedSeq, last_at AS lastAt, open_seq AS openSeq,
      open_at AS openAt, open_lower_at AS openLowerAt, scanned_at AS scannedAt, last_event_type AS lastEventType
    FROM delegation_turn_cursors WHERE delegation_id = ? AND child_thread_id = ?`).get(delegationId, childThreadId) as TurnCursorDbRow | undefined;
  if (row === undefined) {
    return { delegationId, childThreadId, baselinePending: false, enforceFromSeq: null, checkedSeq: null, lastAt: null, open: null, scannedAt: null, lastEventType: null };
  }
  return {
    delegationId, childThreadId, baselinePending: row.baselinePending === 1, enforceFromSeq: row.enforceFromSeq,
    checkedSeq: row.checkedSeq, lastAt: row.lastAt, scannedAt: row.scannedAt, lastEventType: row.lastEventType,
    open: row.openSeq === null ? null : { seq: row.openSeq, at: row.openAt!, lowerAt: row.openLowerAt },
  };
}

// Up to limit bound, not ended delegations for one turn scan, with their cursors, a round robin over every
// bound child whatever its SANDY status. First at most priorityShare of the priority class (a baseline still
// pending, or an open turn whose window has run out), then the rest of the limit from every child not taken
// yet, priority or not; each part least recently attempted first (never attempted first). The scan sets
// scanned_at on every attempt, so no class of children, failing or not, can hold the others' share.
export function listTurnScanBatch(db: Db, windowMs: number, now: number, limit: number, priorityShare: number): { delegation: DelegationRow; cursor: TurnCursor }[] {
  const scannable = `
    SELECT d.delegation_id AS delegationId FROM delegations d
    LEFT JOIN delegation_turn_cursors c ON c.delegation_id = d.delegation_id
    WHERE d.kind = 'delegate' AND d.child_thread_id IS NOT NULL AND d.state NOT IN (${sqlList(END_STATES)})`;
  const leastRecentlyAttempted = "ORDER BY c.scanned_at IS NOT NULL, c.scanned_at, d.bound_at, d.rowid LIMIT ?";
  const priority = (db.prepare(`${scannable} AND (COALESCE(c.baseline_pending, 0) = 1 OR (c.open_at IS NOT NULL AND c.open_at + ? <= ?))
    ${leastRecentlyAttempted}`).all(windowMs, now, Math.min(priorityShare, limit)) as { delegationId: string }[]).map(({ delegationId }) => delegationId);
  const taken = new Set(priority);
  const rest = (db.prepare(`${scannable} ${leastRecentlyAttempted}`).all(limit) as { delegationId: string }[])
    .map(({ delegationId }) => delegationId).filter((delegationId) => !taken.has(delegationId)).slice(0, limit - priority.length);
  return [...priority, ...rest].map((delegationId) => {
    const delegation = getDelegation(db, delegationId)!;
    return { delegation, cursor: getTurnCursor(db, delegationId, delegation.childThreadId!) };
  });
}

// The child's acks not matched to a turn yet that were recorded after `after` (all when null), oldest first.
export function unmatchedAcks(db: Db, delegationId: string, childThreadId: string, after: number | null): UnmatchedAck[] {
  return db.prepare(`
    SELECT nonce, acked_at AS ackedAt FROM delegation_acks
    WHERE delegation_id = ? AND child_thread_id = ? AND acked_at IS NOT NULL AND turn_seq IS NULL AND acked_at > ?
    ORDER BY acked_at, nonce`).all(delegationId, childThreadId, after ?? Number.MIN_SAFE_INTEGER) as UnmatchedAck[];
}

// Stores a turn scan in one transaction: the cursor, and each matched ack's turn (once: an ack already
// matched to a turn is never matched again, the transaction fails instead).
export function saveTurnScan(db: Db, cursor: TurnCursor, matches: readonly { nonce: string; turnSeq: number }[]): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO delegation_turn_cursors (delegation_id, child_thread_id, baseline_pending, enforce_from_seq, checked_seq, last_at,
        open_seq, open_at, open_lower_at, scanned_at, last_event_type)
      VALUES (@delegationId, @childThreadId, @baselinePending, @enforceFromSeq, @checkedSeq, @lastAt, @openSeq, @openAt, @openLowerAt, @scannedAt, @lastEventType)
      ON CONFLICT (delegation_id) DO UPDATE SET child_thread_id = excluded.child_thread_id, baseline_pending = excluded.baseline_pending,
        enforce_from_seq = excluded.enforce_from_seq, checked_seq = excluded.checked_seq, last_at = excluded.last_at,
        open_seq = excluded.open_seq, open_at = excluded.open_at, open_lower_at = excluded.open_lower_at, scanned_at = excluded.scanned_at,
        last_event_type = excluded.last_event_type`)
      .run({
        delegationId: cursor.delegationId, childThreadId: cursor.childThreadId, baselinePending: cursor.baselinePending ? 1 : 0,
        enforceFromSeq: cursor.enforceFromSeq, checkedSeq: cursor.checkedSeq, lastAt: cursor.lastAt,
        openSeq: cursor.open?.seq ?? null, openAt: cursor.open?.at ?? null, openLowerAt: cursor.open?.lowerAt ?? null, scannedAt: cursor.scannedAt, lastEventType: cursor.lastEventType,
      });
    const match = db.prepare("UPDATE delegation_acks SET turn_seq = ? WHERE nonce = ? AND delegation_id = ? AND turn_seq IS NULL");
    for (const { nonce, turnSeq } of matches) {
      if (match.run(turnSeq, nonce, cursor.delegationId).changes !== 1) throw new Error(`ack ${nonce} is already matched to a turn`);
    }
  }).immediate();
}

// A wait-mode child is created with parentNotifications "off" and flipped back to "auto" when its wait
// ends. The mark is written before the child is silenced and removed once the flip to "auto" is confirmed,
// so a plugin process that died without flipping leaves it behind for the watchdog (restoreSilencedChildren).
export function markWaitSilenced(db: Db, delegationId: string, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO delegation_wait_marks (delegation_id, marked_at) VALUES (?, ?)").run(delegationId, now);
}

export function clearWaitSilenced(db: Db, delegationId: string): void {
  db.prepare("DELETE FROM delegation_wait_marks WHERE delegation_id = ?").run(delegationId);
}

// Marks of delegations that ended need no flip: nobody is left to wake.
export function dropEndedWaitMarks(db: Db): void {
  db.prepare(`DELETE FROM delegation_wait_marks WHERE delegation_id IN
    (SELECT delegation_id FROM delegations WHERE state IN (${sqlList(END_STATES)}))`).run();
}

// Marked, bound, not ended delegations, least recently attempted first.
export function listWaitMarked(db: Db): DelegationRow[] {
  const ids = db.prepare(`
    SELECT m.delegation_id AS id FROM delegation_wait_marks m
    JOIN delegations d ON d.delegation_id = m.delegation_id
    WHERE d.child_thread_id IS NOT NULL AND d.state NOT IN (${sqlList(END_STATES)})
    ORDER BY COALESCE(m.last_attempt_at, 0), m.marked_at, m.rowid`).all() as { id: string }[];
  return ids.map(({ id }) => getDelegation(db, id)!);
}

export function touchWaitMark(db: Db, delegationId: string, now = Date.now()): void {
  db.prepare("UPDATE delegation_wait_marks SET last_attempt_at = ? WHERE delegation_id = ?").run(now, delegationId);
}

// Releases a reservation whose spawn never bound and for which no thread exists: reserved -> error,
// compare-and-set on "still reserved and unbound". false when it was bound or moved meanwhile.
export function releaseReservation(db: Db, delegationId: string, now = Date.now()): boolean {
  return db
    .transaction((): boolean => {
      const row = getDelegation(db, delegationId);
      if (row === null || row.state !== "reserved" || row.childThreadId !== null) return false;
      return transition(db, delegationId, "error", now).ok;
    })
    .immediate();
}

// Reserved rows whose spawn has not bound a child yet, oldest first.
export function listUnboundReservations(db: Db): DelegationRow[] {
  return db
    .prepare(`${DELEGATION_SELECT} WHERE kind = 'delegate' AND state = 'reserved' AND child_thread_id IS NULL ORDER BY created_at, rowid`)
    .all() as DelegationRow[];
}

// Bound rows still waiting for their first ack, oldest bind first.
export function listUnacked(db: Db): DelegationRow[] {
  return db
    .prepare(`${DELEGATION_SELECT} WHERE kind = 'delegate' AND state = 'starting' AND child_thread_id IS NOT NULL ORDER BY bound_at, rowid`)
    .all() as DelegationRow[];
}


// Bound rows still waiting for their first ack at least the window after the bind.
export function listOverdueUnacked(db: Db, windowMs: number, now: number): DelegationRow[] {
  return db
    .prepare(`${DELEGATION_SELECT} WHERE kind = 'delegate' AND state = 'starting' AND bound_at IS NOT NULL AND bound_at <= ? ORDER BY bound_at, rowid`)
    .all(now - windowMs) as DelegationRow[];
}

export type PendingInputKind = "steer" | "queue" | "continuation" | "answer";
// delivering: a delivery claimed the input (see claimDelivery) and has not settled.
export type PendingInputState = "queued" | "admitted" | "delivering" | "delivered" | "cancelled";

export type PendingInput = {
  inputId: string;
  seq: number;
  delegationId: string;
  rootThreadId: string;
  kind: PendingInputKind;
  payload: unknown;
  state: PendingInputState;
  createdAt: number;
  updatedAt: number;
};

const PENDING_INPUT_SELECT = `
  SELECT input_id AS inputId, seq, delegation_id AS delegationId, root_thread_id AS rootThreadId, kind,
    payload_json AS payloadJson, state, created_at AS createdAt, updated_at AS updatedAt
  FROM pending_inputs`;

const pendingInputRow = (value: unknown): PendingInput => {
  const { payloadJson, ...row } = value as Omit<PendingInput, "payload"> & { payloadJson: string };
  return { ...row, payload: JSON.parse(payloadJson) };
};

export function getPendingInput(db: Db, inputId: string): PendingInput | null {
  const row = db.prepare(`${PENDING_INPUT_SELECT} WHERE input_id = ?`).get(inputId);
  return row === undefined ? null : pendingInputRow(row);
}

// The oldest queued input of the root, or null.
export function nextQueued(db: Db, rootThreadId: string): PendingInput | null {
  const row = db.prepare(`${PENDING_INPUT_SELECT} WHERE root_thread_id = ? AND state = 'queued' ORDER BY seq LIMIT 1`).get(rootThreadId);
  return row === undefined ? null : pendingInputRow(row);
}

export type ReadmitRequest = { delegationId: string; input: { kind: PendingInputKind; payload: unknown } };

export type ReadmitResult =
  // The idle child got a slot ("reserved"): deliver the input now. reservationOwner: the reservation's
  // token, handed to the delivery (see claimDelivery).
  | { ok: true; status: "admitted"; delegation: DelegationRow; reservationOwner: string }
  // The child already holds a slot: deliver the input now, no admission needed.
  | { ok: true; status: "holds_slot"; delegation: DelegationRow }
  // The root is full, or older inputs wait: the input waits in the ledger for admitNextQueued.
  | { ok: true; status: "queued"; pendingInput: PendingInput }
  | { ok: false; refusal: { code: "unknown_delegation" } | { code: "delegation_ended"; state: DelegationState } };

// Re-admits an idle child before an input makes it run again (steer/queue, kept-session continuation,
// a question's answer). An input queues behind the root's older queued inputs even when a slot is free,
// so inputs are delivered in arrival order.
export function readmit(db: Db, request: ReadmitRequest, settings: SlotLimit, now = Date.now()): ReadmitResult {
  return db
    .transaction((): ReadmitResult => {
      const row = getDelegation(db, request.delegationId);
      if (row === null) return { ok: false, refusal: { code: "unknown_delegation" } };
      if (SLOT_STATES.includes(row.state)) return { ok: true, status: "holds_slot", delegation: row };
      if (row.state !== "idle") return { ok: false, refusal: { code: "delegation_ended", state: row.state } };
      const full = listSlotHolders(db, row.rootThreadId).length >= settings.maxConcurrentChildren;
      if (full || nextQueued(db, row.rootThreadId) !== null) {
        const inputId = `inp_${randomUUID()}`;
        db.prepare(
          `INSERT INTO pending_inputs (input_id, delegation_id, root_thread_id, kind, payload_json, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(inputId, row.delegationId, row.rootThreadId, request.input.kind, JSON.stringify(request.input.payload ?? null), now, now);
        return { ok: true, status: "queued", pendingInput: getPendingInput(db, inputId)! };
      }
      const reservationOwner = reserveIdle(db, row.delegationId, now);
      return { ok: true, status: "admitted", delegation: getDelegation(db, row.delegationId)!, reservationOwner };
    })
    .immediate();
}

// Stores an input readmit admitted at once (admitted, holds_slot) as an admitted pending input, so its
// delivery is claimed against it: a failed or lost delivery queues it again and a process lost before the
// claim leaves it to the drain. Used for question answers, which must reach the child.
export function recordAdmittedInput(db: Db, delegationId: string, input: ReadmitRequest["input"], now = Date.now()): PendingInput {
  const row = getDelegation(db, delegationId)!;
  const inputId = `inp_${randomUUID()}`;
  db.prepare(
    `INSERT INTO pending_inputs (input_id, delegation_id, root_thread_id, kind, payload_json, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'admitted', ?, ?)`,
  ).run(inputId, delegationId, row.rootThreadId, input.kind, JSON.stringify(input.payload ?? null), now, now);
  return getPendingInput(db, inputId)!;
}

// Takes the root's oldest queued input if its child can run: an idle child needs a free slot and is
// moved to "reserved", a child already holding a slot takes it as is. The input becomes "admitted";
// its delivery settles it. Inputs of ended children are cancelled on the way. null: nothing queued, or the
// root is full. reservationOwner: the token of the reservation taken for an idle child, null when the
// child held its slot.
export function admitNextQueued(
  db: Db,
  rootThreadId: string,
  settings: SlotLimit,
  now = Date.now(),
): { pendingInput: PendingInput; delegation: DelegationRow; reservationOwner: string | null } | null {
  return db
    .transaction(() => {
      for (let head = nextQueued(db, rootThreadId); head !== null; head = nextQueued(db, rootThreadId)) {
        const row = getDelegation(db, head.delegationId)!;
        if (END_STATES.includes(row.state)) {
          db.prepare("UPDATE pending_inputs SET state = 'cancelled', updated_at = ? WHERE input_id = ?").run(now, head.inputId);
          continue;
        }
        let reservationOwner: string | null = null;
        if (row.state === "idle") {
          if (listSlotHolders(db, rootThreadId).length >= settings.maxConcurrentChildren) return null;
          reservationOwner = reserveIdle(db, row.delegationId, now);
        }
        db.prepare("UPDATE pending_inputs SET state = 'admitted', updated_at = ? WHERE input_id = ?").run(now, head.inputId);
        return { pendingInput: getPendingInput(db, head.inputId)!, delegation: getDelegation(db, row.delegationId)!, reservationOwner };
      }
      return null;
    })
    .immediate();
}

// idle -> reserved for a readmission; returns the reservation's owner token. The caller counted the slots.
function reserveIdle(db: Db, delegationId: string, now: number): string {
  const reservationOwner = `rsv_${randomUUID()}`;
  db.prepare("UPDATE delegations SET state = 'reserved', reservation_owner = ?, updated_at = ? WHERE delegation_id = ?").run(reservationOwner, now, delegationId);
  return reservationOwner;
}

// One message handed to SANDY's thread send. Open while sending or unknown (no definitive
// answer from SANDY yet) or queued (SANDY holds it behind a running turn and no turn of the child has started
// with it yet; the turn that does closes it as sent).
export type DeliveryState = "sending" | "sent" | "queued" | "rejected" | "unknown" | "lost";
export const UNANSWERED_DELIVERY_STATES: readonly DeliveryState[] = ["sending", "unknown"];
export const OPEN_DELIVERY_STATES: readonly DeliveryState[] = ["sending", "unknown", "queued"];

export type Delivery = {
  deliveryId: string;
  delegationId: string;
  inputId: string | null;
  generation: number;
  reservationOwner: string | null;
  afterSeq: number | null;
  state: DeliveryState;
  startedAt: number;
  settledAt: number | null;
};

const DELIVERY_SELECT = `
  SELECT delivery_id AS deliveryId, delegation_id AS delegationId, input_id AS inputId, generation,
    reservation_owner AS reservationOwner, after_seq AS afterSeq, state, started_at AS startedAt, settled_at AS settledAt
  FROM delegation_deliveries`;

export function getDelivery(db: Db, deliveryId: string): Delivery | null {
  return (db.prepare(`${DELIVERY_SELECT} WHERE delivery_id = ?`).get(deliveryId) as Delivery | undefined) ?? null;
}

// Open deliveries (sending, unknown, queued), oldest first.
export function listOpenDeliveries(db: Db): Delivery[] {
  return db.prepare(`${DELIVERY_SELECT} WHERE state IN ('sending', 'unknown', 'queued') ORDER BY started_at, rowid`).all() as Delivery[];
}

// True when a delivery of the delegation has no definitive answer from SANDY yet (sending, unknown).
export function hasUnansweredDelivery(db: Db, delegationId: string): boolean {
  return db.prepare(`SELECT 1 FROM delegation_deliveries WHERE delegation_id = ? AND state IN (${sqlList(UNANSWERED_DELIVERY_STATES)}) LIMIT 1`).get(delegationId) !== undefined;
}

// The delegation's queued deliveries (SANDY holds the message behind a turn, no turn took it yet), oldest first.
export function listQueuedDeliveries(db: Db, delegationId: string): Delivery[] {
  return db.prepare(`${DELIVERY_SELECT} WHERE delegation_id = ? AND state = 'queued' ORDER BY generation`).all(delegationId) as Delivery[];
}

export type DeliveryClaimRequest = { delegationId: string; inputId: string | null; reservationOwner: string | null; afterSeq: number | null };

export type DeliveryClaim =
  | { ok: true; delivery: Delivery }
  // ended: the row ended (the input is cancelled); no_slot: the row no longer holds a slot (the input is
  // queued again); input_taken: the input is no longer admitted (another delivery or a stop took it).
  | { ok: false; reason: "ended" | "no_slot" | "input_taken" };

// Claims a delivery immediately before SANDY's send, in one transaction: the row must hold a slot, the input
// (if any) moves admitted -> delivering (compare-and-set), the row's delivery generation is bumped and
// idle_after_seq set to afterSeq (only a turn completed above it counts as the child going idle again),
// and a "sending" delivery is recorded.
export function claimDelivery(db: Db, request: DeliveryClaimRequest, now = Date.now()): DeliveryClaim {
  return db
    .transaction((): DeliveryClaim => {
      const row = getDelegation(db, request.delegationId);
      if (row === null || END_STATES.includes(row.state)) {
        if (request.inputId !== null) cancelInput(db, request.inputId, now);
        return { ok: false, reason: "ended" };
      }
      if (!SLOT_STATES.includes(row.state)) {
        if (request.inputId !== null) setInputState(db, request.inputId, "admitted", "queued", now);
        return { ok: false, reason: "no_slot" };
      }
      if (request.inputId !== null && !setInputState(db, request.inputId, "admitted", "delivering", now)) return { ok: false, reason: "input_taken" };
      const generation = row.deliveryGeneration + 1;
      db.prepare("UPDATE delegations SET delivery_generation = ?, idle_after_seq = ?, updated_at = ? WHERE delegation_id = ?").run(generation, request.afterSeq, now, row.delegationId);
      const deliveryId = `dlv_${randomUUID()}`;
      db.prepare(
        `INSERT INTO delegation_deliveries (delivery_id, delegation_id, input_id, generation, reservation_owner, after_seq, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`,
      ).run(deliveryId, row.delegationId, request.inputId, generation, request.reservationOwner, request.afterSeq, now);
      return { ok: true, delivery: getDelivery(db, deliveryId)! };
    })
    .immediate();
}

// sent/queued: SANDY took the message (SANDY's answer, or a turn of the child started after it). rejected: a
// definitive 4xx. gone: SANDY 404, the thread no longer exists. unknown: no definitive answer. lost: no
// turn came of an unknown delivery within the settle window.
export type DeliveryOutcome = "sent" | "queued" | "rejected" | "gone" | "unknown" | "lost";

const settledState: Record<Exclude<DeliveryOutcome, "unknown">, DeliveryState> = { sent: "sent", queued: "queued", rejected: "rejected", gone: "rejected", lost: "lost" };

// Settles an open delivery, in one transaction (false when it was not open; a queued one only as sent,
// lost or gone). Taken (sent/queued): the input is delivered, a reserved row becomes active whatever
// readmission reserved it (so does a row that went idle while this delivery had no answer), and a row that
// ended meanwhile gets its stop request opened again (the message may have started a turn after the stop
// was confirmed). rejected: the input is cancelled. gone: the row is an error. lost: the input is queued
// again (cancelled when the row ended). After rejected or lost, once no delivery of the delegation is left
// without an answer, a row still reserved by a delivery that was rejected or lost goes back to idle (never a
// reservation no delivery has claimed yet). unknown: the delivery stays open, its slot held.
export function settleDelivery(db: Db, deliveryId: string, outcome: DeliveryOutcome, now = Date.now()): boolean {
  return db
    .transaction((): boolean => {
      const delivery = getDelivery(db, deliveryId);
      if (delivery === null) return false;
      const unanswered = UNANSWERED_DELIVERY_STATES.includes(delivery.state);
      if (!unanswered && !(delivery.state === "queued" && (outcome === "sent" || outcome === "lost" || outcome === "gone"))) return false;
      if (outcome === "unknown") {
        db.prepare("UPDATE delegation_deliveries SET state = 'unknown' WHERE delivery_id = ?").run(deliveryId);
        return true;
      }
      db.prepare("UPDATE delegation_deliveries SET state = ?, settled_at = ? WHERE delivery_id = ?").run(settledState[outcome], now, deliveryId);
      db.prepare("UPDATE delegations SET delivery_generation = delivery_generation + 1, updated_at = ? WHERE delegation_id = ?").run(now, delivery.delegationId);
      const row = getDelegation(db, delivery.delegationId)!;
      const ended = END_STATES.includes(row.state);
      const undoFailedReservation = () => {
        db.prepare(
          `UPDATE delegations SET state = 'idle', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state = 'reserved'
             AND NOT EXISTS (SELECT 1 FROM delegation_deliveries d WHERE d.delegation_id = delegations.delegation_id AND d.state IN (${sqlList(UNANSWERED_DELIVERY_STATES)}))
             AND EXISTS (SELECT 1 FROM delegation_deliveries d WHERE d.delegation_id = delegations.delegation_id AND d.reservation_owner = delegations.reservation_owner AND d.state IN ('rejected', 'lost'))`,
        ).run(now, row.delegationId);
      };
      if (outcome === "sent" || outcome === "queued") {
        if (delivery.inputId !== null) setInputState(db, delivery.inputId, "delivering", "delivered", now);
        db.prepare(`UPDATE delegations SET state = 'active', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state IN (${unanswered ? "'reserved', 'idle'" : "'reserved'"})`).run(now, row.delegationId);
        if (ended && row.childThreadId !== null) {
          requestStop(db, row.childThreadId, row.delegationId, "parent_stop", now);
          db.prepare("UPDATE delegation_stops SET stopped_at = NULL, next_attempt_at = NULL WHERE child_thread_id = ?").run(row.childThreadId);
        }
      } else if (outcome === "rejected") {
        if (delivery.inputId !== null) setInputState(db, delivery.inputId, "delivering", "cancelled", now);
        undoFailedReservation();
      } else if (outcome === "gone") {
        if (delivery.inputId !== null) setInputState(db, delivery.inputId, "delivering", "cancelled", now);
        if (!ended) transition(db, row.delegationId, "error", now);
      } else {
        if (delivery.inputId !== null) setInputState(db, delivery.inputId, "delivering", ended ? "cancelled" : "queued", now);
        undoFailedReservation();
      }
      return true;
    })
    .immediate();
}

// Undoes an admission whose delivery never reached SANDY's send (no delivery was claimed): the input goes
// back to the queue, the reservation (if this one's) back to idle.
export function releaseUnsent(db: Db, delegationId: string, inputId: string | null, reservationOwner: string | null, now = Date.now()): void {
  db.transaction(() => {
    if (inputId !== null) setInputState(db, inputId, "admitted", "queued", now);
    if (reservationOwner !== null) moveReservedToIdle(db, delegationId, reservationOwner, now);
  }).immediate();
}

function setInputState(db: Db, inputId: string, from: PendingInputState, to: PendingInputState, now: number): boolean {
  return db.prepare("UPDATE pending_inputs SET state = ?, updated_at = ? WHERE input_id = ? AND state = ?").run(to, now, inputId, from).changes === 1;
}

// active -> idle, compare-and-set on the state and on the delivery generation the caller read before its
// checks (a delivery claimed or settled since then fails it), with no delivery open (queued included): the
// child's last turn is completed and SANDY shows no running turn. Frees the slot; the caller then runs the root's queue.
export function moveActiveToIdle(db: Db, delegationId: string, generation: number, now = Date.now()): boolean {
  return db.prepare(
    `UPDATE delegations SET state = 'idle', updated_at = ? WHERE delegation_id = ? AND state = 'active' AND delivery_generation = ?
       AND NOT EXISTS (SELECT 1 FROM delegation_deliveries d WHERE d.delegation_id = delegations.delegation_id AND d.state IN (${sqlList(OPEN_DELIVERY_STATES)}))`,
  ).run(now, delegationId, generation).changes === 1;
}

// idle -> active for a natively resumed child (see recordAck), compare-and-set on the state; the caller has
// counted the root's slots in the same transaction.
export function moveIdleToActive(db: Db, delegationId: string, now = Date.now()): boolean {
  return db.prepare("UPDATE delegations SET state = 'active', updated_at = ? WHERE delegation_id = ? AND state = 'idle'").run(now, delegationId).changes === 1;
}

// True when the root has a slot for the row besides the ones its other slot holders take (the row itself
// may already count, through an open delivery or stop request).
export function rootHasSlotFor(db: Db, row: DelegationRow, settings: SlotLimit): boolean {
  return listSlotHolders(db, row.rootThreadId).filter((holder) => holder.delegationId !== row.delegationId).length < settings.maxConcurrentChildren;
}

// reserved -> active, compare-and-set on the reservation's owner (null matches a row without one).
export function moveReservedToActive(db: Db, delegationId: string, reservationOwner: string | null, now = Date.now()): boolean {
  return db.prepare("UPDATE delegations SET state = 'active', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state = 'reserved' AND child_thread_id IS NOT NULL AND reservation_owner IS ?")
    .run(now, delegationId, reservationOwner).changes === 1;
}

// reserved -> idle, compare-and-set on the reservation's owner: the delivery that took the slot never reached
// SANDY, or the plugin lost track of it.
export function moveReservedToIdle(db: Db, delegationId: string, reservationOwner: string | null, now = Date.now()): boolean {
  return db.prepare("UPDATE delegations SET state = 'idle', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state = 'reserved' AND child_thread_id IS NOT NULL AND reservation_owner IS ?")
    .run(now, delegationId, reservationOwner).changes === 1;
}

// queued|admitted -> cancelled: the input can never be delivered.
export function cancelInput(db: Db, inputId: string, now = Date.now()): boolean {
  return db.prepare("UPDATE pending_inputs SET state = 'cancelled', updated_at = ? WHERE input_id = ? AND state IN ('queued', 'admitted')").run(now, inputId).changes === 1;
}

// Roots with at least one queued input.
export function rootsWithQueued(db: Db): string[] {
  return (db.prepare("SELECT DISTINCT root_thread_id AS rootThreadId FROM pending_inputs WHERE state = 'queued' ORDER BY rootThreadId").all() as { rootThreadId: string }[]).map((row) => row.rootThreadId);
}

// Inputs admitted (slot taken) that no delivery has claimed, oldest first: the drain about to claim one, or
// one a plugin process lost before its claim (nothing of it reached SANDY).
export function listAdmittedInputs(db: Db): PendingInput[] {
  return db.prepare(PENDING_INPUT_SELECT + " WHERE state = 'admitted' ORDER BY seq").all().map(pendingInputRow);
}

// True when the delegation has an input admitted or being delivered.
export function hasInputInDelivery(db: Db, delegationId: string): boolean {
  return db.prepare("SELECT 1 FROM pending_inputs WHERE delegation_id = ? AND state IN ('admitted', 'delivering') LIMIT 1").get(delegationId) !== undefined;
}

// Bound rows in "reserved" not touched since before, with no delivery open: a readmission whose delivery was
// lost with its process before its claim.
export function listStaleReserved(db: Db, before: number): DelegationRow[] {
  return db.prepare(
    `${DELEGATION_SELECT} WHERE state = 'reserved' AND child_thread_id IS NOT NULL AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM delegation_deliveries d WHERE d.delegation_id = delegations.delegation_id AND d.state IN (${sqlList(UNANSWERED_DELIVERY_STATES)}))
     ORDER BY updated_at, rowid`,
  ).all(before) as DelegationRow[];
}

// Every delegation of the parent thread that is not ended, oldest first.
export function listOpenDelegationsOf(db: Db, parentThreadId: string): DelegationRow[] {
  return db.prepare(`${DELEGATION_SELECT} WHERE parent_thread_id = ? AND kind = 'delegate' AND state NOT IN (${sqlList(END_STATES)}) ORDER BY created_at, rowid`).all(parentThreadId) as DelegationRow[];
}

// SANDY no longer has the child's thread (deleted): every open delivery to it settles as gone and the row ends
// as error, in one transaction (frees its slot, cancels its queued inputs; the question sweep cancels its
// questions). null when the row is unknown or had ended already.
export function endDeletedChild(db: Db, delegationId: string, now = Date.now()): DelegationRow | null {
  return db
    .transaction((): DelegationRow | null => {
      const row = getDelegation(db, delegationId);
      if (row === null || END_STATES.includes(row.state)) return null;
      const open = db.prepare(`SELECT delivery_id AS id FROM delegation_deliveries WHERE delegation_id = ? AND state IN (${sqlList(OPEN_DELIVERY_STATES)})`).all(delegationId) as { id: string }[];
      for (const { id } of open) settleDelivery(db, id, "gone", now);
      if (!END_STATES.includes(getDelegation(db, delegationId)!.state)) transition(db, delegationId, "error", now);
      return getDelegation(db, delegationId);
    })
    .immediate();
}

// The parent's stop of a delegation, compare-and-set on "not ended": the row becomes "stopped" (its queued
// inputs are cancelled) and its child gets a stop request, whose confirmation frees the slot. null when the
// row ended meanwhile or is not bound to a child.
export function stopDelegation(db: Db, delegationId: string, now = Date.now()): DelegationRow | null {
  return db
    .transaction((): DelegationRow | null => {
      const row = getDelegation(db, delegationId);
      if (row === null || row.childThreadId === null) return null;
      const moved = transition(db, delegationId, "stopped", now);
      if (!moved.ok) return null;
      requestStop(db, row.childThreadId, delegationId, "parent_stop", now);
      return moved.delegation;
    })
    .immediate();
}
