// The child side of a delegation, server half: which SANDY tools a thread gets (agents.configure), the
// policy a child's pi extension loads (`sandy work delegate policy`), the ack it sends back (`sandy work delegate ack`)
// and the brief sandy_delegate_brief returns after a valid ack. The ledger decides; thread metadata only
// names a delegation that is not bound yet, so it can restrict a thread (marker, pending) but never
// give it a policy.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { policyHash, type Policy } from "../shared/policy.ts";
import { buildPolicy, getSnapshot } from "./catalog.ts";
import { ackOverdue, END_STATES, getDelegation, getDelegationByChild, moveIdleToActive, recordMarkerGrant, refuseUnacked, rootHasSlotFor, transition, type DelegationRow } from "./ledger.ts";
import { DEFAULT_SETTINGS, type DelegateSettings } from "./settings.ts";

type Db = Database.Database;

export const BRIEF_TOOL = "sandy_delegate_brief";
export const DELEGATE_TOOL = "sandy_delegate";
export const WAIT_TOOL = "sandy_delegate_wait";
export const SEND_TOOL = "sandy_delegate_send";
export const STOP_TOOL = "sandy_delegate_stop";
export const STATUS_TOOL = "sandy_delegate_status";
export const ASK_TOOL = "sandy_ask_parent";
export const QUESTION_ANSWER_TOOL = "sandy_question_answer";

// The plugin metadata key the spawn seeds with the delegation id.
export const METADATA_DELEGATION_ID = "delegationId";

export const metadataDelegationId = (metadata: Readonly<Record<string, unknown>>): string | null => {
  const value = metadata[METADATA_DELEGATION_ID];
  return typeof value === "string" && value !== "" ? value : null;
};

// A reserved row whose spawn has not been bound yet: the only case in which metadata names the delegation.
const isPendingBind = (row: DelegationRow | null): row is DelegationRow => row !== null && row.state === "reserved" && row.childThreadId === null;

// The delegation a thread runs as: its bound row (any state but an end state), or the unbound reserved row
// its metadata names (the spawn returned but bindChild has not run yet).
export function delegationOfThread(db: Db, threadId: string, metadata: Readonly<Record<string, unknown>>): { row: DelegationRow; bound: boolean } | null {
  const bound = getDelegationByChild(db, threadId);
  if (bound !== null) return END_STATES.includes(bound.state) ? null : { row: bound, bound: true };
  const named = metadataDelegationId(metadata);
  if (named === null) return null;
  const row = getDelegation(db, named);
  return isPendingBind(row) ? { row, bound: false } : null;
}

// Tools for one agents.configure resolution: a delegate gets the delegate-side protocol tools (brief, ask
// parent, question answer; depth 1, no sandy_delegate); every other thread gets the parent-side tools (delegate,
// wait, send, stop, status). The delegate-side set is catalog.ts PROTOCOL_TOOLS. The brief tool is the marker: it turns the extension's gate
// on, so it is given whenever a thread looks like a delegate at all: any ledger binding (also ended ones) or any
// delegation id in its metadata. Metadata only restricts: what the gated thread may then run still comes
// from the ledger alone (issuePolicy answers denied, deny-all, for anything but a live delegation).
// Each grant of the marker is recorded: the watchdog refuses a child whose first turn started before it.
export function delegateToolsFor(db: Db, threadId: string, metadata: Readonly<Record<string, unknown>>, now = Date.now()): string[] {
  // A workflows-plus worker's row (kind workflow-worker) only holds a slot: its thread is no delegate.
  const binding = getDelegationByChild(db, threadId);
  const looksDelegated = (binding !== null && binding.kind === "delegate") || metadataDelegationId(metadata) !== null;
  if (!looksDelegated) return [DELEGATE_TOOL, WAIT_TOOL, SEND_TOOL, STOP_TOOL, STATUS_TOOL];
  recordMarkerGrant(db, threadId, now);
  return [BRIEF_TOOL, ASK_TOOL, QUESTION_ANSWER_TOOL];
}

export const DENY_ALL_SNAPSHOT = "deny-all";

export type PolicyAnswer =
  | { status: "ok"; policy: Policy; policyHash: string; nonce: string }
  | { status: "pending"; delegationId: string }
  | { status: "denied"; reason: string; policy: Policy; nonce: null };

const denied = (reason: string, delegationId: string | null): PolicyAnswer => ({
  status: "denied",
  reason,
  policy: { delegationId: delegationId ?? "none", snapshotHash: DENY_ALL_SNAPSHOT, allowTools: [], transportTools: [] },
  nonce: null,
});

// The policy of a delegation, rebuilt from its launch snapshot.
function policyOf(db: Db, row: DelegationRow): Policy | null {
  if (row.snapshotHash === null) return null;
  const snapshot = getSnapshot(db, row.snapshotHash);
  return snapshot === null ? null : buildPolicy(snapshot, row.delegationId);
}

