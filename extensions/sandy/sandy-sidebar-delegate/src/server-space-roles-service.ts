import { assert } from "./assert";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { CoordinationMode } from "./space-coordination-contract";
import type { SpaceDeps } from "./server-space-deps";

type ManagedTargetDecision = { allowed: true } | { allowed: false; reason: string };

const ORCHESTRATORS_VERIFIED_MAX = 1_000;
const BULK_SESSIONS_MAX = 200;

function createRoleVerifier(deps: SpaceDeps) {
  const { roles, membership } = deps;

  async function verifiedOrchestrators(spaceId: string): Promise<string[]> {
    const threadIds = roles.orchestratorsOf(spaceId);
    assert(threadIds.length <= ORCHESTRATORS_VERIFIED_MAX, "orchestrators of one Space exceed the verification bound");
    const spaces = await membership.spacesOf(threadIds);
    const kept: string[] = [];
    for (const threadId of threadIds) {
      if (spaces.get(threadId) === spaceId) {
        kept.push(threadId);
      } else {
        roles.clearOrchestrator(threadId);
        deps.publishOrchestrators();
      }
    }
    return kept;
  }

  async function verifiedAllOrchestrators(): Promise<Array<{ threadId: string; spaceId: string }>> {
    const threadIds = roles.allOrchestrators();
    assert(threadIds.length <= ORCHESTRATORS_VERIFIED_MAX, "orchestrators exceed the verification bound");
    const spaces = await membership.spacesOf(threadIds);
    const kept: Array<{ threadId: string; spaceId: string }> = [];
    for (const threadId of threadIds) {
      const stored = roles.orchestratorSpaceOf(threadId);
      if (stored !== null && spaces.get(threadId) === stored) {
        kept.push({ threadId, spaceId: stored });
      } else {
        roles.clearOrchestrator(threadId);
        deps.publishOrchestrators();
      }
    }
    return kept;
  }

  async function orchestratorSpaceOf(threadId: string): Promise<string | null> {
    const spaceId = roles.orchestratorSpaceOf(threadId);
    if (spaceId === null) return null;
    const currentSpaceId = await membership.spaceOf(threadId);
    if (currentSpaceId === spaceId) return spaceId;
    roles.clearOrchestrator(threadId);
    deps.publishOrchestrators();
    return null;
  }

  async function requireOrchestrator(threadId: string): Promise<string> {
    const spaceId = await orchestratorSpaceOf(threadId);
    if (spaceId === null) {
      throw new SpaceCoordinationError("not_orchestrator", "This session is not an orchestrator of a Space.");
    }
    return spaceId;
  }

  return { verifiedOrchestrators, verifiedAllOrchestrators, orchestratorSpaceOf, requireOrchestrator };
}

function createMemberReads(deps: SpaceDeps) {
  const { roles, membership } = deps;

  async function requireMember(threadId: string): Promise<string> {
    const spaceId = await membership.spaceOf(threadId);
    if (spaceId === null) {
      throw new SpaceCoordinationError("not_member", "This session is not in a Space.");
    }
    return spaceId;
  }

  async function modeOf(threadId: string): Promise<CoordinationMode> {
    const spaceId = await membership.spaceOf(threadId);
    const mode = roles.modeIn(threadId, spaceId);
    if (mode === "independent" && roles.revokeManaged(threadId) && spaceId !== null) deps.publishSpace(spaceId);
    return mode;
  }

  return { requireMember, modeOf };
}

type RoleVerifier = ReturnType<typeof createRoleVerifier>;

function createManagedTargetDecider(deps: SpaceDeps, verifier: RoleVerifier) {
  const { roles, membership } = deps;
  return async function decideManagedTarget(
    senderThreadId: string,
    targetThreadId: string,
  ): Promise<ManagedTargetDecision> {
    assert(senderThreadId.length > 0 && targetThreadId.length > 0, "sender and target ids must not be empty");
    const senderSpaceId = await verifier.orchestratorSpaceOf(senderThreadId);
    if (senderSpaceId === null) return { allowed: true };
    const targetSpaceId = await membership.spaceOf(targetThreadId);
    const targetMode = roles.modeIn(targetThreadId, targetSpaceId);
    if (targetMode !== "managed") roles.revokeManaged(targetThreadId);
    if (targetSpaceId !== senderSpaceId) {
      return {
        allowed: false,
        reason: "Orchestrators may only message sessions in their own Space. This session is outside it.",
      };
    }
    if (targetMode !== "managed") {
      return {
        allowed: false,
        reason:
          "This session is independent. Only the owner can switch it to managed before an orchestrator may message it.",
      };
    }
    return { allowed: true };
  };
}

