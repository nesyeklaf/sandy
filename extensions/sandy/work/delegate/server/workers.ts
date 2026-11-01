// workflows-plus workers in the delegation ledger. The workflows part of sandy/work spawns its workers
// itself; before a spawn or a kept-session continuation it asks for a slot of the origin's root
// (admitWorker, through the in-process link in sandy/work/workers-link.ts), then reports the spawned thread
// (attachWorker) and frees the slot when the call settles (releaseWorker). A worker row is kind
// "workflow-worker": it holds a slot like a delegate, but has no brief, ack or turn rule (workers.ts owns
// its lifecycle, the delegate watchdog skips it). Its clientRequestId "wp:<runId>:<callId>:<attempt>" names
// the call, so a retried admit returns the same reservation and the reconcile pass can match the spawn by
// the worker's pluginMetadata (runId, callId, originThreadId).
// Each grant of a slot carries a lease (reservation_owner, "wl_<uuid>"): attach and release must present it,
// so a caller holding an older or another call's lease can never bind or free the current holder's slot.
// Attach (and a continuation of a thread the ledger does not know) binds only a thread SANDY reports as a
// workflows-plus worker under the origin whose pluginMetadata names the reservation's run (and call).
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { admit, getDelegation, getDelegationByChild, listSlotHolders, SLOT_STATES, sqlList, type DelegationRow } from "./ledger.ts";
import { SPAWN_SETTLE_MS, STOPPED_STATUSES } from "./watchdog.ts";
import type { DelegateSettings } from "./settings.ts";

type Db = Database.Database;

export const WORKER_AGENT = "workflow-worker";

export type WorkerAdmitInput = { originThreadId: string; runId: string; callId: string; attempt?: number; threadId?: string };
export type WorkerRefusalCode = "nested_delegation" | "limit_reached" | "worker_busy" | "unknown_reservation" | "stale_lease" | "not_a_worker";
export type WorkerRefusal = { ok: false; code: WorkerRefusalCode; message: string; running?: string[] };
export type WorkerAdmitResult = { ok: true; reservationId: string; lease: string; state: DelegationRow["state"] } | WorkerRefusal;
export type WorkerAttachResult = { ok: true; reservationId: string; threadId: string } | WorkerRefusal;
export type WorkerReleaseResult = { ok: true; released: boolean } | WorkerRefusal;

type SlotLimit = Pick<DelegateSettings, "maxConcurrentChildren">;

const refusal = (code: WorkerRefusalCode, message: string, running?: string[]): WorkerRefusal => ({ ok: false, code, message, ...(running === undefined ? {} : { running }) });

export function workerRequestId(runId: string, callId: string, attempt: number): string {
  return `wp:${runId}:${callId}:${attempt}`;
}

const newLease = (): string => `wl_${randomUUID()}`;

function parseWorkerRequestId(clientRequestId: string | null): { runId: string; callId: string; attempt: number } | null {
  const match = /^wp:([^:]+):([^:]+):(\d+)$/.exec(clientRequestId ?? "");
  return match === null ? null : { runId: match[1], callId: match[2], attempt: Number(match[3]) };
}

const limitRefusal = (limit: number, running: DelegationRow[]): WorkerRefusal =>
  refusal("limit_reached", `root is full (${limit} running)`, running.map((row) => row.childThreadId ?? row.delegationId));

