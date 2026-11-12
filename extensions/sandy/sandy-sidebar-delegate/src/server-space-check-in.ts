import { assert } from "./assert";
import { CHECK_IN_ENTRIES_MAX, CHECK_IN_TICK_MS } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";
import type { ActivityTracker } from "./server-space-activity";
import type { SpaceDeps } from "./server-space-deps";
import type { MemberThread } from "./server-space-membership";
import { spaceHeading } from "./server-space-reports-service";
import type { SpaceRolesService } from "./server-space-roles-service";

const SPACES_CHECKED_MAX = 1000;
const MS_PER_MINUTE = 60_000;

type CheckInCondition = "stuck" | "idle-without-report" | "failed" | "question";

interface CheckInFinding {
  threadId: string;
  title: string;
  condition: CheckInCondition;
  sinceMs: number;
  signature: string;
}

function describeFinding(finding: CheckInFinding, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - finding.sinceMs) / MS_PER_MINUTE));
  switch (finding.condition) {
    case "stuck":
      return `working, no change for ${minutes} min; it may be stuck`;
    case "idle-without-report":
      return "idle, no report since its last turn";
    case "failed":
      return "failed";
    case "question":
      return "waiting on a question";
    default: {
      const unknown: never = finding.condition;
      throw new Error(`unknown check-in condition ${String(unknown)}`);
    }
  }
}

function formatCheckIn(spaceName: string, findings: readonly CheckInFinding[], nowMs: number): string {
  assert(findings.length > 0, "a check-in lists at least one member");
  const shown = findings.slice(0, CHECK_IN_ENTRIES_MAX);
  const omittedCount = findings.length - shown.length;
  const lines = shown.map((finding) => `- ${finding.title} (${finding.threadId}): ${describeFinding(finding, nowMs)}`);
  const omitted = omittedCount > 0 ? [`(${omittedCount} more members omitted)`] : [];
  return [
    `${spaceHeading(spaceName)} Check-in: managed members that changed or look stuck. Read space_context before acting.`,
    ...lines,
    ...omitted,
  ].join("\n");
}

function createClassifier(deps: SpaceDeps, activity: ActivityTracker) {
  return function classify(
    thread: MemberThread,
    spaceId: string,
    nowMs: number,
    intervalMs: number,
  ): { condition: CheckInCondition; sinceMs: number } | null {
    const activityAt = activity.lastActivityAt(thread);
    if (thread.hasPendingInteraction) return { condition: "question", sinceMs: thread.latestAttentionAt };
    if (thread.status === "error") return { condition: "failed", sinceMs: activityAt };
    const working = thread.status === "active" || thread.status === "starting";
    if (working) {
      return nowMs - activityAt >= intervalMs ? { condition: "stuck", sinceMs: activityAt } : null;
    }
    if (thread.status !== "idle") return null;
    const turnStartedAt = activity.turnStartedAt(thread.id);
    if (turnStartedAt === null) return null;
    const report = deps.reports.latestIn(thread.id, spaceId);
    const reportedThisTurn = report !== null && report.reportedAt >= turnStartedAt;
    if (reportedThisTurn) return null;
    return { condition: "idle-without-report", sinceMs: turnStartedAt };
  };
}

