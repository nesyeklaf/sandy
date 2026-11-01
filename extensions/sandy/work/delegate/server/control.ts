// sandy_delegate_send and sandy_delegate_stop: the parent's control of its delegated children, and the queue of
// inputs that wait for a slot. SANDY is reached only through ControlHost.
//
// Authority is the ledger's: the caller must be the delegation's parent_thread_id. A delegate (any thread
// bound to a delegation) is refused outright, whatever id it names, its own included; it does not get these
// tools in the first place (see delegateToolsFor), so this is the second line.
//
// Every operation on one delegation (send, stop, a drain's delivery or reconciliation, the watchdog's
// active -> idle) runs under its lock (withDelegationLock), so a stop waits for a send in flight and a send
// behind a stop finds the row ended and never reaches SANDY.
//
// Send: a child that holds a slot (starting, active) gets the message at once (steer-if-active reaches the
// running turn, queue-if-active lands after it). An idle child is re-admitted first (it takes a slot of the
// root: idle -> reserved, with an owner token), then the message is delivered and the row becomes active.
// When the root is full, or older inputs wait, the input is stored in pending_inputs and delivered in arrival
// order as slots free (the sweep's drainQueues); the call answers "queued".
//
// Delivery: each SANDY send is claimed in the ledger first (claimDelivery: the input admitted -> delivering, the
// child's newest turn event seq as the watermark, a "sending" delivery) and settled with SANDY's answer. Only a
// definitive 4xx (or a loss, below) undoes the reservation, only one a failed delivery took, and only once
// no other delivery of the child is left without an answer. Every open delivery (sending, unknown, or queued
// by SANDY with no turn started for it yet) holds the child's slot, whatever the row's state. Without a
// definitive answer (timeout, 5xx, lost response, or a process that died mid-send) the delivery is
// "unknown": a turn of the child starting above its watermark settles it as delivered; none within
// DELIVERY_SETTLE_MS while SANDY shows the thread not running settles it as lost, and a queued input is then
// queued again and sent again. A message SANDY queued is closed the same way, its window counted from the
// completion of the turn it waited behind, and is not sent again. SANDY's thread send (plugin SDK 0.6.79) takes no idempotency key or client
// message id, so a queued input is delivered at least once: one SANDY took whose turn never started within
// the window is sent twice. A direct send without a definitive answer is reported (delivery_unconfirmed),
// not resent.
//
// Questions (sandy_ask_parent): an answer, and the notice that a question expired or was cancelled, is an input
// like a send: recorded with the question's move in one transaction, admitted the same way (an idle child
// waits FIFO for a slot), and always stored as a pending input, so a failed or lost delivery is retried by
// the drain. Its delivery hands it to the sandy_ask_parent call waiting for it in this process (answerWaiters:
// the call's result reaches the child), or else sends the pointer message (the child then calls
// sandy_question_answer). The parent's send to a child with an open question answers that question.
//
// Stop: the row becomes "stopped" (queued and unclaimed inputs cancelled) and the child gets a durable stop
// request (reason parent_stop), carried out at once and, until SANDY confirms it, by every sweep; the row keeps
// its slot until then. A message SANDY takes after the row ended opens the stop request again. Only the named
// children are stopped: nothing here, or in the watchdog, stops a parent's children because the parent stopped.
import type Database from "better-sqlite3";
import { z } from "zod";
import { withDelegationLock } from "./delegation-lock.ts";
import {
  admitNextQueued, cancelInput, claimDelivery, END_STATES, getDelegation, getDelegationByChild, getDelivery, getPendingInput, getStopRequest,
  hasInputInDelivery, listAdmittedInputs, listOpenDeliveries, listOpenDelegationsOf, listStaleReserved, moveReservedToActive, moveReservedToIdle,
  readmit, recordAdmittedInput, releaseUnsent, rootsWithQueued, settleDelivery, stopDelegation, type DelegationRow, type DeliveryOutcome, type PendingInput, transition,
} from "./ledger.ts";
import { getOpenQuestion, getQuestion, recordAnswer, type AnswerRefusal, type AnswerSource, type Question } from "./questions.ts";
import type { DelegateSettings } from "./settings.ts";
import { carryOutStops, STOPPED_STATUSES, watchdogWindowMs, type SweepReport, type WatchdogHost } from "./watchdog.ts";