// A slot for a worker of the origin's run. Without threadId: a new reservation for a spawn (idempotent per
// run, call and attempt). With threadId (a kept-session continuation): the worker's row takes a slot again
// (idle -> active, counted in one transaction), only for a call of the run that spawned it; while another
// call holds it, the continuation is refused (worker_busy) and waits. A kept thread unknown to the ledger
// (spawned while the plugin was absent) gets a new row bound to it once SANDY shows it is a worker of the run.
export async function admitWorker(db: Db, host: WorkerThreadHost, input: WorkerAdmitInput, settings: SlotLimit, now = Date.now()): Promise<WorkerAdmitResult> {
  const originBinding = getDelegationByChild(db, input.originThreadId);
  if (originBinding !== null) {
    return refusal("nested_delegation", `origin ${input.originThreadId} is itself a delegated child (${originBinding.delegationId})`);
  }
  if (input.threadId !== undefined) {
    const known = getDelegationByChild(db, input.threadId);
    if (known !== null) return readmitWorker(db, known, input, settings, now);
    const unproven = await unprovenWorker(host, input.originThreadId, input.threadId, (metadata) => metadata.runId === input.runId);
    if (unproven !== null) return unproven;
    const boundMeanwhile = getDelegationByChild(db, input.threadId);
    if (boundMeanwhile !== null) return readmitWorker(db, boundMeanwhile, input, settings, now);
  }
  const attempt = input.attempt ?? 0;
  // An origin that is an ordinary SANDY child shares the slots of its root with that root's delegates.
  const rootThreadId = await host.rootOf(input.originThreadId);
  const admitted = admit(db, {
    rootThreadId,
    callerThreadId: input.originThreadId,
    kind: "workflow-worker",
    agent: WORKER_AGENT,
    clientRequestId: workerRequestId(input.runId, input.callId, attempt),
    inputHash: createHash("sha256").update(JSON.stringify([input.runId, input.callId, attempt, input.threadId ?? null])).digest("hex"),
  }, settings, now);
  if (!admitted.ok) {
    if (admitted.refusal.code === "limit_reached") return limitRefusal(admitted.refusal.limit, admitted.refusal.running);
    return refusal("nested_delegation", `admission refused: ${admitted.refusal.code}`);
  }
  const reservationId = admitted.delegation.delegationId;
  if (!admitted.reused) db.prepare("UPDATE delegations SET reservation_owner = ? WHERE delegation_id = ?").run(newLease(), reservationId);
  if (input.threadId !== undefined && admitted.delegation.childThreadId === null) {
    bindWorker(db, reservationId, input.threadId, now);
  }
  const row = getDelegation(db, reservationId)!;
  if (row.reservationOwner === null) return refusal("unknown_reservation", `reservation ${reservationId} has ended (${row.state})`);
  return { ok: true, reservationId, lease: row.reservationOwner, state: row.state };
}

function readmitWorker(db: Db, known: DelegationRow, input: WorkerAdmitInput, settings: SlotLimit, now: number): WorkerAdmitResult {
  if (known.kind !== "workflow-worker" || known.parentThreadId !== input.originThreadId) {
    return refusal("not_a_worker", `thread ${input.threadId} is not a workflows-plus worker of ${input.originThreadId}`);
  }
  if (parseWorkerRequestId(known.clientRequestId)?.runId !== input.runId) {
    return refusal("not_a_worker", `thread ${input.threadId} is a worker of another run`);
  }
  const owner = workerRequestId(input.runId, input.callId, input.attempt ?? 0);
  return db.transaction((): WorkerAdmitResult => {
    const row = getDelegation(db, known.delegationId)!;
    if (row.state === "reserved" || row.state === "starting" || row.state === "active") {
      if (row.clientRequestId === owner && row.reservationOwner !== null) return { ok: true, reservationId: row.delegationId, lease: row.reservationOwner, state: row.state };
      return refusal("worker_busy", `worker ${input.threadId} is running another call`);
    }
    if (row.state !== "idle") return refusal("not_a_worker", `worker ${row.delegationId} has ended (${row.state})`);
    const running = listSlotHolders(db, row.rootThreadId);
    if (running.length >= settings.maxConcurrentChildren) return limitRefusal(settings.maxConcurrentChildren, running);
    const lease = newLease();
    db.prepare("UPDATE delegations SET state = 'active', client_request_id = ?, reservation_owner = ?, updated_at = ? WHERE delegation_id = ?")
      .run(owner, lease, now, row.delegationId);
    return { ok: true, reservationId: row.delegationId, lease, state: "active" };
  }).immediate();
}

// SANDY's facts must show the thread is a workflows-plus worker under the origin whose metadata passes the
// check (the reservation's run, and call for a spawn), and no ledger row holds it; null when it does.
async function unprovenWorker(host: WorkerThreadHost, originThreadId: string, threadId: string, names: (metadata: Readonly<Record<string, unknown>>, candidate: WorkerCandidate) => boolean): Promise<WorkerRefusal | null> {
  const listed = await host.workerCandidates(originThreadId, threadId);
  const candidate = listed?.find((entry) => entry.threadId === threadId);
  if (candidate === undefined) return refusal("not_a_worker", `thread ${threadId} is not a workflows-plus thread under ${originThreadId}`);
  if (!isWorkerThread(host.workerPluginId, candidate) || candidate.metadata.originThreadId !== originThreadId || !names(candidate.metadata, candidate)) {
    return refusal("not_a_worker", `thread ${threadId} is not a worker of this workflows-plus call`);
  }
  return null;
}

// reserved and unbound -> active, bound to the thread; false when the row moved or is bound meanwhile.
function bindWorker(db: Db, delegationId: string, threadId: string, now: number): boolean {
  return db.prepare(
    `UPDATE delegations SET state = 'active', child_thread_id = ?, bound_at = ?, updated_at = ?
       WHERE delegation_id = ? AND kind = 'workflow-worker' AND state = 'reserved' AND child_thread_id IS NULL`,
  ).run(threadId, now, now, delegationId).changes === 1;
}

