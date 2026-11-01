// The brief watchdog. A delegation must ack its policy within the window (settings.briefWatchdogSeconds)
// after its spawn was bound; otherwise it is refused (brief withheld) and its child thread is stopped. A
// reservation whose spawn never bound is reconciled after the same window: it is bound to the one thread
// SANDY proves is its spawn (and then watched like any other), released when SANDY positively lists none once
// the spawn request can no longer be outstanding (SPAWN_SETTLE_MS), and kept in every other case. The
// first pass after the plugin starts reconciles every reservation at once, not only expired ones: a spawn
// whose result the previous plugin process lost (timeout, reload) is bound then, never spawned again. A
// bound, unacked child whose first turn SANDY shows started without the delegate marker (see markerMissing)
// ran ungated: it is refused and stopped, never repaired. The turn rule covers resumed children: every
// turn of a bound child needs its own ack (see advanceTurns); a turn without one is refused and its
// child stopped. Every deadline is derived from the ledger (bound_at, created_at) and every stop
// is a durable request, retried until SANDY confirms it, so a sweep after a plugin restart finds what the
// previous one left; there are no timers to lose.
import type Database from "better-sqlite3";
import {
  bindChild, clearWaitSilenced, dropEndedWaitMarks, endDeletedChild, dueStopRequests, listWaitMarked, touchWaitMark, getDelegation, getDelegationByChild, isDelegationParent, listOverdueUnacked, listTurnScanBatch, listUnacked,
  hasUnansweredDelivery, listQueuedDeliveries, listUnboundReservations, markerGrantedAt, markStopConfirmed, markStopFailed, moveActiveToIdle, refuseTurnUnacked, refuseUnacked, refuseUnmarked, releaseReservation,
  saveTurnScan, settleDelivery, unmatchedAcks, type DelegationRow, type OpenTurn, type StopRequest, type TurnState, type UnmatchedAck,
} from "./ledger.ts";
import { withDelegationLock } from "./delegation-lock.ts";
import { metadataDelegationId } from "./protocol.ts";
import { DEFAULT_SETTINGS, type DelegateSettings } from "./settings.ts";

type Db = Database.Database;

// SANDY's facts about a thread whose metadata of this plugin names a delegation.
export type SpawnCandidate = {
  threadId: string;
  parentThreadId: string | null;
  // The plugin SANDY says created the thread (null: not created by a plugin).
  originPluginId: string | null;
  createdAt: number;
  metadata: Readonly<Record<string, unknown>>;
};

// SANDY thread statuses in which no turn runs.
export const STOPPED_STATUSES: readonly string[] = ["idle", "error"];

// How long after its reservation a spawn may still be outstanding, in any plugin process: a SANDY spawn
// request does not outlive it. Before that, an empty listing does not prove there is no spawn.
export const SPAWN_SETTLE_MS = 10 * 60_000;

export interface WatchdogHost {
  // This plugin's id; SANDY stamps it as originPluginId on every thread the plugin spawns.
  readonly pluginId: string;
  // The threads below the parent (hidden and archived included) whose metadata of this plugin names the
  // delegation. null when SANDY does not list the parent (unknown or deleted id): no proof that none exists.
  spawnCandidates(parentThreadId: string, delegationId: string): Promise<SpawnCandidate[] | null>;
  // True while this process's sandy_delegate call for the delegation has not settled its spawn and bind.
  spawnInFlight(delegationId: string): boolean;
  // SANDY's thread stop; rejects when SANDY refuses it. Resolving does not confirm the stop.
  stop(threadId: string): Promise<void>;
  // The thread's status and whether it is archived; null when SANDY no longer has the thread (unknown or deleted).
  threadState(threadId: string): Promise<{ status: string; archived: boolean } | null>;
  // When SANDY recorded the thread's first turn start (its first turn/started event); null when no turn has
  // started or SANDY no longer has the thread.
  firstTurnStartedAt(threadId: string): Promise<number | null>;
  // One listing of the thread's turn/started and turn/completed events after afterSeq (from the first when
  // null), in sequence order, at most limit of them (fewer: none further right now); null when SANDY no longer
  // has the thread.
  turnEventsAfter(threadId: string, afterSeq: number | null, limit: number): Promise<TurnEvent[] | null>;
  // The thread's newest count turn/started and turn/completed events, in sequence order; null when SANDY no
  // longer has the thread.
  latestTurnEvents(threadId: string, count: number): Promise<TurnEvent[] | null>;
  // True while a sandy_delegate / sandy_delegate_wait call of this process is waiting on the delegation.
  waitInFlight(delegationId: string): boolean;
  // SANDY's thread update of parentNotifications; rejects when SANDY refuses it.
  setParentNotifications(threadId: string, mode: "auto" | "off"): Promise<void>;
}