// Answers `sandy work delegate policy` for the calling thread. A bound child gets its policy and a fresh nonce
// (one row in delegation_acks); a thread whose metadata names an unbound reserved row is told to retry;
// anything else gets a deny-all policy and no nonce, so it can never ack. An idle child resumed natively
// (a message written into its thread) holds no slot: it is denied while its root has no free slot, and
// takes one with its ack (see recordAck).
export function issuePolicy(
  db: Db, threadId: string, metadata: Readonly<Record<string, unknown>>, now = Date.now(), slotLimit: SlotLimit = DEFAULT_SETTINGS,
): PolicyAnswer {
  const bound = getDelegationByChild(db, threadId);
  if (bound === null) {
    const named = metadataDelegationId(metadata);
    if (named !== null && isPendingBind(getDelegation(db, named))) return { status: "pending", delegationId: named };
    return denied(named === null ? "thread is not a delegation" : `delegation ${named} is not bound to this thread`, named);
  }
  if (END_STATES.includes(bound.state)) return denied(`delegation ${bound.delegationId} is ${bound.state}`, bound.delegationId);
  if (bound.state === "idle" && !rootHasSlotFor(db, bound, slotLimit)) return denied(noFreeSlot(bound, slotLimit), bound.delegationId);
  const policy = policyOf(db, bound);
  if (policy === null) return denied(`delegation ${bound.delegationId} has no launch snapshot`, bound.delegationId);
  const hash = policyHash(policy);
  const nonce = `nonce_${randomUUID()}`;
  db.prepare("INSERT INTO delegation_acks (nonce, delegation_id, child_thread_id, policy_hash, issued_at) VALUES (?, ?, ?, ?, ?)")
    .run(nonce, bound.delegationId, threadId, hash, now);
  return { status: "ok", policy, policyHash: hash, nonce };
}

type SlotLimit = Pick<DelegateSettings, "maxConcurrentChildren">;

const noFreeSlot = (row: DelegationRow, slotLimit: SlotLimit): string =>
  `delegation ${row.delegationId} is idle and its root ${row.rootThreadId} has no free slot (limit ${slotLimit.maxConcurrentChildren}); it runs again when a slot is free`;

// turn: the pi session's turn counter (1 = the session's first turn); the extension acks every turn.
export type AckRequest = { threadId: string; delegationId: string; policyHash: string; nonce: string; piSessionId: string; turn: number };

export type AckRefusalCode = "unknown_nonce" | "foreign_delegation" | "nonce_used" | "policy_mismatch" | "delegation_ended" | "ack_too_late" | "limit_reached";

export type AckResult = { ok: true; delegation: DelegationRow } | { ok: false; code: AckRefusalCode; message: string };

// Records the ack of an issued nonce, once. Valid only when the nonce was issued to this thread for this
// delegation, is unused, and the echoed hash equals the issued hash and the delegation's current policy
// hash. The first valid ack moves the delegation starting -> active. A first ack windowMs or more after
// the bind is not valid: the delegation is refused right here (as the watchdog would), so a late ack
// never unlocks the brief even when the sweep has not run yet. Later acks (every turn of every session)
// each need their own fresh nonce; the watchdog's turn rule (see advanceTurns) matches each to one turn.
// The ack of an idle child (resumed natively, outside sandy_delegate_send) takes a slot of its root again,
// idle -> active, counted like an admission; on a full root it is refused (limit_reached), so the turn has
// no ack and the watchdog stops the child. The watchdog's active -> idle frees the slot after the turn.
export function recordAck(
  db: Db, request: AckRequest, windowMs = DEFAULT_SETTINGS.briefWatchdogSeconds * 1000, now = Date.now(), slotLimit: SlotLimit = DEFAULT_SETTINGS,
): AckResult {
  return db
    .transaction((): AckResult => {
      if (!Number.isInteger(request.turn) || request.turn < 1) throw new Error("turn must be a positive integer");
      const issued = db
        .prepare("SELECT delegation_id AS delegationId, child_thread_id AS childThreadId, policy_hash AS policyHash, acked_at AS ackedAt FROM delegation_acks WHERE nonce = ?")
        .get(request.nonce) as { delegationId: string; childThreadId: string; policyHash: string; ackedAt: number | null } | undefined;
      if (issued === undefined) return { ok: false, code: "unknown_nonce", message: "nonce was not issued" };
      if (issued.delegationId !== request.delegationId || issued.childThreadId !== request.threadId) {
        return { ok: false, code: "foreign_delegation", message: "nonce was issued for another delegation or thread" };
      }
      if (issued.ackedAt !== null) return { ok: false, code: "nonce_used", message: "nonce was already acked" };
      const row = getDelegation(db, request.delegationId);
      if (row === null || row.childThreadId !== request.threadId) return { ok: false, code: "foreign_delegation", message: "delegation is not bound to this thread" };
      if (END_STATES.includes(row.state)) return { ok: false, code: "delegation_ended", message: `delegation is ${row.state}` };
      const current = policyOf(db, row);
      if (request.policyHash !== issued.policyHash || current === null || policyHash(current) !== request.policyHash) {
        return { ok: false, code: "policy_mismatch", message: "policy hash does not match the issued policy" };
      }
      if (ackOverdue(row, windowMs, now)) {
        refuseUnacked(db, row.delegationId, windowMs, now);
        return { ok: false, code: "ack_too_late", message: `no ack within the watchdog window (${windowMs} ms after the spawn); the delegation is refused` };
      }
      if (row.state === "idle") {
        if (!rootHasSlotFor(db, row, slotLimit)) return { ok: false, code: "limit_reached", message: noFreeSlot(row, slotLimit) };
        moveIdleToActive(db, row.delegationId, now);
      }
      db.prepare("UPDATE delegation_acks SET acked_at = ?, pi_session_id = ?, turn = ? WHERE nonce = ?").run(now, request.piSessionId, request.turn, request.nonce);
      if (row.state === "starting") {
        const moved = transition(db, row.delegationId, "active", now);
        if (moved.ok) return { ok: true, delegation: moved.delegation };
      }
      return { ok: true, delegation: getDelegation(db, row.delegationId)! };
    })
    .immediate();
}