function workerRow(db: Db, reservationId: string): DelegationRow | WorkerRefusal {
  const row = getDelegation(db, reservationId);
  if (row === null) return refusal("unknown_reservation", `unknown reservation ${reservationId}`);
  if (row.kind !== "workflow-worker") return refusal("not_a_worker", `${reservationId} is not a worker reservation`);
  return row;
}

// Reports the spawned thread of a reservation, under the lease admit granted. Idempotent for the same
// thread; a reservation the reconcile pass released meanwhile (or bound to another thread), a stale lease, or
// a thread SANDY does not show as this call's workflows-plus spawn under the origin is refused, and
// workflows-plus stops its spawn.
export async function attachWorker(db: Db, host: WorkerThreadHost, input: { reservationId: string; lease: string; threadId: string }, now = Date.now()): Promise<WorkerAttachResult> {
  const row = workerRow(db, input.reservationId);
  if ("ok" in row) return row;
  if (row.reservationOwner !== input.lease) return refusal("stale_lease", `reservation ${row.delegationId} is not held under this lease`);
  if (row.childThreadId === input.threadId) return { ok: true, reservationId: row.delegationId, threadId: input.threadId };
  const call = parseWorkerRequestId(row.clientRequestId);
  const unproven = call === null
    ? refusal("not_a_worker", `reservation ${row.delegationId} names no workflows-plus call`)
    : await unprovenWorker(host, row.parentThreadId, input.threadId, (_metadata, candidate) => isSpawnOfWorker(host.workerPluginId, row, call, candidate));
  if (unproven !== null) return unproven;
  const holder = getDelegationByChild(db, input.threadId);
  if (holder !== null) return refusal("not_a_worker", `thread ${input.threadId} is already bound to ${holder.delegationId}`);
  if (getDelegation(db, row.delegationId)!.reservationOwner === input.lease && bindWorker(db, row.delegationId, input.threadId, now)) {
    return { ok: true, reservationId: row.delegationId, threadId: input.threadId };
  }
  const latest = getDelegation(db, row.delegationId)!;
  return refusal("unknown_reservation", `reservation ${row.delegationId} is ${latest.state}${latest.childThreadId === null ? "" : ` and bound to ${latest.childThreadId}`}`);
}

// The call settled: an unbound reservation ends (error), a bound worker turns idle (a kept thread keeps its
// row for a continuation). Frees the slot only under the lease that holds it; released false when the row
// held no slot, a stale_lease refusal when another grant holds it now.
export function releaseWorker(db: Db, input: { reservationId: string; lease: string }, now = Date.now()): WorkerReleaseResult {
  const row = workerRow(db, input.reservationId);
  if ("ok" in row) return row;
  if (!SLOT_STATES.includes(row.state)) return { ok: true, released: false };
  if (row.reservationOwner !== input.lease) return refusal("stale_lease", `reservation ${row.delegationId} is held under another lease`);
  const released = db.prepare(
    `UPDATE delegations SET state = ?, reservation_owner = NULL, updated_at = ?
       WHERE delegation_id = ? AND reservation_owner = ? AND state IN (${sqlList(SLOT_STATES)})`,
  ).run(row.childThreadId === null ? "error" : "idle", now, row.delegationId, input.lease).changes === 1;
  return { ok: true, released };
}

// SANDY's facts about a thread under the origin, for the worker reconcile pass.
export type WorkerCandidate = { threadId: string; originPluginId: string | null; createdAt: number; metadata: Readonly<Record<string, unknown>> };

export interface WorkerThreadHost {
  // The plugin that spawns workers (sandy/work itself): SANDY stamps it as the worker thread's originPluginId.
  // Its delegate children carry the same id, so a worker is told apart by its workflowWorker metadata.
  readonly workerPluginId: string;
  // The threads the origin owns (lifecycle owner) or parents with workflows-plus pluginMetadata: the
  // unarchived ones, or only the named thread; null when SANDY cannot tell (origin unknown, listing incomplete).
  workerCandidates(originThreadId: string, threadId?: string): Promise<WorkerCandidate[] | null>;
  // The top of the thread's parent chain (the thread itself when it has no parent), as LaunchHost.rootOf.
  rootOf(threadId: string): Promise<string>;
}

export interface WorkerSweepHost extends WorkerThreadHost {
  threadState(threadId: string): Promise<{ status: string; archived: boolean } | null>;
  // The workflows part's answer whether the call attempt still runs; null when it is not linked.
  workerCallRunning(call: { runId: string; callId: string; attempt: number }): Promise<boolean | null>;
}

