// The Delegates panel's server side (RPCs in server/index.ts, UI in app.tsx). The panel shows the viewed
// thread's own delegations, or, when the viewed thread is a delegate child, that child's own row. Authority comes from the ledger alone (authorizePanel): a delegation id outside
// the viewed thread's scope is refused, whatever the client sends. Accepted residual, as for
// answerQuestion: SANDY gives no owner identity for a client RPC caller, so any client (an agent or a CLI
// call included) that names a thread may act on that thread's delegations; plugin callers are refused in
// server/index.ts.
//
// Send and stop reuse sandy_delegate_send / sandy_delegate_stop with the delegation's parent as the caller, so
// re-admission, queueing and stop confirmation are the same as for the parent agent. Merge runs git in the
// parent's checkout on the parent's host through the plugin's host entry (host-git.ts).
import type Database from "better-sqlite3";
import { buildPolicy, getSnapshot } from "./catalog.ts";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { sendToDelegation, stopDelegations, type ControlHost, type ControlSettings, type SendMode, type SendOutcome, type StopOutcome } from "./control.ts";
import { withDelegationLock } from "./delegation-lock.ts";
import { getDelegation, getDelegationByChild, type DelegationRow } from "./ledger.ts";
import { bootstrapPrompt } from "./launch.ts";
import { delegationStatus, mapLimited, ownDelegations, type StatusHost } from "./status.ts";
import { policyHash } from "../shared/policy.ts";
import type { AckRecord, PanelList, PanelRow, PromptAudit, WriterDetails } from "../panel-types.ts";
import type { BranchChanges, MergeResult } from "../host-git.ts";
import { hostContract } from "../host-contract.ts";
import { statusTone } from "../panel-view.ts";

type Db = Database.Database;

export const PANEL_ROW_LIMIT = 50;

export type ChildEnvironment = { hostId: string; path: string | null; branchName: string | null; isGitRepo: boolean };

export interface PanelHost {
  // The child's SANDY visibility and environment; null when SANDY no longer has the thread.
  threadInfo(threadId: string): Promise<{ hidden: boolean; environmentId: string | null } | null>;
  setHidden(threadId: string, hidden: boolean): Promise<void>;
  environment(environmentId: string): Promise<ChildEnvironment>;
  branchChanges(hostId: string, path: string, branch: string): Promise<BranchChanges>;
  mergeBranch(hostId: string, path: string, branch: string, message: string): Promise<MergeResult>;
}

// Shaped like control.ts's refusals, so every panel outcome reports a refusal the same way.
export type PanelRefusal = { ok: false; refusal: { code: string; delegationId: string; message: string } };
const refuse = (code: string, delegationId: string, message: string): PanelRefusal => ({ ok: false, refusal: { code, delegationId, message } });

// The delegations the panel of viewedThreadId shows, newest first (one more than the limit, to flag truncation).
export function panelScope(db: Db, viewedThreadId: string, limit = PANEL_ROW_LIMIT): { rootThreadId: string; viewedIsChild: boolean; rows: DelegationRow[] } {
  const own = getDelegationByChild(db, viewedThreadId);
  if (own !== null) return { rootThreadId: own.parentThreadId, viewedIsChild: true, rows: [own] };
  return { rootThreadId: viewedThreadId, viewedIsChild: false, rows: ownDelegations(db, viewedThreadId, limit) };
}

// The named delegation when the panel of viewedThreadId may act on it: one the viewed thread launched, or
// the viewed child itself. Unknown and foreign ids get the same answer.
export function authorizePanel(db: Db, viewedThreadId: string, delegationId: string): { ok: true; row: DelegationRow } | PanelRefusal {
  const row = getDelegation(db, delegationId);
  if (row === null || (row.parentThreadId !== viewedThreadId && row.childThreadId !== viewedThreadId)) {
    return refuse("not_in_view", delegationId, `delegation ${delegationId} is not a delegation of thread ${viewedThreadId}`);
  }
  return { ok: true, row };
}

const roleOf = (db: Db, row: DelegationRow): "reader" | "writer" | null =>
  row.snapshotHash === null ? null : (getSnapshot(db, row.snapshotHash)?.entry.role ?? null);

const titleOf = (db: Db, delegationId: string): string | null =>
  (db.prepare("SELECT title FROM delegation_briefs WHERE delegation_id = ?").get(delegationId) as { title: string | null } | undefined)?.title ?? null;