// Wait-mode children whose notifications one sweep flips back to "auto": each is one SANDY call.
export const WAIT_RESTORE_BUDGET = 3;

// Turn events read per child and sweep, in one listing call (SANDY 0.47.1 rejects limits above 100).
export const TURN_EVENT_PAGE = 100;

// Children whose turn events one sweep tries to list (one listing call each). Every bound, not ended child
// is in the round robin, whatever its SANDY status (an idle or archived child can be resumed, so its next turn
// must be seen). At most TURN_SCAN_PRIORITY_SHARE of them come from the priority class (a pending baseline,
// an open turn whose window ran out); the other slots go to the least recently attempted of all children
// (see listTurnScanBatch). Every attempt counts (a failure, a full page), so with N bound children each one
// is attempted at least once every ceil(N / (TURN_SCAN_BUDGET - TURN_SCAN_PRIORITY_SHARE)) sweeps, however
// the others fare. The resulting worst-case refusal delay is turnRefusalBoundMs.
export const TURN_SCAN_BUDGET = 10;
export const TURN_SCAN_PRIORITY_SHARE = 5;

// The latest a child's turn without its ack is refused (and its stop requested), in ms after its
// turn/started, with sweeps at most sweepIntervalMs apart (tick 1-5 s plus the sweep's own time):
//   window + listings * ceil(children / (TURN_SCAN_BUDGET - TURN_SCAN_PRIORITY_SHARE)) * sweepIntervalMs
//   listings = floor(backlogEvents / TURN_EVENT_PAGE) + 1, + 1 while the baseline's newest seq is not taken
// children: bound, not ended children over that time. backlogEvents: the child's turn events after its
// cursor once the window has run out, up to and including that turn/started (a pending baseline: its whole
// history). After the window, each listing of the child comes at most ceil(...) sweeps after the previous
// one, and that many listings read past the turn/started: its range is closed by the next event or by the
// end of the events, and the turn is decided.
export function turnRefusalBoundMs(
  windowMs: number, children: number, sweepIntervalMs: number, backlogEvents: number, baselineSeqPending = false,
): number {
  const sweepsPerAttempt = Math.ceil(children / (TURN_SCAN_BUDGET - TURN_SCAN_PRIORITY_SHARE));
  const listings = Math.floor(backlogEvents / TURN_EVENT_PAGE) + 1 + (baselineSeqPending ? 1 : 0);
  return windowMs + listings * sweepsPerAttempt * sweepIntervalMs;
}

// One turn/started or turn/completed event of a thread: SANDY's sequence number and creation time.
// A completed event also carries the turn's outcome and error message when SANDY recorded them (wait mode).
export type TurnEvent = { seq: number; type: "started" | "completed"; at: number; outcome?: string; error?: string };

// The window in ms; a missing, non-finite or non-positive setting falls back to the default.
export function watchdogWindowMs(settings: Pick<DelegateSettings, "briefWatchdogSeconds">): number {
  const seconds = settings.briefWatchdogSeconds;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SETTINGS.briefWatchdogSeconds) * 1000;
}