export type WorkerSweepReport = { attached: { reservationId: string; threadId: string }[]; released: string[]; idled: string[]; failures: { subject: string; error: string }[] };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isWorkerThread = (pluginId: string, candidate: WorkerCandidate): boolean =>
  candidate.originPluginId === pluginId && candidate.metadata.workflowWorker === 1;

function isSpawnOfWorker(pluginId: string, row: DelegationRow, call: { runId: string; callId: string }, candidate: WorkerCandidate): boolean {
  const metadata = candidate.metadata;
  return isWorkerThread(pluginId, candidate)
    && candidate.createdAt >= row.createdAt
    && metadata.runId === call.runId
    && metadata.callId === call.callId
    && metadata.originThreadId === row.parentThreadId;
}

// One pass over worker rows (run with the delegate watchdog sweep). An unbound reservation older than
// graceMs (any at startup) is attached to the one workflows-plus thread whose metadata names its run and
// call, or released once SPAWN_SETTLE_MS has passed with none listed; it keeps its slot otherwise. A bound
// worker whose thread SANDY no longer has, or shows idle/error and archived, or idle/error for longer than
// graceMs since the row last moved (workflows-plus died before its release), turns idle and frees its slot;
// a running worker never does, archived or not. A stopped worker whose call workflows-plus still runs (a
// reporting flow idles between its own turns) keeps it: workflows-plus releases it when the call settles,
// and its restart ends the calls it no longer runs. Without workflows-plus the stopped worker is freed.
export async function sweepWorkers(db: Db, host: WorkerSweepHost, graceMs: number, now = Date.now(), options: { startup?: boolean } = {}): Promise<WorkerSweepReport> {
  const report: WorkerSweepReport = { attached: [], released: [], idled: [], failures: [] };
  const reservations = db.prepare(
    "SELECT delegation_id AS id FROM delegations WHERE kind = 'workflow-worker' AND state = 'reserved' AND child_thread_id IS NULL ORDER BY created_at, rowid",
  ).all() as { id: string }[];
  for (const { id } of reservations) {
    const row = getDelegation(db, id)!;
    if (!options.startup && now - row.createdAt < graceMs) continue;
    const call = parseWorkerRequestId(row.clientRequestId);
    let listed: WorkerCandidate[] | null;
    try {
      listed = await host.workerCandidates(row.parentThreadId);
    } catch (error) {
      report.failures.push({ subject: id, error: message(error) });
      continue;
    }
    if (listed === null) continue;
    const spawns = call === null ? [] : listed.filter((candidate) => isSpawnOfWorker(host.workerPluginId, row, call, candidate) && getDelegationByChild(db, candidate.threadId) === null);
    if (spawns.length === 1) {
      if (bindWorker(db, id, spawns[0].threadId, now)) report.attached.push({ reservationId: id, threadId: spawns[0].threadId });
    } else if (spawns.length === 0 && now - row.createdAt >= SPAWN_SETTLE_MS) {
      const released = db.prepare("UPDATE delegations SET state = 'error', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state = 'reserved' AND child_thread_id IS NULL")
        .run(now, id).changes === 1;
      if (released) report.released.push(id);
    }
  }
  const bound = db.prepare(
    "SELECT delegation_id AS id FROM delegations WHERE kind = 'workflow-worker' AND state = 'active' AND child_thread_id IS NOT NULL ORDER BY updated_at, rowid",
  ).all() as { id: string }[];
  for (const { id } of bound) {
    const row = getDelegation(db, id)!;
    let state: Awaited<ReturnType<WorkerSweepHost["threadState"]>>;
    try {
      state = await host.threadState(row.childThreadId!);
    } catch (error) {
      report.failures.push({ subject: row.childThreadId!, error: message(error) });
      continue;
    }
    // Archiving does not end a running turn: an archived worker frees its slot once SANDY shows it stopped.
    const stopped = state !== null && STOPPED_STATUSES.includes(state.status);
    const ended = state === null || (stopped && (state.archived || now - row.updatedAt >= graceMs));
    if (!ended) continue;
    const call = parseWorkerRequestId(row.clientRequestId);
    if (state !== null && call !== null) {
      try {
        if ((await host.workerCallRunning(call)) === true) continue;
      } catch (error) {
        report.failures.push({ subject: id, error: message(error) });
        continue;
      }
    }
    const moved = db.prepare("UPDATE delegations SET state = 'idle', reservation_owner = NULL, updated_at = ? WHERE delegation_id = ? AND state = 'active' AND updated_at = ?")
      .run(now, id, row.updatedAt).changes === 1;
    if (moved) report.idled.push(id);
  }
  return report;
}