export function storeBrief(db: Db, delegationId: string, task: string, title: string | null, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO delegation_briefs (delegation_id, task, title, created_at) VALUES (?, ?, ?, ?)").run(delegationId, task, title, now);
}

// The brief's tool section: the tools the gate allows, and what their absence rules out, so the child
// does not try a blocked call. It sits in the brief (a tool result), not in the cached prompt prefix.
export function briefToolsLine(tools: readonly string[]): string {
  const missing: string[] = [];
  if (!tools.includes("bash")) missing.push("you cannot run shell commands (no bash, no git)");
  if (!tools.includes("edit") && !tools.includes("write")) missing.push("you cannot change files");
  return [`You can call only: ${tools.join(", ")}. Any other tool is blocked, even when it is listed to you.`, ...missing.map((text) => `- ${text[0].toUpperCase()}${text.slice(1)}.`)].join("\n");
}

export type BriefResult =
  | { ok: true; delegationId: string; agent: string; body: string; task: string; title: string | null; tools: string[] }
  | { ok: false; code: "not_a_delegate" | "no_ack" | "no_brief" | "already_delivered"; message: string };

// The brief of the calling child (role body and task), once per delegation, after a valid ack. A resumed
// session (new pi process) already holds it in its conversation, so it is never delivered again; the
// brief row is kept.
export function deliverBrief(db: Db, threadId: string, now = Date.now()): BriefResult {
  return db
    .transaction((): BriefResult => {
      const row = getDelegationByChild(db, threadId);
      if (row === null || END_STATES.includes(row.state)) return { ok: false, code: "not_a_delegate", message: "this thread is not a running delegation" };
      const delivered = db.prepare("SELECT delivered_at AS deliveredAt FROM delegation_briefs WHERE delegation_id = ?").get(row.delegationId) as { deliveredAt: number | null } | undefined;
      if (delivered !== undefined && delivered.deliveredAt !== null) {
        return { ok: false, code: "already_delivered", message: "your role and task were delivered earlier in this conversation; they are not sent again. Continue from them and the latest message." };
      }
      const ack = db
        .prepare("SELECT nonce FROM delegation_acks WHERE delegation_id = ? AND child_thread_id = ? AND acked_at IS NOT NULL AND brief_delivered_at IS NULL ORDER BY acked_at LIMIT 1")
        .get(row.delegationId, threadId) as { nonce: string } | undefined;
      if (ack === undefined) return { ok: false, code: "no_ack", message: "no policy ack for this delegation yet; the brief is returned after the ack" };
      const brief = db.prepare("SELECT task, title FROM delegation_briefs WHERE delegation_id = ?").get(row.delegationId) as
        | { task: string; title: string | null }
        | undefined;
      const snapshot = row.snapshotHash === null ? null : getSnapshot(db, row.snapshotHash);
      if (brief === undefined || snapshot === null) return { ok: false, code: "no_brief", message: "no brief stored for this delegation" };
      db.prepare("UPDATE delegation_acks SET brief_delivered_at = ? WHERE nonce = ?").run(now, ack.nonce);
      db.prepare("UPDATE delegation_briefs SET delivered_at = ? WHERE delegation_id = ?").run(now, row.delegationId);
      const policy = buildPolicy(snapshot, row.delegationId);
      const tools = [...new Set([...policy.allowTools, ...policy.transportTools])].sort();
      return { ok: true, delegationId: row.delegationId, agent: snapshot.entry.name, body: snapshot.entry.body, task: brief.task, title: brief.title, tools };
    })
    .immediate();
}
