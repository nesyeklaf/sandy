// sandy_delegate (async): checks that the child can be launched under enforcement, admits a reserved row,
// stores the brief, spawns the hidden pi child of the caller and binds it. SANDY is reached only through
// LaunchHost, so the order of these steps is testable without a server.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getAgent, getSnapshot, THINKING_LEVELS, type AgentEntry, type ThinkingLevel } from "./catalog.ts";
import { admit, bindChild, getDelegation, markWaitSilenced, requestStop, transition, type AdmitRefusal, type DelegationRow } from "./ledger.ts";
import { METADATA_DELEGATION_ID, BRIEF_TOOL, storeBrief } from "./protocol.ts";
import type { DelegateSettings } from "./settings.ts";
import { BASE_BRANCH_NEEDS_PROJECT, targetProblem, targetWorktree, type TargetProject, type TargetWorktree } from "../../project-target.ts";

export type { TargetProject };

type Db = Database.Database;

// The provider every delegate runs on: the tool gate lives in a pi extension.
export const DELEGATE_PROVIDER = "pi";

// SANDY reasoning level for a catalog thinking level. pi's SANDY provider has no "off" or "minimal" level:
// off -> none, minimal -> low; the other names are the same on both sides.
export function sandyReasoningLevel(thinking: ThinkingLevel): string {
  if (thinking === "off") return "none";
  if (thinking === "minimal") return "low";
  return thinking;
}

export type SpawnEnvironment =
  | { type: "reuse"; environmentId: string }
  | TargetWorktree;

export type SpawnRequest = {
  projectId: string;
  parentThreadId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  environment: SpawnEnvironment;
  visibility: "hidden";
  // "off" while a wait-mode call blocks on the child (wait.ts sets it back to "auto"); "auto" for async.
  parentNotifications: "auto" | "off";
  title: string;
  prompt: string;
  pluginMetadata: { [METADATA_DELEGATION_ID]: string };
};

export interface LaunchHost {
  // The SANDY provider "pi", or null when it is not installed.
  piProvider(): Promise<{ available: boolean; permissionModes: string[] } | null>;
  thread(threadId: string): Promise<{ id: string; projectId: string; environmentId: string | null }>;
  // The top of the thread's parent chain (the thread itself when it has no parent).
  rootOf(threadId: string): Promise<string>;
  // The permission mode the thread's next turn would run with, null when SANDY resolves none.
  permissionModeOf(threadId: string): Promise<string | null>;
  environment(environmentId: string): Promise<{ hostId: string; isGitRepo: boolean; branchName: string | null }>;
  // The project with this id, else the one project with this name; null when none or several match.
  project(ref: string): Promise<TargetProject | null>;
  spawn(request: SpawnRequest): Promise<{ id: string }>;
  // Delegation ids whose spawn and bind this process has not settled yet; shared with the watchdog, which
  // does not release such a reservation (an absent thread is no proof while the spawn may still create it).
  readonly spawnsInFlight: Set<string>;
  // Test hook: milliseconds to wait between the spawn and the ledger bind (0 in normal operation).
  bindDelayMs(): Promise<number>;
  sleep(ms: number): Promise<void>;
}

export type DelegateRequest = {
  agent: string;
  task: string;
  title?: string;
  model?: string;
  thinking?: ThinkingLevel;
  clientRequestId?: string;
  mode: "async" | "wait";
  // A writer's target: a managed worktree in this project (id or name) instead of the parent's checkout.
  project?: string;
  // The target's base branch; without it the project's default branch. Needs project.
  baseBranch?: string;
};

export type LaunchRefusal =
  | AdmitRefusal
  | { code: "provider_unsupported"; message: string }
  | { code: "environment_unavailable"; message: string }
  | { code: "isolation_unavailable"; message: string }
  | { code: "target_unavailable"; message: string }
  | { code: "spawn_failed"; delegationId: string; message: string }
  | { code: "spawn_unconfirmed"; delegationId: string; message: string }
  | { code: "bind_failed"; delegationId: string; childThreadId: string; state: string | null };

// The PR's launch result: threadId is the child thread, status its ledger state.
export type Launched = {
  delegationId: string;
  threadId: string | null;
  agent: string;
  agentVersion: number | null;
  status: string;
  model: string | null;
  thinking: string | null;
  reasoningLevel: string | null;
  permissionMode: string;
  workspace: "parent" | "worktree";
  reused: boolean;
};

export type LaunchResult = { ok: true; launched: Launched } | { ok: false; refusal: LaunchRefusal };

const refuse = (refusal: LaunchRefusal): LaunchResult => ({ ok: false, refusal });

// True when SANDY answered the spawn with a 4xx status: it refused the request and created no thread.
const spawnRejected = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
};

