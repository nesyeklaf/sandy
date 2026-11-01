import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, bindChild, requestStop, transition } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { enrichDelegations, STALE_AFTER_MS, STATUS_ROW_LIMIT, statusFor, type FailureRecord, type StatusHost, type UsageSnapshot } from "../server/status.ts";
import { formatDelegationTable, listDelegations } from "../server/list.ts";
import { askQuestion, markQuestionDelivered, recordAnswer } from "../server/questions.ts";
import type { TurnEvent } from "../server/watchdog.ts";

type Db = ReturnType<typeof openDb>;

const NOW = 10_000_000;

type World = {
  thread: { status: string; archived: boolean } | null;
  events: TurnEvent[];
  options: { model: string; reasoningLevel: string } | null;
  usage: UsageSnapshot | null;
  lastEventAt: number | null;
  failure: FailureRecord | null;
  broken: boolean;
};

const worldOf = (patch: Partial<World> = {}): World => ({
  thread: { status: "idle", archived: false },
  events: [{ seq: 1, type: "started", at: NOW - 60_000 }, { seq: 2, type: "completed", at: NOW - 20_000, outcome: "completed" }],
  options: { model: "anthropic/claude-haiku-5-5", reasoningLevel: "medium" },
  usage: { totalTokens: 30_000, contextTokens: 12_000, contextWindow: 200_000 },
  lastEventAt: NOW - 20_000,
  failure: null,
  broken: false,
  ...patch,
});

// A SANDY stand-in per child thread id.
function hostOf(worlds: Record<string, World>): StatusHost {
  const world = (id: string): World => {
    const found = worlds[id];
    if (found === undefined) throw new Error("no world for " + id);
    if (found.broken) throw new Error("SANDY exploded for " + id);
    return found;
  };
  return {
    threadState: async (id) => world(id).thread,
    latestTurnEvents: async (id, count) => world(id).events.slice(-count),
    executionOptions: async (id) => world(id).options,
    usage: async (id) => world(id).usage,
    lastEventAt: async (id) => world(id).lastEventAt,
    latestFailure: async (id) => world(id).failure,
    now: () => NOW,
  };
}

function delegation(db: Db, parent: string, child: string | null, options: { agent?: string; boundAt?: number } = {}): string {
  const admitted = admit(db, { rootThreadId: parent, callerThreadId: parent, kind: "delegate", agent: options.agent ?? "scout", inputHash: "h" + (child ?? "x") }, DEFAULT_SETTINGS, NOW - 100_000);
  assert.ok(admitted.ok);
  const id = admitted.delegation.delegationId;
  if (child !== null) assert.ok(bindChild(db, id, child, options.boundAt ?? NOW - 90_000).ok);
  return id;
}

const one = async (db: Db, host: StatusHost, caller: string, delegationId?: string) => {
  const result = await statusFor(db, host, caller, delegationId);
  assert.ok(result.ok, JSON.stringify(result));
  return result.delegations;
};

test("status: a finished child reports completed with its model, thinking, tokens, run time and no error", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_done");
  const [row] = await one(db, hostOf({ thr_done: worldOf() }), "thr_parent", id);
  assert.equal(row.delegationId, id);
  assert.equal(row.threadId, "thr_done");
  assert.equal(row.agent, "scout");
  assert.equal(row.threadStatus, "idle");
  assert.equal(row.status, "completed");
  assert.equal(row.model, "anthropic/claude-haiku-5-5");
  assert.equal(row.reasoningLevel, "medium");
  assert.deepEqual(row.tokens, { total: 30_000, context: 12_000, contextWindow: 200_000 });
  assert.deepEqual(row.runtime, { sinceBoundMs: 90_000, lastTurnMs: 40_000, lastTurnRunning: false });
  assert.equal(row.lastActivityAt, NOW - 20_000);
  assert.equal(row.stale, false);
  assert.equal(row.error, null);
  assert.equal(row.question, null);
  assert.equal(row.stop, null);
});

test("status: a running child reports running, a growing turn time and goes stale only after the threshold without events", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_run");
  const running = worldOf({ thread: { status: "active", archived: false }, events: [{ seq: 1, type: "started", at: NOW - 30_000 }], lastEventAt: NOW - 1_000 });
  const [row] = await one(db, hostOf({ thr_run: running }), "thr_parent", id);
  assert.equal(row.status, "running");
  assert.equal(row.threadStatus, "active");
  assert.deepEqual(row.runtime, { sinceBoundMs: 90_000, lastTurnMs: 30_000, lastTurnRunning: true });
  assert.equal(row.stale, false);
  const silent = worldOf({ thread: { status: "active", archived: false }, events: [{ seq: 1, type: "started", at: NOW - 30_000 }], lastEventAt: NOW - STALE_AFTER_MS - 1 });
  const [stale] = await one(db, hostOf({ thr_run: silent }), "thr_parent", id);
  assert.equal(stale.stale, true);
  const result = await statusFor(db, hostOf({ thr_run: silent }), "thr_parent");
  assert.ok(result.ok);
  assert.equal(result.staleAfterMs, STALE_AFTER_MS);
});