function createCheckIn(deps: SpaceDeps, rolesService: SpaceRolesService, activity: ActivityTracker) {
  const lastRunAtBySpace = new Map<string, number>();
  const listedByOrchestrator = new Map<string, Map<string, string>>();
  const untaken = new Set<string>();
  const classify = createClassifier(deps, activity);

  async function findingsOf(spaceId: string, orchestratorIds: ReadonlySet<string>, nowMs: number, intervalMs: number) {
    const { threads } = await deps.membership.listMembers(spaceId);
    const findings: CheckInFinding[] = [];
    for (const thread of threads) {
      const managed = deps.roles.modeIn(thread.id, spaceId) === "managed";
      if (!managed || orchestratorIds.has(thread.id)) continue;
      const result = classify(thread, spaceId, nowMs, intervalMs);
      if (result === null) continue;
      const title = thread.title ?? thread.titleFallback ?? thread.id;
      findings.push({ threadId: thread.id, title, ...result, signature: `${result.condition}:${result.sinceMs}` });
    }
    return findings;
  }

  async function sendTo(orchestratorId: string, text: string): Promise<boolean> {
    try {
      const result = await deps.ctx.sandy.sdk.threads.send({
        threadId: orchestratorId,
        input: [{ type: "text", text, mentions: [] }],
        mode: "queue-if-active",
      });
      if (result.delivery === "queued") untaken.add(orchestratorId);
      return true;
    } catch (error) {
      deps.ctx.sandy.log.warn(`Could not send the check-in to ${orchestratorId}: ${String(error)}`);
      return false;
    }
  }

  async function checkSpace(spaceId: string, orchestratorIds: readonly string[], nowMs: number, intervalMs: number) {
    const findings = await findingsOf(spaceId, new Set(orchestratorIds), nowMs, intervalMs);
    const names = await deps.membership.sectionNames();
    const spaceName = names.get(spaceId) ?? spaceId;
    for (const orchestratorId of orchestratorIds) {
      if (untaken.has(orchestratorId)) continue;
      const listed = listedByOrchestrator.get(orchestratorId) ?? new Map<string, string>();
      const current = new Map(findings.map((finding) => [finding.threadId, finding.signature]));
      const fresh = findings.filter((finding) => listed.get(finding.threadId) !== finding.signature);
      if (fresh.length > 0 && !(await sendTo(orchestratorId, formatCheckIn(spaceName, fresh, nowMs)))) continue;
      listedByOrchestrator.set(orchestratorId, current);
    }
  }

  async function dueSpaces(nowMs: number): Promise<Map<string, string[]>> {
    const orchestrators = await rolesService.verifiedAllOrchestrators();
    const bySpace = new Map<string, string[]>();
    for (const { threadId, spaceId } of orchestrators)
      bySpace.set(spaceId, [...(bySpace.get(spaceId) ?? []), threadId]);
    assert(bySpace.size <= SPACES_CHECKED_MAX, "Spaces with orchestrators stay within the check-in bound");
    const known = new Set(orchestrators.map((entry) => entry.threadId));
    for (const threadId of [...untaken]) if (!known.has(threadId)) untaken.delete(threadId);
    for (const threadId of [...listedByOrchestrator.keys()])
      if (!known.has(threadId)) listedByOrchestrator.delete(threadId);
    const due = new Map<string, string[]>();
    for (const [spaceId, orchestratorIds] of bySpace) {
      const intervalMs = deps.roles.settingsOf(spaceId).checkInMinutes * MS_PER_MINUTE;
      const lastRunAt = lastRunAtBySpace.get(spaceId);
      if (intervalMs === 0) {
        lastRunAtBySpace.delete(spaceId);
      } else if (lastRunAt === undefined) {
        lastRunAtBySpace.set(spaceId, nowMs);
      } else if (nowMs - lastRunAt >= intervalMs) {
        lastRunAtBySpace.set(spaceId, nowMs);
        due.set(spaceId, orchestratorIds);
      }
    }
    return due;
  }

  return {
    async tick(): Promise<void> {
      const nowMs = Date.now();
      for (const [spaceId, orchestratorIds] of await dueSpaces(nowMs)) {
        const intervalMs = deps.roles.settingsOf(spaceId).checkInMinutes * MS_PER_MINUTE;
        try {
          await checkSpace(spaceId, orchestratorIds, nowMs, intervalMs);
        } catch (error) {
          deps.ctx.sandy.log.warn(`Could not run the check-in of Space ${spaceId}: ${String(error)}`);
        }
      }
    },
    taken(threadId: string): void {
      untaken.delete(threadId);
    },
  };
}

export function registerCheckIn(
  ctx: ServerContext,
  deps: SpaceDeps,
  rolesService: SpaceRolesService,
  activity: ActivityTracker,
): void {
  const checkIn = createCheckIn(deps, rolesService, activity);
  let running = false;
  ctx.sandy.events.on("thread.active", ({ thread }) => checkIn.taken(thread.id));
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    checkIn
      .tick()
      .catch((error: unknown) => {
        ctx.sandy.log.warn(`Could not run the Space check-ins: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, CHECK_IN_TICK_MS);
  ctx.sandy.onDispose(() => clearInterval(timer));
}