// A failure acknowledgement (delegation_failure_acks, sandy/work/migrations.ts) covers one failure: the status
// and error the row showed when the owner acknowledged it.
type Failure = { status: string; error: string | null };
const failureOf = (live: { status: string; question: PanelRow["question"]; error: string | null; sandyError?: string }): Failure | null =>
  statusTone(live) === "failed" ? { status: live.status, error: live.error ?? live.sandyError ?? null } : null;

// Whether the row's current failure is acknowledged. An ack for another failure, or a row that no longer
// fails, is deleted, so the next failure shows in the composer again.
function acknowledged(db: Db, delegationId: string, failure: Failure | null): boolean {
  const ack = db.prepare("SELECT status, error FROM delegation_failure_acks WHERE delegation_id = ?").get(delegationId) as Failure | undefined;
  if (ack === undefined) return false;
  if (failure !== null && ack.status === failure.status && ack.error === failure.error) return true;
  db.prepare("DELETE FROM delegation_failure_acks WHERE delegation_id = ?").run(delegationId);
  return false;
}

export async function panelList(db: Db, status: StatusHost, host: PanelHost, viewedThreadId: string): Promise<PanelList> {
  const scope = panelScope(db, viewedThreadId);
  const truncated = scope.rows.length > PANEL_ROW_LIMIT;
  const rows = await mapLimited(scope.rows.slice(0, PANEL_ROW_LIMIT), 5, async (row): Promise<PanelRow> => {
    const live = await delegationStatus(db, status, row);
    const isAcknowledged = acknowledged(db, row.delegationId, failureOf(live));
    let hidden: boolean | null = null;
    if (row.childThreadId !== null && live.sandyError === undefined) {
      try {
        hidden = (await host.threadInfo(row.childThreadId))?.hidden ?? null;
      } catch {
        hidden = null;
      }
    }
    return {
      delegationId: row.delegationId, threadId: row.childThreadId, parentThreadId: row.parentThreadId, agent: row.agent, agentVersion: row.agentVersion,
      role: roleOf(db, row), title: titleOf(db, row.delegationId), state: row.state, status: live.status, model: live.model,
      reasoningLevel: live.reasoningLevel, tokens: live.tokens, runtime: live.runtime, stale: live.stale, error: live.error, question: live.question,
      hidden, acknowledged: isAcknowledged, createdAt: row.createdAt, ...(live.sandyError === undefined ? {} : { sandyError: live.sandyError }),
    };
  });
  return { rootThreadId: scope.rootThreadId, viewedIsChild: scope.viewedIsChild, rows, truncated };
}

// Acknowledge the current failure of one delegation, or (no delegationId) of every failed delegation the
// viewed thread's panel shows. A delegation that does not fail right now is skipped; the ack records the
// failure as the panel shows it, so a later, different failure is not covered.
export async function panelAckFailures(
  db: Db, status: StatusHost, viewedThreadId: string, delegationId?: string, now = Date.now(),
): Promise<{ ok: true; acknowledged: string[] } | PanelRefusal> {
  let rows: DelegationRow[];
  if (delegationId !== undefined) {
    const allowed = authorizePanel(db, viewedThreadId, delegationId);
    if (!allowed.ok) return allowed;
    rows = [allowed.row];
  } else {
    rows = panelScope(db, viewedThreadId).rows.slice(0, PANEL_ROW_LIMIT);
  }
  const acked: string[] = [];
  const upsert = db.prepare(
    `INSERT INTO delegation_failure_acks (delegation_id, status, error, acked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(delegation_id) DO UPDATE SET status = excluded.status, error = excluded.error, acked_at = excluded.acked_at`,
  );
  for (const row of rows) {
    const failure = failureOf(await delegationStatus(db, status, row));
    if (failure === null) continue;
    upsert.run(row.delegationId, failure.status, failure.error, now);
    acked.push(row.delegationId);
  }
  return { ok: true, acknowledged: acked };
}