test("status: a failed child reports failed with the turn's error; a thread in error without a failed turn gets SANDY's provider error", async () => {
  const db = openDb();
  const failedTurn = delegation(db, "thr_parent", "thr_failed");
  const providerError = delegation(db, "thr_parent", "thr_error");
  const host = hostOf({
    thr_failed: worldOf({ events: [{ seq: 1, type: "started", at: NOW - 60_000 }, { seq: 2, type: "completed", at: NOW - 50_000, outcome: "failed", error: "rate limited" }] }),
    thr_error: worldOf({
      thread: { status: "error", archived: false }, events: [{ seq: 1, type: "started", at: NOW - 60_000 }, { seq: 2, type: "completed", at: NOW - 59_000, outcome: "completed" }],
      failure: { at: NOW - 5_000, source: "provider/error", message: "pi exited (code 1): Cannot find module './policy.ts'" },
    }),
  });
  const [failed] = await one(db, host, "thr_parent", failedTurn);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "rate limited");
  assert.equal(failed.runtime.lastTurnMs, 10_000);
  const [errored] = await one(db, host, "thr_parent", providerError);
  assert.equal(errored.status, "error");
  assert.equal(errored.threadStatus, "error");
  assert.equal(errored.error, "pi exited (code 1): Cannot find module './policy.ts'");
});

test("status: tokens SANDY has no event for are null, never 0; a model SANDY does not report falls back to the ledger's", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_fresh");
  const host = hostOf({ thr_fresh: worldOf({ usage: { totalTokens: null, contextTokens: null, contextWindow: null }, options: null, events: [], lastEventAt: null }) });
  const [row] = await one(db, host, "thr_parent", id);
  assert.deepEqual(row.tokens, { total: null, context: null, contextWindow: null });
  assert.equal(row.model, "anthropic/claude-haiku-5-5");
  assert.equal(row.runtime.lastTurnMs, null);
  assert.equal(row.lastActivityAt, null);
  assert.equal(row.status, "idle");
  const [noUsage] = await one(db, hostOf({ thr_fresh: worldOf({ usage: null }) }), "thr_parent", id);
  assert.deepEqual(noUsage.tokens, { total: null, context: null, contextWindow: null });
  const [partial] = await one(db, hostOf({ thr_fresh: worldOf({ usage: { totalTokens: 500, contextTokens: null, contextWindow: 1_000_000 } }) }), "thr_parent", id);
  assert.deepEqual(partial.tokens, { total: 500, context: null, contextWindow: 1_000_000 });
});

test("status: a ledger end state, a missing thread and an unbound reservation each get their word; the stop request rides along", async () => {
  const db = openDb();
  const refused = delegation(db, "thr_parent", "thr_refused");
  assert.ok(transition(db, refused, "refused").ok);
  requestStop(db, "thr_refused", refused, "no_ack", NOW - 1_000);
  const gone = delegation(db, "thr_parent", "thr_gone");
  const reserved = delegation(db, "thr_parent", null);
  const host = hostOf({ thr_refused: worldOf(), thr_gone: worldOf({ thread: null }) });
  const rows = await one(db, host, "thr_parent");
  const byId = Object.fromEntries(rows.map((row) => [row.delegationId, row]));
  assert.equal(byId[refused].status, "refused");
  assert.deepEqual(byId[refused].stop, { threadId: "thr_refused", reason: "no_ack", stoppedAt: null, attempts: 0, lastError: null });
  assert.equal(byId[gone].status, "gone");
  assert.equal(byId[gone].threadStatus, null);
  assert.equal(byId[reserved].status, "reserved");
  assert.equal(byId[reserved].threadId, null);
  assert.deepEqual(byId[reserved].tokens, { total: null, context: null, contextWindow: null });
});

test("status: a SANDY failure on one child leaves its SANDY fields null and names the error; the others are unaffected", async () => {
  const db = openDb();
  const bad = delegation(db, "thr_parent", "thr_bad");
  const good = delegation(db, "thr_parent", "thr_good");
  const rows = await one(db, hostOf({ thr_bad: worldOf({ broken: true }), thr_good: worldOf() }), "thr_parent");
  const byId = Object.fromEntries(rows.map((row) => [row.delegationId, row]));
  assert.match(byId[bad].sandyError ?? "", /SANDY exploded for thr_bad/);
  assert.equal(byId[bad].threadStatus, null);
  assert.deepEqual(byId[bad].tokens, { total: null, context: null, contextWindow: null });
  assert.equal(byId[good].sandyError, undefined);
  assert.equal(byId[good].status, "completed");
});

