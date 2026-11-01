// Child questions (sandy_ask_parent), ledger half: the questions rows and their compare-and-set moves.
//
// A row moves open -> answered -> delivered, or open -> cancelled|expired (answered -> cancelled when its
// delegation ended), each move a compare-and-set; at most one question per delegation is open (unique
// index). form_id names the form currently asking an open question: a form's result counts only while the
// row is open and still names that form, so a stale form's late result is discarded, and of two answers
// only the first is taken. answered -> delivered is the consumption (sandy_ask_parent's tool result or
// sandy_question_answer), once.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { END_STATES, sqlList } from "./ledger.ts";

type Db = Database.Database;

export type QuestionState = "open" | "answered" | "delivered" | "cancelled" | "expired";
export type AnswerSource = "form" | "parent_send" | "rpc";

export type Question = {
  questionId: string;
  delegationId: string;
  state: QuestionState;
  question: string;
  options: string[];
  answer: string | null;
  answerSource: AnswerSource | null;
  formId: string | null;
  createdAt: number;
  expiresAt: number;
  answeredAt: number | null;
  deliveredAt: number | null;
  updatedAt: number;
};

const DAY_MS = 24 * 60 * 60_000;
// SANDY caps a form's timeoutMs at seven days (PluginInteractionRequest.timeoutMs).
export const MAX_QUESTION_TIMEOUT_MS = 7 * DAY_MS;

// The questionTimeoutDays setting in milliseconds, within (0, 7 days].
export function questionTimeoutMs(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return MAX_QUESTION_TIMEOUT_MS;
  return Math.min(Math.round(days * DAY_MS), MAX_QUESTION_TIMEOUT_MS);
}

const QUESTION_SELECT = `
  SELECT question_id AS questionId, delegation_id AS delegationId, state, question_json AS questionJson, answer_json AS answerJson,
    answer_source AS answerSource, form_id AS formId, created_at AS createdAt, expires_at AS expiresAt, answered_at AS answeredAt,
    delivered_at AS deliveredAt, updated_at AS updatedAt
  FROM questions`;

const questionRow = (value: unknown): Question => {
  const { questionJson, answerJson, ...row } = value as Omit<Question, "question" | "options" | "answer"> & { questionJson: string; answerJson: string | null };
  const asked = JSON.parse(questionJson) as { question: string; options?: string[] };
  const answer = answerJson === null ? null : (JSON.parse(answerJson) as { answer: string }).answer;
  return { ...row, question: asked.question, options: asked.options ?? [], answer };
};

export function getQuestion(db: Db, questionId: string): Question | null {
  const row = db.prepare(`${QUESTION_SELECT} WHERE question_id = ?`).get(questionId);
  return row === undefined ? null : questionRow(row);
}

export function getOpenQuestion(db: Db, delegationId: string): Question | null {
  const row = db.prepare(`${QUESTION_SELECT} WHERE delegation_id = ? AND state = 'open'`).get(delegationId);
  return row === undefined ? null : questionRow(row);
}

