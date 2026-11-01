// Wait mode: sandy_delegate(mode:"wait") and sandy_delegate_wait block for a child's turn to finish, in chunks of
// at most MAX_WAIT_CEILING_MS (a plugin tool call is cut at ~300 s, P2). While a wait blocks, the child's
// parentNotifications is "off", so SANDY does not wake the parent for a turn the wait itself reports; whenever
// the wait ends (finished, ceiling, abort, error) it is set back to "auto", so a later turn of the child
// wakes the parent natively. SANDY is reached only through WaitHost.
//
// "Child finished" is read from SANDY, never cached: the delegation is finished when the ledger row is in an
// end state, or SANDY no longer has the thread, or the thread's status shows no running turn (idle or error)
// and the thread's newest turn event is a turn/completed (its status completed|failed|interrupted is the
// result status). A thread that is idle without any turn event has not started yet and is not finished;
// a thread in status error without a completed turn (it failed to start) is finished as "error".
import type Database from "better-sqlite3";
import { clearWaitSilenced, END_STATES, getDelegation, markWaitSilenced, type DelegationRow } from "./ledger.ts";
import type { DelegateSettings } from "./settings.ts";
import { STOPPED_STATUSES, type WatchdogHost } from "./watchdog.ts";

type Db = Database.Database;

export const MAX_WAIT_CEILING_MS = 270_000;
export const MIN_WAIT_CEILING_MS = 1_000;
export const WAIT_POLL_MS = 2_000;

// The configured chunk, kept inside [MIN, MAX]; a missing or non-finite setting falls back to the maximum.
export function waitCeilingMs(settings: Pick<DelegateSettings, "waitCeilingMs">): number {
  const value = settings.waitCeilingMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_WAIT_CEILING_MS;
  return Math.min(MAX_WAIT_CEILING_MS, Math.max(MIN_WAIT_CEILING_MS, Math.floor(value)));
}

export type ParentNotifications = "auto" | "off";

export interface WaitHost extends Pick<WatchdogHost, "threadState" | "latestTurnEvents"> {
  // The delegations this process is waiting on, with the number of waits on each. While one is listed the
  // watchdog leaves the child's notifications alone; a wait that never reaches its end (crash, kill, host
  // restart) is not listed by a new process, which is how the watchdog finds its child (see restoreSilencedChildren).
  readonly waitsInFlight: Map<string, number>;
  // The thread's last assistant message (SANDY's thread output); null when it has none.
  output(threadId: string): Promise<string | null>;
  setParentNotifications(threadId: string, mode: ParentNotifications): Promise<void>;
  now(): number;
  // Resolves after ms, or at once when the signal aborts.
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type WaitRefusal =
  | { code: "unknown_delegation"; delegationId: string; message: string }
  | { code: "not_parent"; delegationId: string; message: string }
  | { code: "notification_flip_failed"; delegationId: string; message: string };

export type WaitFinished = {
  // completed | failed | interrupted (the child's last turn), error | refused | stopped (ledger end state), gone (SANDY no longer has the thread).
  status: string;
  error: string | null;
  result: string | null;
};

export type WaitOutcome =
  | { kind: "refused"; refusal: WaitRefusal }
  | { kind: "finished"; delegation: DelegationRow; finished: WaitFinished; parentNotifications: ParentNotifications; flipError: string | null }
  | { kind: "timed_out"; delegation: DelegationRow; parentNotifications: ParentNotifications; flipError: string | null }
  | { kind: "aborted"; delegation: DelegationRow; parentNotifications: ParentNotifications; flipError: string | null };

export type WaitRequest = {
  callerThreadId: string;
  delegationId: string;
  ceilingMs: number;
  signal: AbortSignal;
  // True right after a wait-mode spawn, which created the child with notifications off.
  notificationsAlreadyOff?: boolean;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Probe = { finished: false } | { finished: true; status: string; error: string | null };

async function probe(db: Db, host: WaitHost, delegationId: string): Promise<{ row: DelegationRow; probe: Probe }> {
  const row = getDelegation(db, delegationId)!;
  if (END_STATES.includes(row.state)) return { row, probe: { finished: true, status: row.state, error: null } };
  if (row.childThreadId === null) return { row, probe: { finished: false } };
  const thread = await host.threadState(row.childThreadId);
  if (thread === null) return { row, probe: { finished: true, status: "gone", error: null } };
  if (!STOPPED_STATUSES.includes(thread.status)) return { row, probe: { finished: false } };
  const last = ((await host.latestTurnEvents(row.childThreadId, 1)) ?? []).at(-1);
  if (last?.type === "completed") return { row, probe: { finished: true, status: last.outcome ?? "completed", error: last.error ?? null } };
  if (thread.status === "error") return { row, probe: { finished: true, status: "error", error: null } };
  return { row, probe: { finished: false } };
}

// Sets the child's notifications; one retry, then the error text.
async function setNotifications(host: WaitHost, threadId: string, mode: ParentNotifications): Promise<string | null> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await host.setParentNotifications(threadId, mode);
      return null;
    } catch (error) {
      last = message(error);
    }
  }
  return last;
}