test("status: all lists only the caller's own delegations, newest first, capped at the row limit", async () => {
  const db = openDb();
  const mine = delegation(db, "thr_parent", "thr_mine");
  delegation(db, "thr_other", "thr_theirs");
  const host = hostOf({ thr_mine: worldOf(), thr_theirs: worldOf() });
  assert.deepEqual((await one(db, host, "thr_parent")).map((row) => row.delegationId), [mine]);
  const many = openDb();
  const worlds: Record<string, World> = {};
  for (let index = 0; index < STATUS_ROW_LIMIT + 3; index++) {
    worlds["thr_c" + index] = worldOf();
    const admitted = admit(many, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "h" + index }, { maxConcurrentChildren: 1000 }, NOW + index);
    assert.ok(admitted.ok);
  }
  const capped = await statusFor(many, hostOf(worlds), "thr_parent");
  assert.ok(capped.ok);
  assert.equal(capped.delegations.length, STATUS_ROW_LIMIT);
  assert.equal(capped.truncated, true);
});

test("status: another parent's delegation and an unknown id are refused the same way; a delegate child may not ask", async () => {
  const db = openDb();
  const foreign = delegation(db, "thr_other", "thr_theirs");
  const own = delegation(db, "thr_parent", "thr_mine");
  const host = hostOf({ thr_theirs: worldOf(), thr_mine: worldOf() });
  const a = await statusFor(db, host, "thr_parent", foreign);
  const b = await statusFor(db, host, "thr_parent", "dlg_nope");
  assert.ok(!a.ok && !b.ok);
  assert.equal(a.refusal.code, "not_your_delegation");
  assert.equal(b.refusal.code, "not_your_delegation");
  assert.equal(a.refusal.message.replace(foreign, "ID"), b.refusal.message.replace("dlg_nope", "ID"));
  const asChild = await statusFor(db, host, "thr_mine", own);
  assert.ok(!asChild.ok);
  assert.equal(asChild.refusal.code, "child_caller");
  const asChildAll = await statusFor(db, host, "thr_mine");
  assert.ok(!asChildAll.ok && asChildAll.refusal.code === "child_caller");
});

test("list enrichment: entries gain the live fields, a failing read keeps the ledger fields with null SANDY fields, and the table shows — for unknown tokens", async () => {
  const db = openDb();
  const ok = delegation(db, "thr_parent", "thr_ok");
  const bad = delegation(db, "thr_parent", "thr_bad");
  const fresh = delegation(db, "thr_parent", "thr_fresh");
  const host = hostOf({
    thr_ok: worldOf(), thr_bad: worldOf({ broken: true }), thr_fresh: worldOf({ usage: { totalTokens: null, contextTokens: null, contextWindow: null } }),
  });
  const entries = await enrichDelegations(db, host, listDelegations(db, { limit: 10 }));
  const byId = Object.fromEntries(entries.map((entry) => [entry.delegationId, entry]));
  assert.equal(byId[ok].status, "completed");
  assert.deepEqual(byId[ok].tokens, { total: 30_000, context: 12_000, contextWindow: 200_000 });
  assert.equal(byId[ok].agent, "scout");
  assert.equal(byId[bad].state, "starting");
  assert.deepEqual(byId[bad].tokens, { total: null, context: null, contextWindow: null });
  assert.match(byId[bad].sandyError ?? "", /exploded/);
  assert.equal(byId[fresh].tokens.total, null);
  const table = formatDelegationTable(entries);
  assert.match(table, /TOKENS/);
  assert.match(table, /30000/);
  assert.match(table, /—/);
  assert.doesNotMatch(table, /\b0\b.*thr_fresh/);
  assert.doesNotMatch(formatDelegationTable(listDelegations(db, { limit: 10 })), /TOKENS/);
});

test("status: the child's open question shows until its answer is taken (answered still shows it, delivered does not)", async () => {
  const db = openDb();
  const id = delegation(db, "thr_parent", "thr_asks");
  const host = hostOf({ thr_asks: worldOf() });
  const asked = askQuestion(db, { delegationId: id, question: "Which database?", options: ["postgres", "sqlite"], formId: "frm_1", timeoutMs: 1_000_000 }, NOW - 5_000);
  assert.ok(asked.ok);
  const questionId = asked.question.questionId;
  const [open] = await one(db, host, "thr_parent", id);
  assert.deepEqual(open.question, { questionId, state: "open", question: "Which database?", options: ["postgres", "sqlite"], askedAt: NOW - 5_000, expiresAt: NOW - 5_000 + 1_000_000 });
  assert.ok(recordAnswer(db, { questionId, answer: "sqlite", source: "rpc" }, NOW - 1_000).ok);
  assert.equal((await one(db, host, "thr_parent", id))[0].question?.state, "answered");
  assert.ok(markQuestionDelivered(db, questionId, NOW));
  assert.equal((await one(db, host, "thr_parent", id))[0].question, null);
});