// How often the plugin sweeps: a tenth of the window, between 1 s and 5 s.
export function watchdogTickMs(windowMs: number): number {
  return Math.min(5_000, Math.max(1_000, Math.floor(windowMs / 10)));
}

export type SweepReport = {
  refused: DelegationRow[];
  // Bound children refused because their first turn started without the delegate marker.
  unmarked: DelegationRow[];
  // Bound children refused because a turn started without an ack for it, with that turn/started event.
  turnUnacked: { delegation: DelegationRow; turn: TurnEvent }[];
  bound: { delegationId: string; childThreadId: string }[];
  released: string[];
  // Reconciled reservations left as they are (and holding their slot), with the reason.
  kept: { delegationId: string; reason: string }[];
  // Active children moved to idle in this pass: their last turn completed and SANDY shows no running turn.
  idled: DelegationRow[];
  // Children whose thread SANDY no longer has (deleted), ended as error in this pass.
  deleted: DelegationRow[];
  // Child threads whose stop SANDY confirmed in this pass.
  stopped: string[];
  // Wait-mode children set back to parentNotifications "auto" in this pass (no wait of this process was on them).
  restored: string[];
  failures: { subject: string; error: string }[];
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The candidate is the reservation's spawn only when SANDY says this plugin created it, as a direct child of
// the reservation's parent, not before the reservation, and its metadata names the reservation; metadata
// alone can be copied. A thread already bound to a delegation, or parenting delegations itself (a
// delegate cannot delegate), is not a spawn of this reservation either.
function isSpawnOf(db: Db, pluginId: string, row: DelegationRow, candidate: SpawnCandidate): boolean {
  return candidate.originPluginId === pluginId
    && candidate.parentThreadId === row.parentThreadId
    && candidate.createdAt >= row.createdAt
    && metadataDelegationId(candidate.metadata) === row.delegationId
    && getDelegationByChild(db, candidate.threadId) === null
    && !isDelegationParent(db, candidate.threadId);
}

// Binds a reservation (expired, or any at startup) to its one proven spawn, or releases it when SANDY positively lists none, no
// spawn of this process is in flight for it, and it is older than SPAWN_SETTLE_MS (a spawn by an earlier
// plugin process may still be outstanding before that). Anything else keeps it: an unlisted parent, a
// failing listing, or more than one proven spawn (nothing is bound or stopped then).
async function reconcileReservation(db: Db, host: WatchdogHost, row: DelegationRow, now: number, report: SweepReport): Promise<void> {
  if (host.spawnInFlight(row.delegationId)) {
    report.kept.push({ delegationId: row.delegationId, reason: "its spawn is still in flight" });
    return;
  }
  let listed: SpawnCandidate[] | null;
  try {
    listed = await host.spawnCandidates(row.parentThreadId, row.delegationId);
  } catch (error) {
    report.failures.push({ subject: row.delegationId, error: message(error) });
    return;
  }
  if (listed === null) {
    report.kept.push({ delegationId: row.delegationId, reason: `SANDY does not list its parent ${row.parentThreadId}` });
    return;
  }
  const spawns = listed.filter((candidate) => isSpawnOf(db, host.pluginId, row, candidate)).map((candidate) => candidate.threadId);
  if (spawns.length === 0) {
    if (now - row.createdAt < SPAWN_SETTLE_MS) report.kept.push({ delegationId: row.delegationId, reason: "spawn outcome unknown" });
    else if (releaseReservation(db, row.delegationId, now)) report.released.push(row.delegationId);
    return;
  }
  if (spawns.length > 1) {
    report.kept.push({ delegationId: row.delegationId, reason: `ambiguous: ${spawns.length} threads spawned by this plugin name it (${spawns.join(", ")})` });
    return;
  }
  if (bindChild(db, row.delegationId, spawns[0], now).ok) report.bound.push({ delegationId: row.delegationId, childThreadId: spawns[0] });
}

// A child ran without the delegate marker, and so without the extension's gate, when SANDY shows a turn
// started and agents.configure had not given it the marker by the start of its first turn. The extension
// decides at session start whether it gates, so a marker granted later does not gate that session.
export function markerMissing(grantedAt: number | null, firstTurnStartedAt: number | null): boolean {
  return firstTurnStartedAt !== null && (grantedAt === null || grantedAt > firstTurnStartedAt);
}

// Refuses (and requests the stop of) every bound, unacked child that ran without the marker. A child
// whose turn has not started is left to the ack window.
async function refuseUnmarkedChildren(db: Db, host: WatchdogHost, now: number, report: SweepReport): Promise<void> {
  for (const row of listUnacked(db)) {
    const childThreadId = row.childThreadId!;
    let startedAt: number | null;
    try {
      startedAt = await host.firstTurnStartedAt(childThreadId);
    } catch (error) {
      report.failures.push({ subject: childThreadId, error: message(error) });
      continue;
    }
    if (!markerMissing(markerGrantedAt(db, childThreadId), startedAt)) continue;
    const refused = refuseUnmarked(db, row.delegationId, childThreadId, now);
    if (refused !== null) report.unmarked.push(refused);
  }
}

// The turn rule, over a child's turn events in seq order. Turn k (turn/started S_k) is satisfied by exactly
// one ack not matched to another turn and recorded in (lower_k, upper_k]: lower_k is the child's previous
// turn event (C_{k-1}, the previous turn/completed, or S_{k-1} when that turn has no completion; none for
// the first turn) and upper_k = min(S_k + windowMs, the next turn event C_k or S_{k+1}). Whether the ack
// comes before or after S_k does not matter; retained and resumed pi sessions are treated alike. The turn is
// decided once its range is closed, by the next event or, with no later events (reachedEnd), by now; it
// takes the oldest ack in range. A range closed without an ack is the missing turn: the scan stops there.
// A turn whose range is closed by an event up to grandfatherThroughSeq (history before the upgrade, see
// TurnCursor.baselinePending) still takes its ack but is not refused without one.
// Advances state by events (after state.checkedSeq, in seq order); acks are the child's unmatched acks.
export function advanceTurns(
  state: TurnState, events: readonly TurnEvent[], acks: readonly UnmatchedAck[], windowMs: number, now: number, reachedEnd: boolean,
  grandfatherThroughSeq: number | null = null,
): { state: TurnState; matches: { nonce: string; turnSeq: number }[]; missing: TurnEvent | null } {
  const matches: { nonce: string; turnSeq: number }[] = [];
  const matched = new Set<string>();
  const decide = (open: OpenTurn, upper: number): boolean => {
    const ack = acks.find(({ nonce, ackedAt }) => !matched.has(nonce) && (open.lowerAt === null || ackedAt > open.lowerAt) && ackedAt <= upper);
    if (ack === undefined) return false;
    matched.add(ack.nonce);
    matches.push({ nonce: ack.nonce, turnSeq: open.seq });
    return true;
  };
  const missingTurn = (open: OpenTurn): TurnEvent => ({ seq: open.seq, type: "started", at: open.at });
  let { checkedSeq, lastAt, open } = state;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (checkedSeq !== null && event.seq <= checkedSeq) continue;
    if (open !== null) {
      const grandfathered = grandfatherThroughSeq !== null && event.seq <= grandfatherThroughSeq;
      if (!decide(open, Math.min(open.at + windowMs, event.at)) && !grandfathered) {
        return { state: { checkedSeq, lastAt, open }, matches, missing: missingTurn(open) };
      }
      open = null;
    }
    if (event.type === "started") open = { seq: event.seq, at: event.at, lowerAt: lastAt };
    checkedSeq = event.seq;
    lastAt = event.at;
  }
  if (open !== null && reachedEnd && now >= open.at + windowMs) {
    if (!decide(open, open.at + windowMs)) return { state: { checkedSeq, lastAt, open }, matches, missing: missingTurn(open) };
    open = null;
  }
  return { state: { checkedSeq, lastAt, open }, matches, missing: null };
}

