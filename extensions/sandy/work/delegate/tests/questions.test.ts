import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, getDelegation, stopDelegation, transition, type DelegationState } from "../server/ledger.ts";
import { answerPointer, answerQuestion, drainQueues, sendToDelegation, type QuestionInputPayload } from "../server/control.ts";
import {
  answerQuestionByRpc, askParent, cancelledNotice, expiredNotice, handleFormResult, sweepQuestions, takeQuestionAnswer,
  type FormRequest, type FormResult, type QuestionHost,
} from "../server/ask.ts";
import {
  askQuestion, getQuestion, markQuestionDelivered, MAX_QUESTION_TIMEOUT_MS, questionTimeoutMs, recordAnswer, type Question,
} from "../server/questions.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { issuePolicy, recordAck, storeBrief, type PolicyAnswer } from "../server/protocol.ts";
import type { TurnEvent, WatchdogHost } from "../server/watchdog.ts";

type Db = ReturnType<typeof openDb>;

const WINDOW = 120_000;
// Real time: a form's result is applied at Date.now(), so the fake times of a test start here.
const T0 = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SETTINGS = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 4 };
const ONE_SLOT = { ...DEFAULT_SETTINGS, maxConcurrentChildren: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Lets every other pending task run as far as it can.
const settle = async () => { for (let round = 0; round < 20; round += 1) await new Promise((done) => setImmediate(done)); };

// A form SANDY shows: answer() submits it, cancel() ends it; closing it (abort) ends it as request-aborted.
type Form = { request: FormRequest; signal: AbortSignal; answer(value: unknown): void; cancel(reason: Extract<FormResult, { outcome: "cancelled" }>["reason"]): void };

// A SANDY stand-in: thread statuses, turn events, every message sent, and the question forms it was asked to show.
function fakeHost() {
  const statuses = new Map<string, string>();
  const turns = new Map<string, TurnEvent[]>();
  const sent: { threadId: string; message: string }[] = [];
  const forms: Form[] = [];
  // gate set: the next delivery pauses (at its turn-event read, inside the delegation lock) until it resolves;
  // onResume runs as it resumes, right before the delivery looks for a waiting call.
  const pause: { gate: Promise<void> | null; onResume: (() => void) | null } = { gate: null, onResume: null };
  const host: WatchdogHost & QuestionHost = {
    pluginId: "delegate",
    deliveriesInFlight: new Set(),
    answerWaiters: new Map(),
    questionForms: new Map(),
    warn() {},
    async send(threadId, message) {
      sent.push({ threadId, message });
      statuses.set(threadId, "running");
      return { delivery: "sent" };
    },
    async stop(threadId) { statuses.set(threadId, "idle"); },
    async threadState(threadId) { return { status: statuses.get(threadId) ?? "running", archived: false }; },
    async latestTurnEvents(threadId, count) {
      const gate = pause.gate;
      pause.gate = null;
      if (gate !== null) await gate;
      const onResume = pause.onResume;
      pause.onResume = null;
      onResume?.();
      return [...(turns.get(threadId) ?? [])].slice(-count); },
    async turnEventsAfter(threadId, afterSeq, limit) {
      return [...(turns.get(threadId) ?? [])].filter((event) => afterSeq === null || event.seq > afterSeq).slice(0, limit);
    },
    async spawnCandidates() { return []; },
    spawnInFlight: () => false,
    waitInFlight: () => false,
    async setParentNotifications() {},
    async firstTurnStartedAt() { return null; },
    requestInput(request, signal) {
      const result = deferred<FormResult>();
      signal.addEventListener("abort", () => result.resolve({ outcome: "cancelled", reason: "request-aborted" }), { once: true });
      forms.push({ request, signal, answer: (value) => result.resolve({ outcome: "submitted", value }), cancel: (reason) => result.resolve({ outcome: "cancelled", reason }) });
      return result.promise;
    },
  };
  return { host, statuses, turns, sent, forms, pause };
}

let counter = 0;

// A started child of parent bound to thr_q<n>, in state.
function child(db: Db, fake: ReturnType<typeof fakeHost>, parent: string, state: DelegationState = "active") {
  counter += 1;
  const threadId = "thr_q" + counter;
  const result = admit(db, { rootThreadId: parent, callerThreadId: parent, kind: "delegate", agent: "scout", inputHash: "h" + counter }, { ...DEFAULT_SETTINGS, maxConcurrentChildren: 50 }, T0);
  assert.ok(result.ok);
  const delegationId = result.delegation.delegationId;
  storeBrief(db, delegationId, "task", "[delegate-test]", T0);
  assert.ok(bindChild(db, delegationId, threadId, T0 + 1_000).ok);
  const answer = issuePolicy(db, threadId, {}, T0 + 2_000) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.ok(recordAck(db, { threadId, delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn: 1 }, WINDOW, T0 + 3_000).ok);
  fake.turns.set(threadId, [{ seq: 1, type: "started", at: T0 + 2_500 }, { seq: 2, type: "completed", at: T0 + 10_000 }]);
  fake.statuses.set(threadId, state === "active" ? "running" : "idle");
  if (state !== "active") assert.ok(transition(db, delegationId, state, T0 + 11_000).ok);
  return { delegationId, threadId };
}

const ask = (db: Db, fake: ReturnType<typeof fakeHost>, threadId: string, settings = SETTINGS, now = T0 + 20_000, signal = new AbortController().signal) =>
  askParent(db, fake.host, settings, { childThreadId: threadId, question: "Which database?", options: ["postgres", "sqlite"], signal }, now);

const answerInputs = (db: Db, questionId: string) =>
  (db.prepare("SELECT state, payload_json FROM pending_inputs WHERE kind = 'answer' ORDER BY seq").all() as { state: string; payload_json: string }[])
    .map((row) => ({ state: row.state, payload: JSON.parse(row.payload_json) as QuestionInputPayload }))
    .filter((row) => row.payload.questionId === questionId);

// An open question asked without a waiting call (as after a plugin reload).
function openQuestion(db: Db, delegationId: string, now = T0 + 20_000): Question {
  const asked = askQuestion(db, { delegationId, question: "Which database?", options: [], formId: "frm_gone", timeoutMs: questionTimeoutMs(7) }, now);
  assert.ok(asked.ok);
  return asked.question;
}

test("sandy_ask_parent: the form asks with the 7-day timeout; its answer is the call's result with the question id, the row is delivered, SANDY gets no message", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  assert.equal(fake.forms.length, 1);
  const [form] = fake.forms;
  assert.equal(form!.request.threadId, c.threadId);
  assert.equal(form!.request.timeoutMs, MAX_QUESTION_TIMEOUT_MS);
  assert.deepEqual(form!.request.payload.options, ["postgres", "sqlite"]);
  const questionId = form!.request.payload.questionId;
  form!.answer({ answer: "sqlite" });
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "sqlite", alreadyDelivered: false });
  const row = getQuestion(db, questionId)!;
  assert.equal(row.state, "delivered");
  assert.equal(row.answerSource, "form");
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(answerInputs(db, questionId).map((input) => input.state), ["delivered"]);
  assert.equal(fake.host.answerWaiters.size, 0);
  assert.equal(fake.host.questionForms.size, 0);
});

