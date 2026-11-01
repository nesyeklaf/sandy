// Child questions (sandy_ask_parent, sandy_question_answer), plugin half: the form that asks, the answer's way to
// the child, and the sweep that expires, cancels and re-asks.
//
// sandy_ask_parent opens the question (one open per child) and asks it in a SANDY form (renderer "question") on the
// child thread; SANDY answers the tool call at once with a waiting notice, the call's result reaches the child
// later as a message. The answer comes from that form, from the parent's sandy_delegate_send or from the
// answerQuestion RPC (control.ts answerQuestion: compare-and-set, then admitted and delivered like a send). Its
// delivery hands it to this call, which consumes it (answered -> delivered, compare-and-set) and returns it
// with the question id. Without a waiting call (plugin reloaded, form interrupted) the child gets a pointer
// message and takes the answer with sandy_question_answer, once; a repeat returns "already delivered".
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { answerQuestion, endQuestion, requeueAnswerPointer, type ControlHost, type ControlSettings, type QuestionInputPayload } from "./control.ts";
import { END_STATES, getDelegation, getDelegationByChild } from "./ledger.ts";
import {
  askQuestion, cancelQuestion, expireQuestion, getQuestion, listAnsweredWithoutLiveInput, listExpiredOpenQuestions, listOpenQuestions,
  listQuestionsOfEndedDelegations, markQuestionDelivered, questionTimeoutMs, setQuestionForm, type Question,
} from "./questions.ts";

type Db = Database.Database;

export const QUESTION_RENDERER = "question";

export type QuestionSettings = ControlSettings & { questionTimeoutDays: number };

// The form's payload, read by the "question" renderer (app.tsx).
export type QuestionFormPayload = { questionId: string; question: string; options: string[] };

export type FormRequest = { threadId: string; title: string; payload: QuestionFormPayload; timeoutMs: number };
export type FormCancelReason = "plugin-disposed" | "request-aborted" | "server-restarted" | "thread-deleted" | "thread-stopped" | "timeout" | "user";
export type FormResult = { outcome: "submitted"; value: unknown } | { outcome: "cancelled"; reason: FormCancelReason };

export interface QuestionHost extends ControlHost {
  // sandy.ui.requestInput with rendererId "question".
  requestInput(request: FormRequest, signal: AbortSignal): Promise<FormResult>;
}

// How a form ended for its question. answered: its answer was taken; ended: the question expired or was
// cancelled; interrupted: SANDY dropped the form (reload, restart), the question stays open and is re-asked;
// stale: the result came from a form the question no longer names, or the question was no longer open.
export type FormEnd = "answered" | "ended" | "interrupted" | "stale";

const INTERRUPTED: readonly FormCancelReason[] = ["plugin-disposed", "request-aborted", "server-restarted"];

const formTitle = (question: Question): string => {
  const line = question.question.split("\n")[0]!.trim();
  return line.length <= 80 ? line : line.slice(0, 79) + "…";
};

// The answer in a submitted form value: the renderer submits { answer }, a CLI or SDK response may be a string.
export function formAnswer(value: unknown): string | null {
  const answer = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as { answer?: unknown }).answer : undefined;
  return typeof answer === "string" && answer.trim() !== "" ? answer : null;
}

export const expiredNotice = (question: Question): string =>
  "question " + question.questionId + " expired without an answer; continue without it or ask again with sandy_ask_parent";
export const cancelledNotice = (question: Question): string =>
  "question " + question.questionId + " was dismissed without an answer; continue without it or ask again with sandy_ask_parent";

// Applies a form's result to its question (formId: that form; a result of an older form is stale).
export async function handleFormResult(
  db: Db, host: QuestionHost, settings: QuestionSettings, question: Question, formId: string, result: FormResult, now = Date.now(),
): Promise<FormEnd> {
  const current = host.questionForms.get(question.questionId);
  if (current?.formId === formId) host.questionForms.delete(question.questionId);
  if (result.outcome === "submitted") {
    // Accepted residual: SANDY reports no submitter, so any caller that can run `sandy thread interactions respond`
    // (including a bash-capable child) can answer the current form; form_id only fences stale forms.
    const answer = formAnswer(result.value);
    if (answer === null) return "stale";
    const answered = await answerQuestion(db, host, settings, { questionId: question.questionId, answer, source: "form", formId }, now);
    return answered.ok ? "answered" : "stale";
  }
  switch (result.reason) {
    case "timeout":
      return (await endQuestion(db, host, settings, question, "expired", expiredNotice(question), () => expireQuestion(db, question.questionId, formId, now), now)) ? "ended" : "stale";
    case "user":
      return (await endQuestion(db, host, settings, question, "cancelled", cancelledNotice(question), () => cancelQuestion(db, question.questionId, { formId }, now), now)) ? "ended" : "stale";
    case "thread-deleted":
    case "thread-stopped":
      // The child was stopped or deleted: nothing to tell it.
      return cancelQuestion(db, question.questionId, { formId }, now) ? "ended" : "stale";
    default:
      return getQuestion(db, question.questionId)?.state === "open" && getQuestion(db, question.questionId)?.formId === formId ? "interrupted" : "stale";
  }
}