function createOrchestratorMutations(deps: SpaceDeps) {
  const { roles, membership } = deps;

  async function setOrchestrator(
    threadId: string,
    orchestrator: boolean,
  ): Promise<{ changed: boolean; spaceId: string | null }> {
    if (!orchestrator) {
      const clearedSpaceId = roles.clearOrchestrator(threadId);
      if (clearedSpaceId !== null) {
        deps.publishSpace(clearedSpaceId);
        deps.publishOrchestrators();
      }
      return { changed: clearedSpaceId !== null, spaceId: clearedSpaceId };
    }
    const spaceId = await membership.spaceOf(threadId);
    if (spaceId === null) {
      throw new SpaceCoordinationError(
        "space_missing",
        `Session ${threadId} is not in a Space. Move it into a Space before making it an orchestrator.`,
      );
    }
    const changed = roles.assignOrchestrator(threadId, spaceId, Date.now());
    if (changed) {
      deps.publishSpace(spaceId);
      deps.publishOrchestrators();
    }
    return { changed, spaceId };
  }

  async function setOrchestrators(threadIds: readonly string[], orchestrator: boolean): Promise<{ changed: string[] }> {
    assert(threadIds.length > 0 && threadIds.length <= BULK_SESSIONS_MAX, "a bulk orchestrator change is bounded");
    if (orchestrator) {
      const spaces = await membership.spacesOf([...threadIds]);
      const unassigned = threadIds.find((threadId) => (spaces.get(threadId) ?? null) === null);
      if (unassigned !== undefined) {
        throw new SpaceCoordinationError(
          "space_missing",
          `Session ${unassigned} is not in a Space. Move it into a Space before making it an orchestrator. No session was changed.`,
        );
      }
    }
    const changed: string[] = [];
    for (const threadId of new Set(threadIds)) {
      const result = await setOrchestrator(threadId, orchestrator);
      if (result.changed) changed.push(threadId);
    }
    return { changed };
  }

  return { setOrchestrator, setOrchestrators };
}

function createModeAndWakeMutations(deps: SpaceDeps) {
  const { roles, membership } = deps;
  return {
    async setMemberMode(
      threadId: string,
      mode: CoordinationMode,
    ): Promise<{ changed: boolean; mode: CoordinationMode }> {
      const spaceId = await membership.spaceOf(threadId);
      if (spaceId === null) {
        throw new SpaceCoordinationError("space_missing", `Session ${threadId} is not in a Space.`);
      }
      const changed = roles.setMode(threadId, spaceId, mode, Date.now());
      if (changed) deps.publishSpace(spaceId);
      return { changed, mode };
    },

    setWake(spaceId: string, enabled: boolean): { wakeEnabled: boolean } {
      roles.setWake(spaceId, enabled);
      deps.publishSpace(spaceId);
      return { wakeEnabled: enabled };
    },

    forgetThread(threadId: string): void {
      const { orchestratorSpaceId } = roles.forgetThread(threadId);
      if (orchestratorSpaceId !== null) {
        deps.publishSpace(orchestratorSpaceId);
        deps.publishOrchestrators();
      }
    },
  };
}

export function createSpaceRolesService(deps: SpaceDeps) {
  const verifier = createRoleVerifier(deps);
  return {
    ...verifier,
    ...createMemberReads(deps),
    ...createOrchestratorMutations(deps),
    ...createModeAndWakeMutations(deps),
    decideManagedTarget: createManagedTargetDecider(deps, verifier),
  };
}

export type SpaceRolesService = ReturnType<typeof createSpaceRolesService>;