type Db = Database.Database;

export const sendParameters = z.object({
  delegationId: z.string().min(1).describe("Delegation id returned by sandy_delegate; it must have been started by this thread."),
  message: z.string().min(1).describe("The message for the child."),
  mode: z.enum(["steer", "queue"]).describe("steer: into the child's running turn. queue: after its current turn. An idle child is re-admitted first; when all slots of this thread are taken the input waits and is delivered when one frees (the result says queued)."),
});

export const stopParameters = z.object({
  delegationId: z.string().min(1).optional().describe("Delegation id of the child to stop."),
  all: z.literal(true).optional().describe("true: stop every child of this thread that has not ended."),
});

export type SendMode = "steer" | "queue";

export type ControlSettings = Pick<DelegateSettings, "maxConcurrentChildren" | "briefWatchdogSeconds">;

export interface ControlHost extends Pick<WatchdogHost, "stop" | "threadState" | "latestTurnEvents" | "turnEventsAfter"> {
  // SANDY's thread send as steer-if-active (steer) or queue-if-active (queue): into the running turn, or after
  // it, or as the start of a new turn when the thread is idle. Rejects when SANDY refuses it; the error carries
  // SANDY's HTTP status when there is one.
  send(threadId: string, message: string, mode: SendMode): Promise<{ delivery: "sent" | "queued" }>;
  // Delegations with an input delivery in flight in this process; the sweep does not redo those.
  readonly deliveriesInFlight: Set<string>;
  // The plugin's log (sandy plugin logs): every delivery closed as lost is written there.
  warn(line: string): void;
  // sandy_ask_parent calls of this process waiting for their question's answer or end notice, by question id.
  readonly answerWaiters: Map<string, (payload: QuestionInputPayload) => void>;
  // The form asking each open question in this process, by question id; aborted once the question is answered or ends.
  readonly questionForms: Map<string, QuestionForm>;
}

export type QuestionForm = { formId: string; abort: AbortController };

// answer: the question was answered; expired/cancelled: it ended without an answer.
export type QuestionNotice = "answer" | "expired" | "cancelled";
// The payload of a question's input. message: what a send carries when no sandy_ask_parent call waits for it
// (for an answer the pointer to sandy_question_answer, never the answer itself).
export type QuestionInputPayload = { message: string; mode: "queue"; questionId: string; notice: QuestionNotice };

export const answerPointer = (questionId: string): string => `answer to question ${questionId} is ready, call sandy_question_answer(${questionId})`;

export type ControlRefusal = {
  code: "delegate_caller" | "unknown_delegation" | "not_parent" | "not_started" | "delegation_ended" | "send_failed" | "delivery_unconfirmed";
  delegationId: string;
  message: string;
};

// delivered: handed to the child (its waiting call or a pointer message); queued: waits for a slot; retrying:
// the delivery failed or is unconfirmed, the drain retries it.
export type QuestionDeliveryStatus = "delivered" | "queued" | "retrying";

export type SendOutcome =
  | { ok: true; status: "delivered"; delegationId: string; threadId: string; readmitted: boolean; sandyDelivery: "sent" | "queued" }
  | { ok: true; status: "answered"; delegationId: string; threadId: string; questionId: string; delivery: QuestionDeliveryStatus }
  | { ok: true; status: "queued"; delegationId: string; threadId: string; inputId: string; message: string }
  | { ok: false; refusal: ControlRefusal };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
};

const refusal = (code: ControlRefusal["code"], delegationId: string, message: string): { ok: false; refusal: ControlRefusal } => ({ ok: false, refusal: { code, delegationId, message } });