test("sandy_ask_parent: one open question per child; a second ask is refused while the first is open; a non-delegate is refused", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  void ask(db, fake, c.threadId);
  await settle();
  const second = await ask(db, fake, c.threadId);
  assert.equal(second.kind, "refused");
  assert.equal(second.kind === "refused" && second.code, "question_open");
  assert.equal(fake.forms.length, 1);
  const stranger = await ask(db, fake, "thr_plain");
  assert.equal(stranger.kind === "refused" && stranger.code, "not_a_delegate");
});

test("questions, fake clock: an answer 25 minutes after the ask arrives once; the form is still the live one, nothing expired or re-asked", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent", "idle");
  const pending = ask(db, fake, c.threadId, SETTINGS, T0);
  await settle();
  const [form] = fake.forms;
  const questionId = form!.request.payload.questionId;
  const swept = await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 25 * MINUTE);
  assert.deepEqual([swept.expired, swept.reasked, swept.cancelled, swept.pointers], [[], [], [], []]);
  assert.equal(form!.signal.aborted, false);
  const answered = await answerQuestion(db, fake.host, SETTINGS, { questionId, answer: "sqlite", source: "form", formId: getQuestion(db, questionId)!.formId! }, T0 + 25 * MINUTE);
  assert.ok(answered.ok);
  assert.equal(answered.delivery, "delivered");
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "sqlite", alreadyDelivered: false });
  assert.equal(getQuestion(db, questionId)!.answeredAt, T0 + 25 * MINUTE);
  assert.deepEqual(answerInputs(db, questionId).map((input) => input.state), ["delivered"]);
  assert.deepEqual(fake.sent, [], "the idle child got the answer as the call's result, not as a message");
  const again = takeQuestionAnswer(db, c.threadId, questionId);
  assert.deepEqual(again, { ok: true, questionId, answer: "sqlite", alreadyDelivered: true });
});