// The prompt audit of one delegation: what was launched (snapshot, model, tools), what the child was told
// (bootstrap prompt, brief) and when it acked, per pi session.
export function promptAudit(db: Db, row: DelegationRow): PromptAudit {
  const snapshot = row.snapshotHash === null ? null : getSnapshot(db, row.snapshotHash);
  const policy = snapshot === null ? null : buildPolicy(snapshot, row.delegationId);
  const brief = db.prepare("SELECT task, title, delivered_at AS deliveredAt FROM delegation_briefs WHERE delegation_id = ?").get(row.delegationId) as
    | { task: string; title: string | null; deliveredAt: number | null }
    | undefined;
  const acks = db.prepare(
    `SELECT pi_session_id AS piSessionId, turn, issued_at AS issuedAt, acked_at AS ackedAt, turn_seq AS turnSeq, brief_delivered_at AS briefDeliveredAt
     FROM delegation_acks WHERE delegation_id = ? ORDER BY issued_at, rowid`,
  ).all(row.delegationId) as (AckRecord & { piSessionId: string | null })[];
  const sessions: PromptAudit["sessions"] = [];
  for (const { piSessionId, ...ack } of acks) {
    let session = sessions.find((entry) => entry.piSessionId === piSessionId);
    if (session === undefined) sessions.push((session = { piSessionId, acks: [] }));
    session.acks.push(ack);
  }
  return {
    delegationId: row.delegationId, agent: row.agent, agentVersion: row.agentVersion, snapshotHash: row.snapshotHash, role: snapshot?.entry.role ?? null,
    model: row.model, thinking: row.thinking, requestedTools: snapshot?.entry.tools ?? [], activeTools: policy?.allowTools ?? [],
    transportTools: policy?.transportTools ?? [], policyHash: policy === null ? null : policyHash(policy), bootstrapPrompt: bootstrapPrompt(row.delegationId, row.agent),
    brief: brief === undefined ? null : { title: brief.title, body: snapshot?.entry.body ?? null, task: brief.task, deliveredAt: brief.deliveredAt },
    sessions,
  };
}

export function panelSend(
  db: Db, host: ControlHost, settings: ControlSettings, viewedThreadId: string, request: { delegationId: string; message: string; mode: SendMode },
): Promise<SendOutcome> | PanelRefusal {
  const allowed = authorizePanel(db, viewedThreadId, request.delegationId);
  if (!allowed.ok) return allowed;
  return sendToDelegation(db, host, settings, { callerThreadId: allowed.row.parentThreadId, ...request });
}

// Stop one delegation, or (all) every not ended child of the viewed root; on a child's own panel, all is that child.
export async function panelStop(
  db: Db, host: ControlHost, settings: ControlSettings, viewedThreadId: string, request: { delegationId?: string; all?: boolean },
): Promise<StopOutcome | PanelRefusal> {
  if (request.delegationId !== undefined) {
    const allowed = authorizePanel(db, viewedThreadId, request.delegationId);
    if (!allowed.ok) return allowed;
    return stopDelegations(db, host, settings, { callerThreadId: allowed.row.parentThreadId, delegationId: request.delegationId });
  }
  const own = getDelegationByChild(db, viewedThreadId);
  if (own !== null) return stopDelegations(db, host, settings, { callerThreadId: own.parentThreadId, delegationId: own.delegationId });
  return stopDelegations(db, host, settings, { callerThreadId: viewedThreadId, all: true });
}

export async function panelSetHidden(db: Db, host: PanelHost, viewedThreadId: string, delegationId: string, hidden: boolean): Promise<{ ok: true; hidden: boolean } | PanelRefusal> {
  const allowed = authorizePanel(db, viewedThreadId, delegationId);
  if (!allowed.ok) return allowed;
  if (allowed.row.childThreadId === null) return refuse("not_started", delegationId, `delegation ${delegationId} has no child thread yet`);
  await host.setHidden(allowed.row.childThreadId, hidden);
  return { ok: true, hidden };
}

type Checkouts = { child: ChildEnvironment & { branchName: string }; parent: ChildEnvironment & { path: string } };