// The checks every control call makes: a delegate is refused, then the delegation must exist and be the
// caller's own child.
function authorize(db: Db, callerThreadId: string, delegationId: string): { ok: true; row: DelegationRow } | { ok: false; refusal: ControlRefusal } {
  if (getDelegationByChild(db, callerThreadId) !== null) {
    return refusal("delegate_caller", delegationId, "a delegated child cannot send to or stop delegations");
  }
  const row = getDelegation(db, delegationId);
  if (row === null) return refusal("unknown_delegation", delegationId, "no delegation " + delegationId);
  if (row.parentThreadId !== callerThreadId) return refusal("not_parent", delegationId, "delegation " + delegationId + " was not started by this thread");
  return { ok: true, row };
}

type InputPayload = { message: string; mode: SendMode; questionId?: string; notice?: QuestionNotice };

const isQuestionPayload = (payload: InputPayload): payload is QuestionInputPayload => typeof payload.questionId === "string";

const isPayload = (value: unknown): value is InputPayload => {
  const payload = value as Partial<InputPayload> | null;
  return typeof payload?.message === "string" && (payload.mode === "steer" || payload.mode === "queue");
};

// How long a delivery without SANDY's definitive answer may stay open before, with no turn of the child started
// above its watermark and SANDY showing the thread not running, it counts as lost: SANDY's send settles within
// seconds, and a message SANDY queued behind a running turn starts its own turn when that one completes. The
// same reasoning and length as SPAWN_SETTLE_MS.
export const DELIVERY_SETTLE_MS = 10 * 60_000;

type Delivered =
  | { ok: true; sandyDelivery: "sent" | "queued" }
  // settled: the next queued input may go on (false: SANDY looks unreachable, the drain stops for this root).
  | { ok: false; code: "delegation_ended" | "send_failed" | "delivery_unconfirmed"; settled: boolean; error: string };

// Sends one message to the child of a row that holds a slot; the caller holds the delegation's lock. inputId:
// the pending input (admitted) to deliver, null for a direct send. reservationOwner: the token of the
// reservation the caller's admission took, null when the child held its slot. The delivery is claimed
// (claimDelivery) right before SANDY's send and settled with SANDY's answer: taken (sent/queued), 404 (gone: the
// row is an error), another 4xx except 408 (rejected: the input is cancelled, this reservation undone), or
// anything else (unknown: the slot is kept until drainQueues reconciles it).
async function deliver(db: Db, host: ControlHost, delegationId: string, payload: InputPayload, inputId: string | null, reservationOwner: string | null, now = Date.now()): Promise<Delivered> {
  const childThreadId = getDelegation(db, delegationId)!.childThreadId!;
  host.deliveriesInFlight.add(delegationId);
  try {
    let afterSeq: number | null;
    try {
      afterSeq = (await host.latestTurnEvents(childThreadId, 1))?.at(-1)?.seq ?? null;
    } catch (error) {
      releaseUnsent(db, delegationId, inputId, reservationOwner, now);
      return { ok: false, code: "send_failed", settled: false, error: errorText(error) };
    }
    const claim = claimDelivery(db, { delegationId, inputId, reservationOwner, afterSeq }, now);
    if (!claim.ok) {
      const error = claim.reason === "ended" ? "the delegation ended" : claim.reason === "no_slot" ? "the delegation no longer holds a slot" : "the input is no longer waiting";
      return { ok: false, code: claim.reason === "ended" ? "delegation_ended" : "send_failed", settled: true, error };
    }
    const waiter = isQuestionPayload(payload) ? host.answerWaiters.get(payload.questionId) : undefined;
    if (waiter !== undefined && isQuestionPayload(payload)) {
      // The waiting sandy_ask_parent call returns with it; SANDY posts that result to the child.
      host.answerWaiters.delete(payload.questionId);
      waiter(payload);
      settleDelivery(db, claim.delivery.deliveryId, "sent", now);
      return { ok: true, sandyDelivery: "sent" };
    }
    try {
      const sent = await host.send(childThreadId, payload.message, payload.mode);
      settleDelivery(db, claim.delivery.deliveryId, sent.delivery, now);
      return { ok: true, sandyDelivery: sent.delivery };
    } catch (error) {
      const status = statusOf(error);
      const outcome: DeliveryOutcome = status === 404 ? "gone" : status !== null && status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown";
      settleDelivery(db, claim.delivery.deliveryId, outcome, now);
      if (outcome !== "unknown") return { ok: false, code: "send_failed", settled: true, error: errorText(error) };
      return {
        ok: false, code: "delivery_unconfirmed", settled: false,
        error: "SANDY did not confirm the delivery (" + errorText(error) + "); the child keeps its slot until its turn events show whether the message arrived",
      };
    }
  } finally {
    host.deliveriesInFlight.delete(delegationId);
  }
}