test("parent send to a child with an open question answers it: the waiting call returns it, the form is closed, its late result is stale", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  const [form] = fake.forms;
  const questionId = form!.request.payload.questionId;
  const sent = await sendToDelegation(db, fake.host, SETTINGS, { callerThreadId: "thr_parent", delegationId: c.delegationId, message: "use sqlite", mode: "queue" });
  assert.deepEqual(sent, { ok: true, status: "answered", delegationId: c.delegationId, threadId: c.threadId, questionId, delivery: "delivered" });
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "use sqlite", alreadyDelivered: false });
  assert.equal(form!.signal.aborted, true);
  assert.equal(getQuestion(db, questionId)!.answerSource, "parent_send");
  assert.deepEqual(fake.sent, []);
  const late = await handleFormResult(db, fake.host, SETTINGS, getQuestion(db, questionId)!, getQuestion(db, questionId)!.formId!, { outcome: "submitted", value: { answer: "postgres" } });
  assert.equal(late, "stale");
  assert.equal(getQuestion(db, questionId)!.answer, "use sqlite");
  const next = await sendToDelegation(db, fake.host, SETTINGS, { callerThreadId: "thr_parent", delegationId: c.delegationId, message: "and then stop", mode: "queue" });
  assert.equal(next.ok && next.status, "delivered", "without an open question a send is a plain send");
});

test("two answers at once, deterministic interleaving: the first wins, the second is refused and changes nothing", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  const [form] = fake.forms;
  const questionId = form!.request.payload.questionId;
  const formId = getQuestion(db, questionId)!.formId!;
  // The panel's answer and the form's answer start in the same tick; the panel's is first in line.
  const viaPanel = answerQuestion(db, fake.host, SETTINGS, { questionId, answer: "postgres", source: "rpc" });
  const viaForm = answerQuestion(db, fake.host, SETTINGS, { questionId, answer: "sqlite", source: "form", formId });
  const [first, second] = await Promise.all([viaPanel, viaForm]);
  assert.ok(first.ok);
  assert.deepEqual(second, { ok: false, reason: "not_open" });
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "postgres", alreadyDelivered: false });
  assert.equal(getQuestion(db, questionId)!.answerSource, "rpc");
  assert.equal(answerInputs(db, questionId).length, 1, "the refused answer stored no input");
  // The compare-and-set itself, without the delegation lock: a second answer of the same question is refused.
  const other = child(db, fake, "thr_parent");
  const q = openQuestion(db, other.delegationId);
  assert.ok(recordAnswer(db, { questionId: q.questionId, answer: "a", source: "rpc" }).ok);
  assert.deepEqual(recordAnswer(db, { questionId: q.questionId, answer: "b", source: "parent_send" }), { ok: false, reason: "not_open" });
  assert.equal(getQuestion(db, q.questionId)!.answer, "a");
});

test("parent send losing the race to the form's answer goes out as a plain message; the question keeps the form's answer", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  const questionId = fake.forms[0]!.request.payload.questionId;
  // The form's answer is mid-delivery (holding the delegation's lock) when the parent's send comes in.
  const gate = deferred<void>();
  fake.pause.gate = gate.promise;
  fake.forms[0]!.answer({ answer: "sqlite" });
  await settle();
  assert.equal(getQuestion(db, questionId)!.state, "answered");
  const racing = sendToDelegation(db, fake.host, SETTINGS, { callerThreadId: "thr_parent", delegationId: c.delegationId, message: "use postgres", mode: "queue" });
  await settle();
  gate.resolve();
  const sent = await racing;
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "sqlite", alreadyDelivered: false });
  assert.equal(sent.ok && sent.status, "delivered");
  assert.deepEqual(fake.sent, [{ threadId: c.threadId, message: "use postgres" }]);
});