// The writer child's branch and the parent's checkout it merges into.
async function writerCheckouts(db: Db, host: PanelHost, row: DelegationRow): Promise<{ ok: true; checkouts: Checkouts } | PanelRefusal> {
  if (roleOf(db, row) !== "writer") return refuse("not_a_writer", row.delegationId, `delegation ${row.delegationId} is a reader; it has no branch of its own`);
  if (row.childThreadId === null) return refuse("not_started", row.delegationId, `delegation ${row.delegationId} has no child thread yet`);
  const [child, parent] = await Promise.all([host.threadInfo(row.childThreadId), host.threadInfo(row.parentThreadId)]);
  if (child?.environmentId == null) return refuse("no_environment", row.delegationId, `the child thread ${row.childThreadId} has no environment`);
  if (parent?.environmentId == null) return refuse("no_environment", row.delegationId, `the parent thread ${row.parentThreadId} has no environment`);
  if (child.environmentId === parent.environmentId) return refuse("shared_checkout", row.delegationId, "the child runs in the parent's checkout; there is no branch to merge");
  const [childEnv, parentEnv] = await Promise.all([host.environment(child.environmentId), host.environment(parent.environmentId)]);
  if (childEnv.branchName === null) return refuse("no_branch", row.delegationId, "the child's environment has no branch");
  if (parentEnv.path === null || !parentEnv.isGitRepo) return refuse("no_checkout", row.delegationId, "the parent's environment is not a git checkout");
  if (childEnv.hostId !== parentEnv.hostId) return refuse("other_host", row.delegationId, "the child's worktree is on another host than the parent's checkout");
  return { ok: true, checkouts: { child: { ...childEnv, branchName: childEnv.branchName }, parent: { ...parentEnv, path: parentEnv.path } } };
}

export async function panelWriterDetails(db: Db, host: PanelHost, viewedThreadId: string, delegationId: string): Promise<{ ok: true; details: WriterDetails } | PanelRefusal> {
  const allowed = authorizePanel(db, viewedThreadId, delegationId);
  if (!allowed.ok) return allowed;
  const found = await writerCheckouts(db, host, allowed.row);
  if (!found.ok) return found;
  const { child, parent } = found.checkouts;
  const changes = await host.branchChanges(parent.hostId, parent.path, child.branchName);
  return { ok: true, details: { branch: child.branchName, base: changes.base, checkoutPath: parent.path, commits: changes.commits, files: changes.files, merged: changes.merged } };
}

const RUNNING = new Set(["running", "starting", "reserved"]);

// The Merge button: git merge --no-ff of a finished writer child's branch into the parent's checkout.
// Merges into one parent's checkout run one at a time (per process).
export async function panelMerge(
  db: Db, status: StatusHost, host: PanelHost, viewedThreadId: string, delegationId: string,
): Promise<{ ok: true; result: MergeResult } | PanelRefusal> {
  const allowed = authorizePanel(db, viewedThreadId, delegationId);
  if (!allowed.ok) return allowed;
  const { row } = allowed;
  const live = await delegationStatus(db, status, row);
  if (RUNNING.has(live.status)) return refuse("still_running", delegationId, `delegation ${delegationId} is ${live.status}; merge it once it is done`);
  const found = await writerCheckouts(db, host, row);
  if (!found.ok) return found;
  const { child, parent } = found.checkouts;
  return withDelegationLock(`merge:${row.parentThreadId}`, async () => {
    const result = await host.mergeBranch(parent.hostId, parent.path, child.branchName, `Merge ${child.branchName} (delegate ${row.agent}, ${row.delegationId})`);
    return { ok: true as const, result };
  });
}

// PanelHost on SANDY: threads and environments through sandy.sdk, git through the plugin's host entry on the
// checkout's host.
export function createPanelHost(sandy: SandyPluginApi): PanelHost {
  const hostEntry = sandy.hosts.experimental_client({ contract: hostContract });
  return {
    async threadInfo(threadId) {
      try {
        const thread = await sandy.sdk.threads.get({ threadId });
        return { hidden: thread.visibility === "hidden", environmentId: thread.environmentId ?? null };
      } catch (error) {
        if ((error as { status?: unknown }).status === 404) return null;
        throw error;
      }
    },
    async setHidden(threadId, hidden) {
      await sandy.sdk.threads.update({ threadId, visibility: hidden ? "hidden" : "visible" });
    },
    async environment(environmentId) {
      const env = await sandy.sdk.environments.get({ environmentId });
      return { hostId: env.hostId, path: env.path, branchName: env.branchName, isGitRepo: env.isGitRepo };
    },
    branchChanges: (hostId, path, branch) => hostEntry.call("branchChanges", { path, branch }, { hostId }),
    mergeBranch: (hostId, path, branch, message) => hostEntry.call("mergeBranch", { path, branch, message }, { hostId }),
  };
}