export async function sendToDelegation(
  db: Db, host: ControlHost, settings: ControlSettings,
  request: { callerThreadId: string; delegationId: string; message: string; mode: SendMode }, now = Date.now(),
): Promise<SendOutcome> {
  const allowed = authorize(db, request.callerThreadId, request.delegationId);
  if (!allowed.ok) return allowed;
  const { row } = allowed;
  if (row.childThreadId === null) return refusal("not_started", row.delegationId, "delegation " + row.delegationId + " has no child thread yet");
  const childThreadId = row.childThreadId;
  const payload: InputPayload = { message: request.message, mode: request.mode };
  return withDelegationLock(row.delegationId, async (): Promise<SendOutcome> => {
    const open = getOpenQuestion(db, row.delegationId);
    if (open !== null) {
      const answered = await answerLocked(db, host, settings, { questionId: open.questionId, answer: request.message, source: "parent_send" }, now);
      if (answered.ok) return { ok: true, status: "answered", delegationId: row.delegationId, threadId: childThreadId, questionId: open.questionId, delivery: answered.delivery };
      if (answered.reason === "delegation_ended") return refusal("delegation_ended", row.delegationId, "delegation " + row.delegationId + " has ended");
      // Answered by another source since the read: the message goes out as a plain send.
    }
    const admitted = readmit(db, { delegationId: row.delegationId, input: { kind: request.mode, payload } }, settings, now);
    if (!admitted.ok) {
      const state = admitted.refusal.code === "delegation_ended" ? admitted.refusal.state : "unknown";
      return refusal(admitted.refusal.code === "delegation_ended" ? "delegation_ended" : "unknown_delegation", row.delegationId, "delegation " + row.delegationId + " is " + state);
    }
    if (admitted.status === "queued") {
      return {
        ok: true, status: "queued", delegationId: row.delegationId, threadId: childThreadId, inputId: admitted.pendingInput.inputId,
        message: "the child is idle and the root's slots are full; the input is delivered when a slot frees",
      };
    }
    const delivered = await deliver(db, host, row.delegationId, payload, null, admitted.status === "admitted" ? admitted.reservationOwner : null, now);
    if (!delivered.ok) return refusal(delivered.code, row.delegationId, delivered.error);
    return { ok: true, status: "delivered", delegationId: row.delegationId, threadId: childThreadId, readmitted: admitted.status === "admitted", sandyDelivery: delivered.sandyDelivery };
  });
}

export type AnswerOutcome =
  | { ok: true; question: Question; delivery: QuestionDeliveryStatus }
  | { ok: false; reason: AnswerRefusal | "delegation_ended" };

type QuestionInput = { pendingInput: PendingInput; reservationOwner: string | null; queued: boolean };

