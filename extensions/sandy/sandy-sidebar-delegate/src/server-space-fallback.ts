import { assert } from "./assert";
import { FALLBACK_ENTRIES_MAX, FALLBACK_INTERVAL_MS, SPACE_MEMBERS_LISTED_MAX } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";
import type { SpaceDeps } from "./server-space-deps";
import type { MemberThread } from "./server-space-membership";
import { spaceHeading } from "./server-space-reports-service";
import type { SpaceRolesService } from "./server-space-roles-service";

type FallbackOutcome = "failed" | "question";

interface PendingFallback {
  eventAtByThread: Map<string, number>;
  timer: ReturnType<typeof setTimeout>;
}

interface FallbackLine {
  threadId: string;
  title: string;
  outcome: FallbackOutcome;
  eventAt: number;
}

function currentFallbackOutcome(
  thread: Pick<MemberThread, "hasPendingInteraction" | "status">,
): FallbackOutcome | null {
  if (thread.hasPendingInteraction) return "question";
  if (thread.status === "error") return "failed";
  return null;
}

function describeOutcome(outcome: FallbackOutcome): string {
  switch (outcome) {
    case "failed":
      return "failed";
    case "question":
      return "waiting on a question";
    default: {
      const unknown: never = outcome;
      throw new Error(`unknown outcome ${String(unknown)}`);
    }
  }
}

function formatFallback(spaceName: string, lines: readonly FallbackLine[], omittedCount: number): string {
  assert(lines.length > 0 && lines.length <= FALLBACK_ENTRIES_MAX, "a fallback message lists 1 to 50 members");
  const body = lines.map((line) => `- ${line.title} (${line.threadId}): ${describeOutcome(line.outcome)}`);
  const omitted = omittedCount > 0 ? [`(${omittedCount} more members omitted)`] : [];
  return [`${spaceHeading(spaceName)} Managed members need a look:`, ...body, ...omitted].join("\n");
}

function createFailureFallback(deps: SpaceDeps, rolesService: SpaceRolesService) {
  const pending = new Map<string, PendingFallback>();

  function stillCurrent(spaceId: string, threadId: string, eventAt: number, thread: MemberThread | undefined) {
    if (thread === undefined || thread.archivedAt !== null || thread.sectionId !== spaceId) return null;
    if (deps.roles.modeIn(threadId, spaceId) !== "managed") return null;
    const outcome = currentFallbackOutcome(thread);
    if (outcome === null) return null;
    const report = deps.reports.latestIn(threadId, spaceId);
    const reportedAfterEvent = report !== null && report.reportedAt > eventAt;
    if (reportedAfterEvent) return null;
    return { threadId, title: thread.title ?? thread.titleFallback ?? threadId, outcome, eventAt };
  }

  async function recheck(spaceId: string, eventAtByThread: ReadonlyMap<string, number>): Promise<FallbackLine[]> {
    const threads = await deps.membership.threadsById([...eventAtByThread.keys()]);
    const lines: FallbackLine[] = [];
    for (const [threadId, eventAt] of eventAtByThread) {
      const line = stillCurrent(spaceId, threadId, eventAt, threads.get(threadId));
      if (line !== null) lines.push(line);
    }
    return lines.sort((left, right) => left.eventAt - right.eventAt);
  }

  async function deliver(spaceId: string, text: string): Promise<void> {
    for (const orchestratorId of await rolesService.verifiedOrchestrators(spaceId)) {
      try {
        await deps.ctx.sandy.sdk.threads.send({
          threadId: orchestratorId,
          input: [{ type: "text", text, mentions: [] }],
          mode: "queue-if-active",
        });
      } catch (error) {
        deps.ctx.sandy.log.warn(`Could not send the failure fallback to ${orchestratorId}: ${String(error)}`);
      }
    }
  }

  async function flush(spaceId: string): Promise<void> {
    const batch = pending.get(spaceId);
    if (batch === undefined) return;
    pending.delete(spaceId);
    if (!deps.roles.settingsOf(spaceId).failureFallback) return;
    try {
      const lines = await recheck(spaceId, batch.eventAtByThread);
      if (lines.length === 0) return;
      const shown = lines.slice(-FALLBACK_ENTRIES_MAX);
      const names = await deps.membership.sectionNames();
      await deliver(spaceId, formatFallback(names.get(spaceId) ?? spaceId, shown, lines.length - shown.length));
    } catch (error) {
      deps.ctx.sandy.log.warn(`Could not deliver the failure fallback of Space ${spaceId}: ${String(error)}`);
    }
  }

  function record(thread: { id: string; sectionId: string | null }): void {
    const spaceId = thread.sectionId;
    if (spaceId === null) return;
    if (!deps.roles.settingsOf(spaceId).failureFallback) return;
    if (deps.roles.modeIn(thread.id, spaceId) !== "managed") return;
    if (deps.roles.orchestratorSpaceOf(thread.id) !== null) return;
    const batch =
      pending.get(spaceId) ??
      ({
        eventAtByThread: new Map(),
        timer: setTimeout(() => void flush(spaceId), FALLBACK_INTERVAL_MS),
      } satisfies PendingFallback);
    batch.eventAtByThread.delete(thread.id);
    batch.eventAtByThread.set(thread.id, Date.now());
    if (batch.eventAtByThread.size > SPACE_MEMBERS_LISTED_MAX) {
      const oldest = batch.eventAtByThread.keys().next();
      if (oldest.done !== true) batch.eventAtByThread.delete(oldest.value);
    }
    assert(batch.eventAtByThread.size <= SPACE_MEMBERS_LISTED_MAX, "pending fallback entries stay bounded");
    pending.set(spaceId, batch);
  }

  function dispose(): void {
    for (const batch of pending.values()) clearTimeout(batch.timer);
    pending.clear();
  }

  return { record, flush, dispose };
}

export function registerFailureFallback(ctx: ServerContext, deps: SpaceDeps, rolesService: SpaceRolesService): void {
  const fallback = createFailureFallback(deps, rolesService);
  ctx.sandy.events.on("thread.failed", ({ thread }) => fallback.record(thread));
  ctx.sandy.events.on("interaction.pending", ({ thread }) => fallback.record(thread));
  ctx.sandy.onDispose(() => fallback.dispose());
}