// The active -> idle transition (nothing else makes it): the scan has read the child's events to their end,
// the last one is a turn/completed with no turn open, it is newer than the last input delivered to the child
// (idle_after_seq), no delivery is unanswered, every message SANDY queued behind a running turn has had its
// own turn (the first turn/started above its watermark is at or below the checked seq; each is then closed
// as sent), whatever was sent after it, and SANDY shows the thread without a running turn (idle, or error
// after a failed turn). It runs under the delegation's lock on the row read there (the scan's snapshot may
// predate a send), and the commit is fenced with the delivery generation read before SANDY's thread status.
// The row then no longer holds a slot; the sweep's queue drain gives the slot to the next queued input.
async function idleFinishedChild(
  db: Db, host: WatchdogHost, scanned: DelegationRow, state: TurnState & { lastEventType: "started" | "completed" | null }, reachedEnd: boolean, now: number, report: SweepReport,
): Promise<boolean> {
  if (scanned.state !== "active" || !reachedEnd || state.open !== null || state.checkedSeq === null) return false;
  const checkedSeq = state.checkedSeq;
  return withDelegationLock(scanned.delegationId, async () => {
    const row = getDelegation(db, scanned.delegationId)!;
    if (row.state !== "active" || hasUnansweredDelivery(db, row.delegationId)) return false;
    if (row.idleAfterSeq !== null && checkedSeq <= row.idleAfterSeq) return false;
    let generation = row.deliveryGeneration;
    try {
      // A cursor stored without an event type (an older row): read the newest event once.
      const lastEventType = state.lastEventType ?? (await host.latestTurnEvents(row.childThreadId!, 1))?.find((event) => event.seq === checkedSeq)?.type ?? null;
      if (lastEventType !== "completed") return false;
      // Every message SANDY queued must have had its turn, whatever was sent after it; each that has is closed.
      for (const queued of listQueuedDeliveries(db, row.delegationId)) {
        const after = await host.turnEventsAfter(row.childThreadId!, queued.afterSeq, 2);
        const took = after?.find((event) => event.type === "started");
        if (took === undefined || took.seq > checkedSeq) return false;
        settleDelivery(db, queued.deliveryId, "sent", now);
        generation = getDelegation(db, row.delegationId)!.deliveryGeneration;
      }
      const thread = await host.threadState(row.childThreadId!);
      if (thread === null || !STOPPED_STATUSES.includes(thread.status)) return false;
    } catch (error) {
      report.failures.push({ subject: row.childThreadId!, error: message(error) });
      return false;
    }
    if (!moveActiveToIdle(db, row.delegationId, generation, now)) return false;
    report.idled.push(getDelegation(db, row.delegationId)!);
    return true;
  });
}