// Inside the transaction of the question's move: admits its input like a send (readmit) and stores it as a
// pending input also when admitted at once. null: the delegation ended.
function admitQuestionInput(db: Db, delegationId: string, payload: QuestionInputPayload, settings: ControlSettings, now: number): QuestionInput | null {
  const input = { kind: "answer" as const, payload };
  const admitted = readmit(db, { delegationId, input }, settings, now);
  if (!admitted.ok) return null;
  if (admitted.status === "queued") return { pendingInput: admitted.pendingInput, reservationOwner: null, queued: true };
  return { pendingInput: recordAdmittedInput(db, delegationId, input, now), reservationOwner: admitted.status === "admitted" ? admitted.reservationOwner : null, queued: false };
}

// The question's form is closed (SANDY stops showing it); its late result is stale.
function closeQuestionForm(host: ControlHost, questionId: string): void {
  host.questionForms.get(questionId)?.abort.abort();
  host.questionForms.delete(questionId);
}

// Moves the question (move: a compare-and-set, false refuses) and admits its input in one transaction, then
// delivers the input unless it waits for a slot. The caller holds the delegation's lock.
async function moveAndDeliver(
  db: Db, host: ControlHost, settings: ControlSettings, question: Question, move: () => { ok: true } | { ok: false; reason: AnswerRefusal },
  payload: QuestionInputPayload, now: number,
): Promise<{ ok: true; delivery: QuestionDeliveryStatus } | { ok: false; reason: AnswerRefusal | "delegation_ended" }> {
  const step = db.transaction((): { ok: true; input: QuestionInput } | { ok: false; reason: AnswerRefusal | "delegation_ended" } => {
    const row = getDelegation(db, question.delegationId);
    if (row === null || END_STATES.includes(row.state) || row.childThreadId === null) return { ok: false, reason: "delegation_ended" };
    const moved = move();
    if (!moved.ok) return moved;
    return { ok: true, input: admitQuestionInput(db, question.delegationId, payload, settings, now)! };
  }).immediate();
  if (!step.ok) return step;
  closeQuestionForm(host, question.questionId);
  if (step.input.queued) return { ok: true, delivery: "queued" };
  const delivered = await deliver(db, host, question.delegationId, payload, step.input.pendingInput.inputId, step.input.reservationOwner, now);
  return { ok: true, delivery: delivered.ok ? "delivered" : "retrying" };
}

async function answerLocked(
  db: Db, host: ControlHost, settings: ControlSettings, request: { questionId: string; answer: string; source: AnswerSource; formId?: string }, now: number,
): Promise<AnswerOutcome> {
  const question = getQuestion(db, request.questionId);
  if (question === null) return { ok: false, reason: "unknown_question" };
  const payload: QuestionInputPayload = { message: answerPointer(question.questionId), mode: "queue", questionId: question.questionId, notice: "answer" };
  const outcome = await moveAndDeliver(db, host, settings, question, () => recordAnswer(db, request, now), payload, now);
  return outcome.ok ? { ok: true, question: getQuestion(db, question.questionId)!, delivery: outcome.delivery } : outcome;
}

// Answers an open question (open -> answered, compare-and-set: of two answers the first wins, the other is
// refused; a form's answer only while that form is the question's current one) and delivers the answer
// like a send: admitted first, queued while the root is full.
export function answerQuestion(
  db: Db, host: ControlHost, settings: ControlSettings, request: { questionId: string; answer: string; source: AnswerSource; formId?: string }, now = Date.now(),
): Promise<AnswerOutcome> {
  const question = getQuestion(db, request.questionId);
  if (question === null) return Promise.resolve({ ok: false, reason: "unknown_question" });
  return withDelegationLock(question.delegationId, () => answerLocked(db, host, settings, request, now));
}

// Ends an open question without an answer (expired, cancelled; move: its compare-and-set) and tells the
// child, delivered like an answer. false: the question was not open (or its delegation ended).
export function endQuestion(
  db: Db, host: ControlHost, settings: ControlSettings, question: Question, notice: "expired" | "cancelled", message: string, move: () => boolean, now = Date.now(),
): Promise<boolean> {
  const payload: QuestionInputPayload = { message, mode: "queue", questionId: question.questionId, notice };
  return withDelegationLock(question.delegationId, async () => {
    const outcome = await moveAndDeliver(db, host, settings, question, () => (move() ? { ok: true } : { ok: false, reason: "not_open" }), payload, now);
    return outcome.ok;
  });
}