// The delegation's newest question, or null.
export function getLatestQuestion(db: Db, delegationId: string): Question | null {
  const row = db.prepare(`${QUESTION_SELECT} WHERE delegation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(delegationId);
  return row === undefined ? null : questionRow(row);
}

export function listOpenQuestions(db: Db): Question[] {
  return db.prepare(`${QUESTION_SELECT} WHERE state = 'open' ORDER BY created_at, rowid`).all().map(questionRow);
}

// Open or answered questions whose delegation ended (error, refused, stopped).
export function listQuestionsOfEndedDelegations(db: Db): Question[] {
  return db.prepare(
    `${QUESTION_SELECT} WHERE state IN ('open', 'answered')
       AND delegation_id IN (SELECT delegation_id FROM delegations WHERE state IN (${sqlList(END_STATES)})) ORDER BY created_at, rowid`,
  ).all().map(questionRow);
}

// Open questions whose expiry has come.
export function listExpiredOpenQuestions(db: Db, now: number): Question[] {
  return db.prepare(`${QUESTION_SELECT} WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at, rowid`).all(now).map(questionRow);
}

// Answered questions with no answer input queued, admitted or in delivery: the plugin process that answered
// them is gone (its direct delivery has no pending input), or their pointer message went out already.
export function listAnsweredWithoutLiveInput(db: Db): Question[] {
  return db.prepare(
    `${QUESTION_SELECT} WHERE state = 'answered' AND NOT EXISTS (
       SELECT 1 FROM pending_inputs p WHERE p.kind = 'answer' AND p.state IN ('queued', 'admitted', 'delivering')
         AND json_extract(p.payload_json, '$.questionId') = questions.question_id) ORDER BY answered_at, rowid`,
  ).all().map(questionRow);
}

export type AskResult = { ok: true; question: Question } | { ok: false; open: Question };

// Opens a question asked by the form formId; refused while another question of the delegation is open.
export function askQuestion(
  db: Db, request: { delegationId: string; question: string; options: readonly string[]; formId: string; timeoutMs: number }, now = Date.now(),
): AskResult {
  return db
    .transaction((): AskResult => {
      const open = getOpenQuestion(db, request.delegationId);
      if (open !== null) return { ok: false, open };
      const questionId = `qst_${randomUUID()}`;
      db.prepare(
        `INSERT INTO questions (question_id, delegation_id, state, question_json, form_id, created_at, expires_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(questionId, request.delegationId, JSON.stringify({ question: request.question, options: request.options }), request.formId, now, now + request.timeoutMs, now);
      return { ok: true, question: getQuestion(db, questionId)! };
    })
    .immediate();
}

// A new form asks the open question (re-opened after an interrupt): its id replaces the old one, whose
// results are stale from now on. false when the question is no longer open.
export function setQuestionForm(db: Db, questionId: string, formId: string, now = Date.now()): boolean {
  return db.prepare("UPDATE questions SET form_id = ?, updated_at = ? WHERE question_id = ? AND state = 'open'").run(formId, now, questionId).changes === 1;
}

export type AnswerRefusal = "unknown_question" | "not_open" | "stale_form";

// open -> answered (compare-and-set). A form's answer (formId given) counts only while that form is the current one.
export function recordAnswer(
  db: Db, request: { questionId: string; answer: string; source: AnswerSource; formId?: string }, now = Date.now(),
): { ok: true; question: Question } | { ok: false; reason: AnswerRefusal } {
  const formId = request.formId ?? null;
  const changed = db.prepare(
    `UPDATE questions SET state = 'answered', answer_json = ?, answer_source = ?, answered_at = ?, updated_at = ?
       WHERE question_id = ? AND state = 'open' AND (? IS NULL OR form_id = ?)`,
  ).run(JSON.stringify({ answer: request.answer }), request.source, now, now, request.questionId, formId, formId).changes;
  const after = getQuestion(db, request.questionId);
  if (after === null) return { ok: false, reason: "unknown_question" };
  if (changed === 1) return { ok: true, question: after };
  return { ok: false, reason: after.state === "open" ? "stale_form" : "not_open" };
}

// answered -> delivered (compare-and-set): the answer is consumed. false when it was not answered.
export function markQuestionDelivered(db: Db, questionId: string, now = Date.now()): boolean {
  return db.prepare("UPDATE questions SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE question_id = ? AND state = 'answered'")
    .run(now, now, questionId).changes === 1;
}

// open -> expired (compare-and-set); a form's timeout (formId given) counts only while that form is the current one.
export function expireQuestion(db: Db, questionId: string, formId: string | null, now = Date.now()): boolean {
  return db.prepare("UPDATE questions SET state = 'expired', updated_at = ? WHERE question_id = ? AND state = 'open' AND (? IS NULL OR form_id = ?)")
    .run(now, questionId, formId, formId).changes === 1;
}

// open -> cancelled: the owner dismissed the current form (formId given). from "any": also an answered
// question (its delegation ended, the answer can no longer be delivered).
export function cancelQuestion(db: Db, questionId: string, options: { formId?: string; from?: "open" | "any" } = {}, now = Date.now()): boolean {
  const states = options.from === "any" ? "'open', 'answered'" : "'open'";
  const formId = options.formId ?? null;
  return db.prepare(`UPDATE questions SET state = 'cancelled', updated_at = ? WHERE question_id = ? AND state IN (${states}) AND (? IS NULL OR form_id = ?)`)
    .run(now, questionId, formId, formId).changes === 1;
}