// Asks the open question in a new form on the child thread (signal: the asking tool call's, if any). The
// form becomes the question's current one; it is closed (aborted) when the question is answered or ends.
export async function openQuestionForm(
  db: Db, host: QuestionHost, settings: QuestionSettings, question: Question, childThreadId: string, formId: string, signal?: AbortSignal, now = Date.now(),
): Promise<FormEnd> {
  const abort = new AbortController();
  if (signal !== undefined) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  host.questionForms.set(question.questionId, { formId, abort });
  let result: FormResult;
  try {
    result = await host.requestInput({
      threadId: childThreadId, title: formTitle(question),
      payload: { questionId: question.questionId, question: question.question, options: question.options },
      timeoutMs: Math.max(1, question.expiresAt - now),
    }, abort.signal);
  } catch (error) {
    if (host.questionForms.get(question.questionId)?.formId === formId) host.questionForms.delete(question.questionId);
    throw error;
  }
  return handleFormResult(db, host, settings, question, formId, result);
}

const newFormId = (): string => "frm_" + randomUUID();

export type AskOutcome =
  | { kind: "answer"; questionId: string; answer: string; alreadyDelivered: boolean }
  | { kind: "ended"; questionId: string; message: string }
  | { kind: "still_open"; questionId: string }
  | { kind: "aborted"; questionId: string }
  | { kind: "refused"; code: "not_a_delegate" | "delegation_ended" | "question_open"; message: string };

// The answer handed to the waiting call: consumed here (answered -> delivered); if sandy_question_answer took it
// first, it is returned as already delivered.
function consume(db: Db, payload: QuestionInputPayload): AskOutcome {
  const question = getQuestion(db, payload.questionId)!;
  if (payload.notice !== "answer") return { kind: "ended", questionId: question.questionId, message: payload.message };
  const delivered = markQuestionDelivered(db, question.questionId);
  return { kind: "answer", questionId: question.questionId, answer: getQuestion(db, question.questionId)!.answer ?? "", alreadyDelivered: !delivered };
}

// sandy_ask_parent: opens the question, asks it and waits for its answer or end. An interrupted form leaves
// the question open (still_open: re-asked by the sweep, its answer follows as a pointer message).
export async function askParent(
  db: Db, host: QuestionHost, settings: QuestionSettings,
  request: { childThreadId: string; question: string; options?: readonly string[]; signal: AbortSignal }, now = Date.now(),
): Promise<AskOutcome> {
  const row = getDelegationByChild(db, request.childThreadId);
  if (row === null) return { kind: "refused", code: "not_a_delegate", message: "this thread is not a sandy-delegate child" };
  if (END_STATES.includes(row.state)) return { kind: "refused", code: "delegation_ended", message: "delegation " + row.delegationId + " has ended" };
  const formId = newFormId();
  const asked = askQuestion(db, {
    delegationId: row.delegationId, question: request.question, options: request.options ?? [], formId, timeoutMs: questionTimeoutMs(settings.questionTimeoutDays),
  }, now);
  if (!asked.ok) {
    return { kind: "refused", code: "question_open", message: "question " + asked.open.questionId + " is still open; its answer will reach you, ask again after it" };
  }
  const { question } = asked;
  let handed: QuestionInputPayload | null = null;
  let waiter!: (payload: QuestionInputPayload) => void;
  const answered = new Promise<QuestionInputPayload>((resolve) => { waiter = (payload) => { handed = payload; resolve(payload); }; });
  host.answerWaiters.set(question.questionId, waiter);
  const dropWaiter = () => { if (host.answerWaiters.get(question.questionId) === waiter) host.answerWaiters.delete(question.questionId); };
  let onAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    // The waiter goes at once, not in finally: a delivery that resumes after the abort finds none and
    // sends the pointer instead of handing the answer to a call that returns aborted.
    onAbort = () => { dropWaiter(); resolve("aborted"); };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
  // An interrupted form ends the wait; any other form end leaves it to the answer's or notice's delivery.
  const interrupted = openQuestionForm(db, host, settings, question, row.childThreadId!, formId, request.signal, now)
    .then((end) => (end === "interrupted" ? "interrupted" as const : new Promise<never>(() => {})), () => "interrupted" as const);
  try {
    const first = await Promise.race([answered, aborted, interrupted]);
    if (first === "aborted") return { kind: "aborted", questionId: question.questionId };
    if (first === "interrupted") {
      // A delivery may have handed the answer over just before.
      if (handed !== null) return consume(db, handed);
      return { kind: "still_open", questionId: question.questionId };
    }
    return consume(db, first);
  } finally {
    dropWaiter();
    request.signal.removeEventListener("abort", onAbort);
  }
}