// Queues the pointer to an answered question's answer again (plugin load: the sandy_ask_parent call that
// waited for it is gone). Delivered like an answer; false when it is no longer answered.
export function requeueAnswerPointer(db: Db, host: ControlHost, settings: ControlSettings, question: Question, now = Date.now()): Promise<boolean> {
  const payload: QuestionInputPayload = { message: answerPointer(question.questionId), mode: "queue", questionId: question.questionId, notice: "answer" };
  return withDelegationLock(question.delegationId, async () => {
    const outcome = await moveAndDeliver(db, host, settings, question, () => (getQuestion(db, question.questionId)?.state === "answered" ? { ok: true } : { ok: false, reason: "not_open" }), payload, now);
    return outcome.ok;
  });
}

export type StopEntry = { delegationId: string; threadId: string; state: DelegationRow["state"]; stopConfirmed: boolean; error?: string };
export type StopOutcome =
  | { ok: true; stopped: StopEntry[]; skipped: { delegationId: string; reason: string }[] }
  | { ok: false; refusal: ControlRefusal };

// Stops one child of the caller (delegationId) or every one of its not ended children (all). A child already
// ended is reported as it is; a delegation without a child thread yet (its spawn is in flight) is refused when
// named and skipped under all.
export async function stopDelegations(
  db: Db, host: ControlHost, settings: ControlSettings,
  request: { callerThreadId: string; delegationId?: string; all?: boolean }, now = Date.now(),
): Promise<StopOutcome> {
  let targets: DelegationRow[];
  if (request.delegationId !== undefined) {
    const allowed = authorize(db, request.callerThreadId, request.delegationId);
    if (!allowed.ok) return allowed;
    if (allowed.row.childThreadId === null && !END_STATES.includes(allowed.row.state)) {
      return refusal("not_started", allowed.row.delegationId, "delegation " + allowed.row.delegationId + " has no child thread yet");
    }
    targets = [allowed.row];
  } else {
    if (getDelegationByChild(db, request.callerThreadId) !== null) return refusal("delegate_caller", "", "a delegated child cannot send to or stop delegations");
    targets = listOpenDelegationsOf(db, request.callerThreadId);
  }
  const skipped: { delegationId: string; reason: string }[] = [];
  const stopping: DelegationRow[] = [];
  const entries = new Map<string, StopEntry>();
  for (const target of targets) {
    if (target.childThreadId === null) {
      skipped.push({ delegationId: target.delegationId, reason: "no child thread yet" });
      continue;
    }
    // Under the lock: a send in flight reaches SANDY before this stop, a later one finds the row stopped.
    const current = await withDelegationLock(target.delegationId, async () => {
      const moved = END_STATES.includes(getDelegation(db, target.delegationId)!.state) ? null : stopDelegation(db, target.delegationId, now);
      if (moved !== null) stopping.push(moved);
      return getDelegation(db, target.delegationId)!;
    });
    entries.set(target.delegationId, { delegationId: current.delegationId, threadId: target.childThreadId, state: current.state, stopConfirmed: false });
  }
  const requests = [...entries.values()].map((entry) => getStopRequest(db, entry.threadId)).filter((open) => open !== null && open.stoppedAt === null);
  const report = { stopped: [] as string[], failures: [] as { subject: string; error: string }[] };
  await carryOutStops(db, host, requests as NonNullable<(typeof requests)[number]>[], watchdogWindowMs(settings), now, report);
  for (const entry of entries.values()) {
    const stop = getStopRequest(db, entry.threadId);
    entry.stopConfirmed = stop === null || stop.stoppedAt !== null;
    const failure = report.failures.find((item) => item.subject === entry.threadId);
    if (failure !== undefined) entry.error = failure.error;
  }
  await drainQueues(db, host, settings, now);
  return { ok: true, stopped: [...entries.values()], skipped };
}