// Tries one listing for each of up to TURN_SCAN_BUDGET children (see listTurnScanBatch): matches their acks
// to their turns and refuses (and requests the stop of) every child with a turn that started without its
// ack. A child bound before the upgrade (baselinePending) first has its newest turn event seq taken
// (enforceFromSeq), then its history is read from the first event on like any child's, with the turns
// closed by then grandfathered: their acks are matched (so a pre-upgrade ack cannot count for a later
// turn), a missing one is not refused. A turn still open at the baseline and every later turn are checked.
// Every attempt, whatever its outcome, moves the child to the back of the round robin. Returns the refused rows.
async function refuseTurnsWithoutAck(db: Db, host: WatchdogHost, windowMs: number, now: number, report: SweepReport): Promise<DelegationRow[]> {
  const refusedRows: DelegationRow[] = [];
  for (const { delegation, cursor } of listTurnScanBatch(db, windowMs, now, TURN_SCAN_BUDGET, TURN_SCAN_PRIORITY_SHARE)) {
    const childThreadId = delegation.childThreadId!;
    let page: TurnEvent[] | null;
    try {
      if (cursor.baselinePending && cursor.enforceFromSeq === null) {
        const newestSeq = ((await host.latestTurnEvents(childThreadId, 1)) ?? []).at(-1)?.seq ?? null;
        // No turn yet: nothing to grandfather, every turn is checked.
        saveTurnScan(db, { ...cursor, baselinePending: newestSeq !== null, enforceFromSeq: newestSeq, scannedAt: now }, []);
        continue;
      }
      page = await host.turnEventsAfter(childThreadId, cursor.checkedSeq, TURN_EVENT_PAGE);
      // No event listing: a thread SANDY no longer has (its status read confirms it) is terminal.
      if (page === null && (await host.threadState(childThreadId)) === null) {
        const ended = await withDelegationLock(delegation.delegationId, async () => endDeletedChild(db, delegation.delegationId, now));
        if (ended !== null) report.deleted.push(ended);
        continue;
      }
    } catch (error) {
      report.failures.push({ subject: childThreadId, error: message(error) });
      saveTurnScan(db, { ...cursor, scannedAt: now }, []);
      continue;
    }
    // A full page may have more events behind it (the next attempt reads on).
    const reachedEnd = page === null || page.length < TURN_EVENT_PAGE;
    const grandfatherThroughSeq = cursor.baselinePending ? cursor.enforceFromSeq : null;
    const acks = unmatchedAcks(db, delegation.delegationId, childThreadId, cursor.open !== null ? cursor.open.lowerAt : cursor.lastAt);
    const scan = advanceTurns(cursor, page ?? [], acks, windowMs, now, reachedEnd, grandfatherThroughSeq);
    const historyLeft = grandfatherThroughSeq !== null && !reachedEnd && (scan.state.checkedSeq ?? Number.MIN_SAFE_INTEGER) < grandfatherThroughSeq;
    const lastEventType = page?.find((event) => event.seq === scan.state.checkedSeq)?.type ?? cursor.lastEventType;
    saveTurnScan(db, { ...cursor, ...scan.state, lastEventType, baselinePending: historyLeft, scannedAt: now }, scan.matches);
    if (scan.missing === null) {
      await idleFinishedChild(db, host, delegation, { ...scan.state, lastEventType }, reachedEnd, now, report);
      continue;
    }
    const refused = refuseTurnUnacked(db, delegation.delegationId, childThreadId, now);
    if (refused === null) continue;
    report.turnUnacked.push({ delegation: refused, turn: scan.missing });
    refusedRows.push(refused);
  }
  return refusedRows;
}