export type RpcAnswerOutcome = { ok: true; questionId: string; delivery: "delivered" | "queued" | "retrying" } | { ok: false; message: string };

// The answerQuestion RPC: answers exactly the named question of the named delegation (compare-and-set on
// that question), so a replayed answer to an earlier question is refused and never lands on the next one.
export async function answerQuestionByRpc(
  db: Db, host: QuestionHost, settings: QuestionSettings, request: { delegationId: string; questionId: string; answer: string }, now = Date.now(),
): Promise<RpcAnswerOutcome> {
  const question = getQuestion(db, request.questionId);
  if (question === null || question.delegationId !== request.delegationId) {
    return { ok: false, message: "delegation " + request.delegationId + " has no question " + request.questionId };
  }
  const outcome = await answerQuestion(db, host, settings, { questionId: question.questionId, answer: request.answer, source: "rpc" }, now);
  if (!outcome.ok) return { ok: false, message: "question " + question.questionId + " was not answered: " + outcome.reason };
  return { ok: true, questionId: question.questionId, delivery: outcome.delivery };
}

export type QuestionAnswerOutcome =
  | { ok: true; questionId: string; answer: string; alreadyDelivered: boolean }
  | { ok: false; code: "unknown_question" | "not_answered"; message: string };

// sandy_question_answer: the answer of the caller's own answered question, consumed once (answered ->
// delivered); later calls return it as already delivered.
export function takeQuestionAnswer(db: Db, childThreadId: string, questionId: string, now = Date.now()): QuestionAnswerOutcome {
  const row = getDelegationByChild(db, childThreadId);
  const question = getQuestion(db, questionId);
  if (row === null || question === null || question.delegationId !== row.delegationId) {
    return { ok: false, code: "unknown_question", message: "no question " + questionId + " of this thread" };
  }
  if (question.state === "answered" || question.state === "delivered") {
    const delivered = markQuestionDelivered(db, questionId, now);
    return { ok: true, questionId, answer: getQuestion(db, questionId)!.answer ?? "", alreadyDelivered: !delivered };
  }
  const why = question.state === "open" ? "is still open, its answer will follow as a message"
    : question.state === "expired" ? "expired without an answer" : "was dismissed without an answer";
  return { ok: false, code: "not_answered", message: "question " + questionId + " " + why };
}

export type QuestionSweep = { reasked: string[]; expired: string[]; cancelled: string[]; pointers: string[]; failures: { subject: string; error: string }[] };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The question part of a watchdog pass: cancels the questions of ended delegations, expires open questions
// past their expiry (the child is told), and re-asks open questions no form of this process asks (plugin
// reload, interrupted form). On startup (the first pass of a process) every answered question without a
// pending answer input gets its pointer message again: the call that waited for it is gone.
export async function sweepQuestions(
  db: Db, host: QuestionHost, settings: QuestionSettings, options: { startup: boolean }, now = Date.now(),
): Promise<QuestionSweep> {
  const sweep: QuestionSweep = { reasked: [], expired: [], cancelled: [], pointers: [], failures: [] };
  for (const question of listQuestionsOfEndedDelegations(db)) {
    if (!cancelQuestion(db, question.questionId, { from: "any" }, now)) continue;
    host.questionForms.get(question.questionId)?.abort.abort();
    host.questionForms.delete(question.questionId);
    sweep.cancelled.push(question.questionId);
  }
  for (const question of listExpiredOpenQuestions(db, now)) {
    try {
      if (await endQuestion(db, host, settings, question, "expired", expiredNotice(question), () => expireQuestion(db, question.questionId, null, now), now)) {
        sweep.expired.push(question.questionId);
      }
    } catch (error) {
      sweep.failures.push({ subject: question.questionId, error: errorText(error) });
    }
  }
  if (options.startup) {
    for (const question of listAnsweredWithoutLiveInput(db)) {
      try {
        if (await requeueAnswerPointer(db, host, settings, question, now)) sweep.pointers.push(question.questionId);
      } catch (error) {
        sweep.failures.push({ subject: question.questionId, error: errorText(error) });
      }
    }
  }
  for (const question of listOpenQuestions(db)) {
    if (host.questionForms.has(question.questionId)) continue;
    const row = getDelegation(db, question.delegationId);
    if (row === null || row.childThreadId === null || END_STATES.includes(row.state)) continue;
    const formId = newFormId();
    if (!setQuestionForm(db, question.questionId, formId, now)) continue;
    const reasked = { ...question, formId };
    sweep.reasked.push(question.questionId);
    void openQuestionForm(db, host, settings, reasked, row.childThreadId, formId, undefined, now).catch((error: unknown) => {
      host.warn("question " + question.questionId + ": re-asking failed: " + errorText(error));
    });
  }
  return sweep;
}