test("a stale form's late result is discarded: after a re-ask only the new form's answer counts", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  const old = fake.forms[0]!;
  const questionId = old.request.payload.questionId;
  const oldFormId = getQuestion(db, questionId)!.formId!;
  old.cancel("server-restarted");
  assert.deepEqual(await pending, { kind: "still_open", questionId }, "an interrupted form leaves the question open, the call says so");
  assert.equal(getQuestion(db, questionId)!.state, "open");
  const swept = await sweepQuestions(db, fake.host, SETTINGS, { startup: true }, T0 + 30_000);
  assert.deepEqual(swept.reasked, [questionId]);
  assert.equal(fake.forms.length, 2);
  assert.notEqual(getQuestion(db, questionId)!.formId, oldFormId);
  const late = await handleFormResult(db, fake.host, SETTINGS, getQuestion(db, questionId)!, oldFormId, { outcome: "submitted", value: { answer: "postgres" } });
  assert.equal(late, "stale");
  assert.equal(getQuestion(db, questionId)!.state, "open");
  assert.equal((await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 40_000)).reasked.length, 0, "the live re-asked form is not asked again");
  fake.forms[1]!.answer("sqlite");
  await settle();
  // No call waits any more: the child gets the pointer, never the answer itself, and takes the answer once.
  assert.deepEqual(fake.sent, [{ threadId: c.threadId, message: answerPointer(questionId) }]);
  assert.equal(getQuestion(db, questionId)!.state, "answered");
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, questionId), { ok: true, questionId, answer: "sqlite", alreadyDelivered: false });
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, questionId), { ok: true, questionId, answer: "sqlite", alreadyDelivered: true });
});

test("exactly once after a reload right after answered: the startup sweep sends the pointer; a duplicated pointer gets already delivered", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent", "idle");
  const q = openQuestion(db, c.delegationId);
  // The answering process died after the answer's compare-and-set, before any input was stored.
  assert.ok(recordAnswer(db, { questionId: q.questionId, answer: "sqlite", source: "rpc" }, T0 + 30_000).ok);
  const first = await sweepQuestions(db, fake.host, SETTINGS, { startup: true }, T0 + 40_000);
  assert.deepEqual(first.pointers, [q.questionId]);
  assert.deepEqual(first.reasked, []);
  // A reload right after the pointer: the next process's startup sends it again.
  const second = await sweepQuestions(db, fake.host, SETTINGS, { startup: true }, T0 + 50_000);
  assert.deepEqual(second.pointers, [q.questionId]);
  assert.deepEqual(fake.sent, [{ threadId: c.threadId, message: answerPointer(q.questionId) }, { threadId: c.threadId, message: answerPointer(q.questionId) }]);
  assert.equal((await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 60_000)).pointers.length, 0, "a sweep that is not a startup sends no pointer");
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, q.questionId), { ok: true, questionId: q.questionId, answer: "sqlite", alreadyDelivered: false });
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, q.questionId), { ok: true, questionId: q.questionId, answer: "sqlite", alreadyDelivered: true });
  assert.equal(getQuestion(db, q.questionId)!.state, "delivered");
  assert.equal((await sweepQuestions(db, fake.host, SETTINGS, { startup: true }, T0 + 70_000)).pointers.length, 0, "a delivered answer gets no pointer");
});

test("abort during the answer's handoff, deterministic interleaving: the abort wins, the answer reaches the child once via pointer and sandy_question_answer", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const call = new AbortController();
  const pending = ask(db, fake, c.threadId, SETTINGS, T0 + 20_000, call.signal);
  await settle();
  const questionId = fake.forms[0]!.request.payload.questionId;
  // The form's answer is admitted and its delivery is under way; the call aborts just before the delivery
  // looks for the waiting call (SANDY stopped the child's turn).
  const gate = deferred<void>();
  fake.pause.gate = gate.promise;
  fake.pause.onResume = () => call.abort();
  fake.forms[0]!.answer({ answer: "sqlite" });
  await settle();
  assert.equal(getQuestion(db, questionId)!.state, "answered");
  gate.resolve();
  assert.deepEqual(await pending, { kind: "aborted", questionId });
  await settle();
  assert.deepEqual(fake.sent, [{ threadId: c.threadId, message: answerPointer(questionId) }], "the delivery found no waiter and sent the pointer");
  assert.equal(getQuestion(db, questionId)!.state, "answered");
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, questionId), { ok: true, questionId, answer: "sqlite", alreadyDelivered: false });
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, questionId), { ok: true, questionId, answer: "sqlite", alreadyDelivered: true });
});