export type DrainReport = { delivered: string[]; settled: string[]; failures: { subject: string; error: string }[] };

// The drain running on a DB in this process, and the time of a drain asked for while it runs.
const drains = new WeakMap<Db, { promise: Promise<DrainReport>; again: number | null }>();

// Delivers what waits. Single-flight per DB: a call while a drain runs makes it run once more when done and
// answers its (merged) report. Each pass, under each delegation's lock: settles the deliveries left without
// SANDY's answer (reconcileDelivery), delivers the admitted inputs no delivery claimed (a process lost them
// before their claim, nothing reached SANDY), then, root by root, the queued inputs in arrival order while
// slots are free. A bound row left in "reserved" for longer than the watchdog window with nothing in
// delivery is settled from SANDY's status (a running thread: active, otherwise idle). Run at the end of every
// sweep, and after a stop.
export function drainQueues(db: Db, host: ControlHost, settings: ControlSettings, now = Date.now()): Promise<DrainReport> {
  const running = drains.get(db);
  if (running !== undefined) {
    running.again = Math.max(running.again ?? now, now);
    return running.promise;
  }
  const current = { promise: Promise.resolve<DrainReport>({ delivered: [], settled: [], failures: [] }), again: null as number | null };
  drains.set(db, current);
  current.promise = (async () => {
    const report: DrainReport = { delivered: [], settled: [], failures: [] };
    try {
      for (let at: number | null = now; at !== null; at = current.again) {
        current.again = null;
        await drainOnce(db, host, settings, at, report);
      }
      return report;
    } finally {
      drains.delete(db);
    }
  })();
  return current.promise;
}

async function drainOnce(db: Db, host: ControlHost, settings: ControlSettings, now: number, report: DrainReport): Promise<void> {
  // Under the input's delegation lock. false: stop this root's queue for now. reservationOwner "inherit": an
  // input a lost process admitted, its delivery takes over the reservation that process took.
  const run = (inputId: string, delegationId: string, reservationOwner: string | null | "inherit") => withDelegationLock(delegationId, async (): Promise<boolean> => {
    const input = getPendingInput(db, inputId);
    if (input === null || input.state !== "admitted") return true;
    if (!isPayload(input.payload)) {
      cancelInput(db, input.inputId);
      report.failures.push({ subject: input.inputId, error: "unreadable payload, input cancelled" });
      return true;
    }
    const row = getDelegation(db, delegationId)!;
    if (END_STATES.includes(row.state) || row.childThreadId === null) {
      cancelInput(db, input.inputId);
      return true;
    }
    const owner = reservationOwner === "inherit" ? (row.state === "reserved" ? row.reservationOwner : null) : reservationOwner;
    // An answer the child took meanwhile (sandy_question_answer after an earlier pointer) needs no pointer.
    if (isQuestionPayload(input.payload) && input.payload.notice === "answer" && getQuestion(db, input.payload.questionId)?.state !== "answered") {
      cancelInput(db, input.inputId);
      if (owner !== null) moveReservedToIdle(db, delegationId, owner, now);
      return true;
    }
    const result = await deliver(db, host, delegationId, input.payload, input.inputId, owner, now);
    if (result.ok) report.delivered.push(input.inputId);
    else report.failures.push({ subject: input.inputId, error: result.error });
    return result.ok || result.settled;
  });
  for (const delivery of listOpenDeliveries(db)) {
    if (host.deliveriesInFlight.has(delivery.delegationId)) continue;
    await withDelegationLock(delivery.delegationId, () => reconcileDelivery(db, host, delivery.deliveryId, now, report));
  }
  for (const input of listAdmittedInputs(db)) {
    if (!host.deliveriesInFlight.has(input.delegationId)) await run(input.inputId, input.delegationId, "inherit");
  }
  for (const root of rootsWithQueued(db)) {
    for (let next = admitNextQueued(db, root, settings, now); next !== null; next = admitNextQueued(db, root, settings, now)) {
      if (!(await run(next.pendingInput.inputId, next.delegation.delegationId, next.reservationOwner))) break;
    }
  }
  for (const stale of listStaleReserved(db, now - watchdogWindowMs(settings))) {
    if (host.deliveriesInFlight.has(stale.delegationId)) continue;
    await withDelegationLock(stale.delegationId, async () => {
      const row = getDelegation(db, stale.delegationId)!;
      if (row.state !== "reserved" || row.updatedAt !== stale.updatedAt || hasInputInDelivery(db, row.delegationId)) return;
      try {
        const thread = await host.threadState(row.childThreadId!);
        if (thread === null) transition(db, row.delegationId, "error", now);
        else if (STOPPED_STATUSES.includes(thread.status)) moveReservedToIdle(db, row.delegationId, row.reservationOwner, now);
        else moveReservedToActive(db, row.delegationId, row.reservationOwner, now);
        report.settled.push(row.delegationId);
      } catch (error) {
        report.failures.push({ subject: row.childThreadId!, error: errorText(error) });
      }
    });
  }
}