// Calls SANDY's stop and checks the thread's status afterwards. Confirmed: the thread is gone, or the stop
// call succeeded and the thread is in a status without a running turn. Archiving does not end a turn: an
// archived thread that is still stopping or active is not confirmed.
async function carryOutStop(host: Pick<WatchdogHost, "stop" | "threadState">, threadId: string): Promise<{ confirmed: true } | { confirmed: false; error: string }> {
  let stopError: string | null = null;
  try {
    await host.stop(threadId);
  } catch (error) {
    stopError = message(error);
  }
  let state: Awaited<ReturnType<WatchdogHost["threadState"]>>;
  try {
    state = await host.threadState(threadId);
  } catch (error) {
    return { confirmed: false, error: stopError ?? `stop sent, status unknown: ${message(error)}` };
  }
  if (state === null) return { confirmed: true };
  if (stopError !== null) return { confirmed: false, error: stopError };
  if (STOPPED_STATUSES.includes(state.status)) return { confirmed: true };
  return { confirmed: false, error: `stop not confirmed: thread is ${state.status}${state.archived ? " (archived)" : ""}` };
}

// Carries out stop requests: SANDY's stop, then confirmed or failed (retried after a backoff).
export async function carryOutStops(
  db: Db, host: Pick<WatchdogHost, "stop" | "threadState">, requests: readonly StopRequest[], windowMs: number, now: number, report: Pick<SweepReport, "stopped" | "failures">,
): Promise<void> {
  for (const request of requests) {
    const outcome = await carryOutStop(host, request.childThreadId);
    if (outcome.confirmed) {
      markStopConfirmed(db, request.childThreadId, now);
      report.stopped.push(request.childThreadId);
    } else {
      markStopFailed(db, request.childThreadId, outcome.error, windowMs, now);
      report.failures.push({ subject: request.childThreadId, error: outcome.error });
    }
  }
}