test("answerQuestion RPC: a replay of question 1's answer after question 2 opened is refused, question 2 stays open", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent", "idle");
  const q1 = openQuestion(db, c.delegationId);
  const first = await answerQuestionByRpc(db, fake.host, SETTINGS, { delegationId: c.delegationId, questionId: q1.questionId, answer: "sqlite" }, T0 + 30_000);
  assert.ok(first.ok);
  assert.deepEqual(takeQuestionAnswer(db, c.threadId, q1.questionId), { ok: true, questionId: q1.questionId, answer: "sqlite", alreadyDelivered: false });
  const q2 = openQuestion(db, c.delegationId, T0 + 40_000);
  const replay = await answerQuestionByRpc(db, fake.host, SETTINGS, { delegationId: c.delegationId, questionId: q1.questionId, answer: "sqlite" }, T0 + 50_000);
  assert.deepEqual(replay, { ok: false, message: "question " + q1.questionId + " was not answered: not_open" });
  assert.equal(getQuestion(db, q2.questionId)!.state, "open");
  assert.equal(getQuestion(db, q2.questionId)!.answer, null);
  assert.equal(getQuestion(db, q1.questionId)!.state, "delivered");
  // A question of another delegation is not this delegation's to answer.
  const other = child(db, fake, "thr_parent", "idle");
  const foreign = await answerQuestionByRpc(db, fake.host, SETTINGS, { delegationId: other.delegationId, questionId: q2.questionId, answer: "postgres" }, T0 + 60_000);
  assert.deepEqual(foreign, { ok: false, message: "delegation " + other.delegationId + " has no question " + q2.questionId });
  assert.equal(getQuestion(db, q2.questionId)!.state, "open");
});

test("exactly once: the answer's compare-and-set lets one consumer take it; the waiting call and sandy_question_answer cannot both", () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const q = openQuestion(db, c.delegationId);
  assert.ok(recordAnswer(db, { questionId: q.questionId, answer: "sqlite", source: "rpc" }).ok);
  assert.equal(markQuestionDelivered(db, q.questionId), true);
  assert.equal(markQuestionDelivered(db, q.questionId), false);
  assert.equal(takeQuestionAnswer(db, c.threadId, q.questionId).ok && takeQuestionAnswer(db, c.threadId, q.questionId).ok, true);
  const taken = takeQuestionAnswer(db, c.threadId, q.questionId);
  assert.ok(taken.ok);
  assert.equal(taken.alreadyDelivered, true);
});

test("sandy_question_answer: only the asking child's own question; an open, expired or dismissed one is not answered", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const other = child(db, fake, "thr_parent");
  const q = openQuestion(db, c.delegationId);
  assert.equal(takeQuestionAnswer(db, other.threadId, q.questionId).ok, false);
  const foreign = takeQuestionAnswer(db, other.threadId, q.questionId);
  assert.equal(!foreign.ok && foreign.code, "unknown_question");
  const open = takeQuestionAnswer(db, c.threadId, q.questionId);
  assert.equal(!open.ok && open.code, "not_answered");
  assert.match(!open.ok ? open.message : "", /still open/);
  assert.equal(takeQuestionAnswer(db, c.threadId, "qst_missing").ok, false);
});

test("a full root keeps the answer queued (question answered) until a slot frees; then the waiting call gets it", async () => {
  const db = openDb();
  const fake = fakeHost();
  const busy = child(db, fake, "thr_parent");
  const c = child(db, fake, "thr_parent", "idle");
  const pending = ask(db, fake, c.threadId, ONE_SLOT);
  await settle();
  const questionId = fake.forms[0]!.request.payload.questionId;
  const answered = await answerQuestion(db, fake.host, ONE_SLOT, { questionId, answer: "sqlite", source: "rpc" });
  assert.ok(answered.ok);
  assert.equal(answered.delivery, "queued");
  assert.equal(getQuestion(db, questionId)!.state, "answered");
  assert.deepEqual(answerInputs(db, questionId).map((input) => input.state), ["queued"]);
  assert.equal(getDelegation(db, c.delegationId)!.state, "idle");
  let done = false;
  void pending.then(() => { done = true; });
  await settle();
  assert.equal(done, false, "the call still waits");
  assert.equal((await drainQueues(db, fake.host, ONE_SLOT, T0 + 30_000)).failures.length, 0);
  assert.equal(done, false, "the root is still full");
  assert.ok(transition(db, busy.delegationId, "idle", T0 + 40_000).ok);
  await drainQueues(db, fake.host, ONE_SLOT, T0 + 41_000);
  assert.deepEqual(await pending, { kind: "answer", questionId, answer: "sqlite", alreadyDelivered: false });
  assert.deepEqual(answerInputs(db, questionId).map((input) => input.state), ["delivered"]);
  assert.deepEqual(fake.sent, []);
});