// Identifies the launch input, so a retried clientRequestId with the same input is recognised.
export function launchInputHash(request: DelegateRequest): string {
  // The target joins the hash only when set, so hashes of launches without one stay as they were.
  const canonical = JSON.stringify({
    agent: request.agent, task: request.task, title: request.title ?? null, model: request.model ?? null, thinking: request.thinking ?? null,
    ...(request.project === undefined ? {} : { project: request.project, baseBranch: request.baseBranch ?? null }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function bootstrapPrompt(delegationId: string, agent: string): string {
  return [
    `You are a sandy-delegate child thread: delegation ${delegationId}, agent ${agent}.`,
    `Call the tool \`${BRIEF_TOOL}\` now, with no arguments, before anything else: it returns your role and your task.`,
    "Your tools are limited to your agent's allowlist; a blocked call comes back as an error. Do the task, then end your turn with your report.",
  ].join("\n");
}

const describe = (row: DelegationRow, permissionMode: string, workspace: Launched["workspace"], reused: boolean): Launched => ({
  delegationId: row.delegationId,
  threadId: row.childThreadId,
  agent: row.agent,
  agentVersion: row.agentVersion,
  status: row.state,
  model: row.model,
  thinking: row.thinking,
  reasoningLevel: THINKING_LEVELS.includes(row.thinking as ThinkingLevel) ? sandyReasoningLevel(row.thinking as ThinkingLevel) : null,
  permissionMode,
  workspace,
  reused,
});

// A writer's explicit target, resolved once before admit: the project and its worktree.
type Target = { project: TargetProject; worktree: TargetWorktree };

async function resolveTarget(host: LaunchHost, environmentId: string, request: DelegateRequest): Promise<{ ok: true; target: Target | null } | { ok: false; refusal: LaunchRefusal }> {
  if (request.project === undefined) {
    if (request.baseBranch === undefined) return { ok: true, target: null };
    return { ok: false, refusal: { code: "target_unavailable", message: BASE_BRANCH_NEEDS_PROJECT } };
  }
  const project = await host.project(request.project);
  const problem = targetProblem(request.project, project);
  if (problem !== null || project === null) return { ok: false, refusal: { code: "target_unavailable", message: problem ?? "" } };
  const parentHost = (await host.environment(environmentId)).hostId;
  return { ok: true, target: { project, worktree: targetWorktree(project, parentHost, request.baseBranch) } };
}

type Placement = { environment: SpawnEnvironment; workspace: Launched["workspace"]; projectId: string | null };

// Where a child of the entry's role runs: a reader in the parent's environment; a writer in a managed
// worktree of the target project when one is given, else on the parent's branch (refused when the parent's
// environment is no git checkout on a branch). projectId null: the parent's project.
async function spawnPlacement(
  host: LaunchHost,
  environmentId: string,
  entry: AgentEntry,
  target: Target | null,
): Promise<{ ok: true; placement: Placement } | { ok: false; refusal: LaunchRefusal }> {
  if (entry.role !== "writer") {
    if (target !== null) {
      return { ok: false, refusal: { code: "target_unavailable", message: `agent ${entry.name} reads only and runs in the parent's environment; project places writers. Name the paths to read in the task instead` } };
    }
    return { ok: true, placement: { environment: { type: "reuse", environmentId }, workspace: "parent", projectId: null } };
  }
  if (target !== null) return { ok: true, placement: { environment: target.worktree, workspace: "worktree", projectId: target.project.id } };
  const env = await host.environment(environmentId);
  if (!env.isGitRepo || env.branchName === null) {
    return {
      ok: false,
      refusal: {
        code: "isolation_unavailable",
        message: `agent ${entry.name} writes and needs a managed worktree, but the parent's environment is not a git checkout on a branch; pass project (id or name, optionally baseBranch) to place it in that project's repository`,
      },
    };
  }
  return {
    ok: true,
    placement: {
      environment: { type: "host", hostId: env.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: env.branchName } } },
      workspace: "worktree",
      projectId: null,
    },
  };
}

// Order: every check that can refuse without taking a slot runs first (provider, permission mode,
// workspace); then admit writes the reserved row and the brief is stored, both before the spawn, so the
// child's first configure and policy calls find them; then spawn and bind.
export async function delegate(
  db: Db,
  host: LaunchHost,
  callerThreadId: string,
  request: DelegateRequest,
  settings: Pick<DelegateSettings, "maxConcurrentChildren">,
): Promise<LaunchResult> {
  const pi = await host.piProvider();
  if (pi === null || !pi.available) return refuse({ code: "provider_unsupported", message: `SANDY provider "${DELEGATE_PROVIDER}" is not available; delegates run only on pi` });

  const caller = await host.thread(callerThreadId);
  const permissionMode = await host.permissionModeOf(callerThreadId);
  if (permissionMode === null || !pi.permissionModes.includes(permissionMode)) {
    return refuse({
      code: "provider_unsupported",
      message: `the parent's permission mode ${permissionMode ?? "(none)"} is not one pi supports (${pi.permissionModes.join(", ")})`,
    });
  }
  if (caller.environmentId === null) return refuse({ code: "environment_unavailable", message: "the calling thread has no environment" });

  // The current entry only pre-checks the placement, so a launch the parent cannot host is refused without
  // a slot; admit snapshots the entry again, and the child is placed by that snapshot (the catalog may
  // change during the awaits in between).
  const entry = getAgent(db, request.agent);
  if (entry === null) return refuse({ code: "unknown_agent", agent: request.agent });
  const resolved = await resolveTarget(host, caller.environmentId, request);
  if (!resolved.ok) return refuse(resolved.refusal);
  const checked = await spawnPlacement(host, caller.environmentId, entry, resolved.target);
  if (!checked.ok) return refuse(checked.refusal);

  const rootThreadId = await host.rootOf(callerThreadId);
  const admitted = admit(db, {
    rootThreadId,
    callerThreadId,
    kind: "delegate",
    agent: request.agent,
    clientRequestId: request.clientRequestId,
    inputHash: launchInputHash(request),
    model: request.model,
    thinking: request.thinking,
  }, settings);
  if (!admitted.ok) return refuse(admitted.refusal);
  const row = admitted.delegation;
  const snapshot = row.snapshotHash === null ? null : getSnapshot(db, row.snapshotHash);
  if (snapshot === null) throw new Error(`delegation ${row.delegationId} has no launch snapshot`);
  const admittedEntry = snapshot.entry;
  if (admitted.reused) {
    return { ok: true, launched: describe(row, permissionMode, admittedEntry.role === "writer" ? "worktree" : "parent", true) };
  }
  let placement = checked.placement;
  if (admittedEntry.role !== entry.role) {
    const replaced = await spawnPlacement(host, caller.environmentId, admittedEntry, resolved.target);
    if (!replaced.ok) {
      transition(db, row.delegationId, "error");
      return refuse(replaced.refusal);
    }
    placement = replaced.placement;
  }
  const { environment, workspace } = placement;
  storeBrief(db, row.delegationId, request.task, request.title ?? null);
  if (request.mode === "wait") markWaitSilenced(db, row.delegationId);
  host.spawnsInFlight.add(row.delegationId);
  try {
    let child: { id: string };
    try {
      child = await host.spawn({
        projectId: placement.projectId ?? caller.projectId,
        parentThreadId: callerThreadId,
        providerId: DELEGATE_PROVIDER,
        model: row.model!,
        reasoningLevel: sandyReasoningLevel(row.thinking as ThinkingLevel),
        permissionMode,
        environment,
        visibility: "hidden",
        parentNotifications: request.mode === "wait" ? "off" : "auto",
        title: request.title ?? `${admittedEntry.name} delegation`,
        prompt: bootstrapPrompt(row.delegationId, admittedEntry.name),
        pluginMetadata: { [METADATA_DELEGATION_ID]: row.delegationId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a 4xx answer proves SANDY created no thread. Any other failure (timeout, lost connection, 5xx)
      // leaves the outcome unknown: the reservation stays for the watchdog, which binds the thread SANDY
      // lists for it or releases it after SPAWN_SETTLE_MS; it is never spawned again.
      if (!spawnRejected(error)) return refuse({ code: "spawn_unconfirmed", delegationId: row.delegationId, message });
      transition(db, row.delegationId, "error");
      return refuse({ code: "spawn_failed", delegationId: row.delegationId, message });
    }

    const delay = await host.bindDelayMs();
    if (delay > 0) await host.sleep(delay);
    const bound = bindChild(db, row.delegationId, child.id);
    if (bound.ok) return { ok: true, launched: describe(bound.delegation, permissionMode, workspace, false) };
    // The watchdog may have reconciled the reservation first: bound to this child is a success; released
    // or bound elsewhere leaves this child without a delegation, so it is stopped.
    const current = getDelegation(db, row.delegationId);
    if (current !== null && current.childThreadId === child.id) return { ok: true, launched: describe(current, permissionMode, workspace, false) };
    requestStop(db, child.id, row.delegationId, "unbound_spawn");
    return refuse({ code: "bind_failed", delegationId: row.delegationId, childThreadId: child.id, state: bound.state });
  } finally {
    host.spawnsInFlight.delete(row.delegationId);
  }
}