export async function waitForDelegation(db: Db, host: WaitHost, request: WaitRequest): Promise<WaitOutcome> {
  const { delegationId } = request;
  host.waitsInFlight.set(delegationId, (host.waitsInFlight.get(delegationId) ?? 0) + 1);
  try {
    return await runWait(db, host, request);
  } finally {
    const left = (host.waitsInFlight.get(delegationId) ?? 1) - 1;
    if (left > 0) host.waitsInFlight.set(delegationId, left);
    else host.waitsInFlight.delete(delegationId);
  }
}

async function runWait(db: Db, host: WaitHost, request: WaitRequest): Promise<WaitOutcome> {
  const { delegationId, callerThreadId, signal } = request;
  const initial = getDelegation(db, delegationId);
  if (initial === null) return { kind: "refused", refusal: { code: "unknown_delegation", delegationId, message: `no delegation ${delegationId}` } };
  // The ledger decides who may wait, not thread metadata.
  if (initial.parentThreadId !== callerThreadId) {
    return { kind: "refused", refusal: { code: "not_parent", delegationId, message: `delegation ${delegationId} was not started by this thread` } };
  }
  if (initial.childThreadId !== null && request.notificationsAlreadyOff !== true) {
    markWaitSilenced(db, delegationId);
    const error = await setNotifications(host, initial.childThreadId, "off");
    if (error !== null) {
      return { kind: "refused", refusal: { code: "notification_flip_failed", delegationId, message: `could not silence the child's parent notifications: ${error}` } };
    }
  }

  const deadline = host.now() + request.ceilingMs;
  let ended: { kind: "finished"; finished: WaitFinished } | { kind: "timed_out" } | { kind: "aborted" } | null = null;
  let failure: unknown = null;
  let row = initial;
  try {
    while (ended === null) {
      if (signal.aborted) {
        ended = { kind: "aborted" };
        break;
      }
      const seen = await probe(db, host, delegationId);
      row = seen.row;
      if (seen.probe.finished) {
        const result = row.childThreadId === null ? null : await host.output(row.childThreadId);
        ended = { kind: "finished", finished: { status: seen.probe.status, error: seen.probe.error, result } };
      } else if (signal.aborted) {
        ended = { kind: "aborted" };
      } else if (host.now() >= deadline) {
        ended = { kind: "timed_out" };
      } else {
        await host.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - host.now())), signal);
      }
    }
  } catch (error) {
    failure = error;
  }

  // Whatever ended the wait, the child's own turns wake the parent again from here on.
  const finalRow = getDelegation(db, delegationId) ?? row;
  const childThreadId = finalRow.childThreadId;
  const flipError = childThreadId === null ? null : await setNotifications(host, childThreadId, "auto");
  if (flipError === null && childThreadId !== null) clearWaitSilenced(db, delegationId);
  if (failure !== null) throw failure;
  const parentNotifications: ParentNotifications = flipError === null ? "auto" : "off";
  return { ...ended!, delegation: finalRow, parentNotifications, flipError } as WaitOutcome;
}

// The JSON fields a wait adds to a tool result.
export function waitFields(outcome: Exclude<WaitOutcome, { kind: "refused" }>): Record<string, unknown> {
  const notifications = { parentNotifications: outcome.parentNotifications, ...(outcome.flipError === null ? {} : { notificationFlipError: outcome.flipError }) };
  if (outcome.kind === "finished") {
    return { status: outcome.finished.status, waitTimedOut: false, result: outcome.finished.result, ...(outcome.finished.error === null ? {} : { error: outcome.finished.error }), ...notifications };
  }
  if (outcome.kind === "timed_out") return { status: "running", waitTimedOut: true, ...notifications };
  return { status: "running", waitTimedOut: false, aborted: true, ...notifications };
}