test("a queued pointer whose answer the child took meanwhile is dropped by the drain, not sent", async () => {
  const db = openDb();
  const fake = fakeHost();
  const busy = child(db, fake, "thr_parent");
  const c = child(db, fake, "thr_parent", "idle");
  const q = openQuestion(db, c.delegationId);
  const answered = await answerQuestion(db, fake.host, ONE_SLOT, { questionId: q.questionId, answer: "sqlite", source: "rpc" });
  assert.equal(answered.ok && answered.delivery, "queued");
  assert.ok(takeQuestionAnswer(db, c.threadId, q.questionId).ok);
  assert.ok(transition(db, busy.delegationId, "idle", T0 + 40_000).ok);
  await drainQueues(db, fake.host, ONE_SLOT, T0 + 41_000);
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(answerInputs(db, q.questionId).map((input) => input.state), ["cancelled"]);
  assert.equal(getDelegation(db, c.delegationId)!.state, "idle", "the slot taken for it is given back");
});

test("questions, fake clock: after 7 days an open question expires; the waiting call is told and the form closed", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId, SETTINGS, T0);
  await settle();
  const form = fake.forms[0]!;
  const questionId = form.request.payload.questionId;
  assert.equal(getQuestion(db, questionId)!.expiresAt, T0 + 7 * DAY);
  assert.deepEqual((await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 7 * DAY - 1)).expired, []);
  assert.deepEqual((await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 7 * DAY)).expired, [questionId]);
  const question = getQuestion(db, questionId)!;
  assert.equal(question.state, "expired");
  assert.deepEqual(await pending, { kind: "ended", questionId, message: expiredNotice(question) });
  assert.equal(form.signal.aborted, true);
  assert.equal(recordAnswer(db, { questionId, answer: "late", source: "rpc" }).ok, false, "an expired question takes no answer");
});

test("questions, fake clock: without a waiting call the expired question's notice is a message; the form's own timeout expires it too", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent", "idle");
  const q = openQuestion(db, c.delegationId, T0);
  await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 8 * DAY);
  assert.deepEqual(fake.sent, [{ threadId: c.threadId, message: expiredNotice(q) }]);
  const d = child(db, fake, "thr_parent");
  const pending = ask(db, fake, d.threadId);
  await settle();
  const form = fake.forms.at(-1)!;
  const questionId = form.request.payload.questionId;
  form.cancel("timeout");
  const outcome = await pending;
  assert.equal(outcome.kind, "ended");
  assert.equal(getQuestion(db, questionId)!.state, "expired");
});

test("the child's dismissal cancels the question and tells the waiting call; a stopped child's question is cancelled silently", async () => {
  const db = openDb();
  const fake = fakeHost();
  const c = child(db, fake, "thr_parent");
  const pending = ask(db, fake, c.threadId);
  await settle();
  const questionId = fake.forms[0]!.request.payload.questionId;
  fake.forms[0]!.cancel("user");
  assert.deepEqual(await pending, { kind: "ended", questionId, message: cancelledNotice(getQuestion(db, questionId)!) });
  assert.equal(getQuestion(db, questionId)!.state, "cancelled");
  const d = child(db, fake, "thr_parent");
  void ask(db, fake, d.threadId);
  await settle();
  const form = fake.forms.at(-1)!;
  const stopped = form.request.payload.questionId;
  assert.ok(stopDelegation(db, d.delegationId, T0 + 30_000));
  const swept = await sweepQuestions(db, fake.host, SETTINGS, { startup: false }, T0 + 31_000);
  assert.deepEqual(swept.cancelled, [stopped]);
  assert.equal(getQuestion(db, stopped)!.state, "cancelled");
  assert.equal(form.signal.aborted, true);
  assert.equal(fake.sent.length, 0);
  const late = await answerQuestion(db, fake.host, SETTINGS, { questionId: stopped, answer: "x", source: "rpc" });
  assert.equal(late.ok, false);
});