// Settles an open delivery, under the delegation's lock: a turn of the child that started above the
// delivery's watermark means SANDY took the message (sent). Without one it is lost once SANDY shows the thread not
// running DELIVERY_SETTLE_MS after the send (unknown, or sending in a process that died: its input is queued
// again, sent again, at least once) or after the completion of the turn a queued message waited behind (the
// send when no completion came; not sent again, SANDY had taken it). A thread SANDY no longer has is gone. Every
// lost close is logged.
async function reconcileDelivery(db: Db, host: ControlHost, deliveryId: string, now: number, report: DrainReport): Promise<void> {
  const delivery = getDelivery(db, deliveryId);
  if (delivery === null || (delivery.state !== "sending" && delivery.state !== "unknown" && delivery.state !== "queued")) return;
  const childThreadId = getDelegation(db, delivery.delegationId)!.childThreadId!;
  const subject = delivery.inputId ?? delivery.deliveryId;
  try {
    // The first two events above the watermark: the completion of the turn running at the send, then the next start.
    const after = await host.turnEventsAfter(childThreadId, delivery.afterSeq, 2);
    let outcome: DeliveryOutcome | null = null;
    const settleFrom = delivery.state === "queued" ? (after?.find((event) => event.type === "completed")?.at ?? delivery.startedAt) : delivery.startedAt;
    if (after === null) outcome = "gone";
    else if (after.some((event) => event.type === "started")) outcome = "sent";
    else if (now - settleFrom >= DELIVERY_SETTLE_MS) {
      const thread = await host.threadState(childThreadId);
      if (thread === null) outcome = "gone";
      else if (STOPPED_STATUSES.includes(thread.status)) outcome = "lost";
    }
    if (outcome === null || !settleDelivery(db, deliveryId, outcome, now)) return;
    if (outcome === "sent") report.delivered.push(subject);
    else if (outcome === "gone") report.failures.push({ subject, error: "the child thread no longer exists" });
    else {
      const requeued = delivery.state !== "queued" && delivery.inputId !== null && getPendingInput(db, delivery.inputId)?.state === "queued";
      host.warn(
        "delivery " + delivery.deliveryId + " of " + delivery.delegationId + " (input " + (delivery.inputId ?? "none, direct send") + ") closed as lost after "
        + (now - delivery.startedAt) + " ms: no turn of the child took the message" + (requeued ? ", queued again" : ""),
      );
    }
  } catch (error) {
    report.failures.push({ subject: childThreadId, error: errorText(error) });
  }
}

// The sweep hook: drains the queues and puts the outcome into the sweep's report.
export async function drainAfterSweep(db: Db, host: ControlHost, settings: ControlSettings, report: SweepReport, now = Date.now()): Promise<void> {
  const drained = await drainQueues(db, host, settings, now);
  report.failures.push(...drained.failures);
}