// One pass: refuse overdue unacked delegations, reconcile every unbound reservation (a spawn whose result
// was lost must bind well inside the extension's 30 s policy retry, not only after the window; in-flight
// spawns of this process are skipped without a SANDY call, release still waits for SPAWN_SETTLE_MS), refuse
// bound children that ran without the marker, carry out every due stop request (new and earlier ones),
// then run the bounded turn scan (refuse children with a turn without its ack) and carry out the stops of
// the children it refused. Due stops never wait behind the turn scan.
// A wait-mode child is silenced (parentNotifications "off") only while a wait of this process is on it. A
// marked delegation with no wait in flight here (the process that waited died without aborting, or this
// is the first pass of a new one) is set back to "auto" so its next turn wakes its parent natively. Marks
// of ended delegations are dropped; unbound ones wait until they are bound. At most WAIT_RESTORE_BUDGET
// SANDY calls per pass, least recently attempted first. A wait that starts while a flip is in flight can see
// it land after its own "off": the cost is one duplicate wake, never a lost one.
export async function restoreSilencedChildren(db: Db, host: WatchdogHost, now: number, report: SweepReport): Promise<void> {
  dropEndedWaitMarks(db);
  let calls = 0;
  for (const row of listWaitMarked(db)) {
    if (calls >= WAIT_RESTORE_BUDGET) break;
    if (host.spawnInFlight(row.delegationId) || host.waitInFlight(row.delegationId)) continue;
    calls += 1;
    touchWaitMark(db, row.delegationId, now);
    try {
      await host.setParentNotifications(row.childThreadId!, "auto");
      if (!host.waitInFlight(row.delegationId)) clearWaitSilenced(db, row.delegationId);
      report.restored.push(row.childThreadId!);
    } catch (error) {
      // 404: SANDY no longer has the thread, so there is nothing to wake for.
      if ((error as { status?: unknown }).status === 404) clearWaitSilenced(db, row.delegationId);
      else report.failures.push({ subject: `restore notifications of ${row.childThreadId}`, error: message(error) });
    }
  }
}

// options.startup only marks the first pass of a plugin process; options.afterSweep runs at the end of the pass
// (sandy_delegate_send's queue drain, see control.ts).
export async function sweepWatchdog(db: Db, host: WatchdogHost, windowMs: number, now = Date.now(), options: { startup?: boolean; afterSweep?: (report: SweepReport) => Promise<void> } = {}): Promise<SweepReport> {
  const report: SweepReport = { refused: [], unmarked: [], turnUnacked: [], bound: [], released: [], kept: [], stopped: [], restored: [], idled: [], deleted: [], failures: [] };
  for (const row of listOverdueUnacked(db, windowMs, now)) {
    const refused = refuseUnacked(db, row.delegationId, windowMs, now);
    if (refused !== null) report.refused.push(refused);
  }
  const reservations = listUnboundReservations(db);
  for (const row of reservations) await reconcileReservation(db, host, row, now, report);
  await refuseUnmarkedChildren(db, host, now, report);
  await carryOutStops(db, host, dueStopRequests(db, now), windowMs, now, report);
  const turnRefused = new Set((await refuseTurnsWithoutAck(db, host, windowMs, now, report)).map((row) => row.childThreadId));
  await carryOutStops(db, host, dueStopRequests(db, now).filter((request) => turnRefused.has(request.childThreadId)), windowMs, now, report);
  await restoreSilencedChildren(db, host, now, report);
  // Last: stop confirmations and idle transitions of this pass have freed their slots by now.
  if (options.afterSweep !== undefined) await options.afterSweep(report);
  return report;
}
