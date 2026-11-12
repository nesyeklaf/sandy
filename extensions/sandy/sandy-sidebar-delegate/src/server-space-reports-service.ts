import { assert } from "./assert";
import { SpaceCoordinationError } from "./space-coordination-error";
import { reportSummarySchema, type ReportOutcome } from "./space-coordination-contract";
import type { SpaceDeps } from "./server-space-deps";
import type { SpaceRolesService } from "./server-space-roles-service";

interface ReportResult {
  spaceId: string;
  outcome: ReportOutcome;
  reportedAt: number;
  deliveredTo: string[];
}

export function spaceHeading(spaceName: string): string {
  return `[Space ${spaceName}]`;
}

function parseSummary(summary: string): string {
  const parsed = reportSummarySchema.safeParse(summary);
  if (!parsed.success) {
    throw new SpaceCoordinationError("invalid_request", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

export function createSpaceReportsService(deps: SpaceDeps, rolesService: SpaceRolesService) {
  async function requireReporter(threadId: string): Promise<string> {
    const spaceId = await rolesService.requireMember(threadId);
    if (!deps.roles.settingsOf(spaceId).selfReports) {
      throw new SpaceCoordinationError("self_reports_off", "Self-reports are off for this Space.");
    }
    if (deps.roles.modeIn(threadId, spaceId) !== "managed") {
      throw new SpaceCoordinationError(
        "not_managed",
        "Only managed members report to the orchestrators. This session is independent.",
      );
    }
    return spaceId;
  }

  async function deliver(threadId: string, spaceId: string, text: string): Promise<string[]> {
    const orchestratorIds = (await rolesService.verifiedOrchestrators(spaceId)).filter((id) => id !== threadId);
    const deliveredTo: string[] = [];
    for (const orchestratorId of orchestratorIds) {
      try {
        await deps.ctx.sandy.sdk.threads.send({
          threadId: orchestratorId,
          input: [{ type: "text", text, mentions: [] }],
          mode: "queue-if-active",
          senderThreadId: threadId,
        });
        deliveredTo.push(orchestratorId);
      } catch (error) {
        deps.ctx.sandy.log.warn(`Could not deliver the report of ${threadId} to ${orchestratorId}: ${String(error)}`);
      }
    }
    return deliveredTo;
  }

  return {
    async report(threadId: string, outcome: ReportOutcome, summaryInput: string): Promise<ReportResult> {
      assert(threadId.length > 0, "reporting thread id must not be empty");
      const summary = parseSummary(summaryInput);
      const spaceId = await requireReporter(threadId);
      const reportedAt = Date.now();
      deps.reports.record(threadId, spaceId, { outcome, summary, reportedAt });
      const [names, threads] = await Promise.all([
        deps.membership.sectionNames(),
        deps.membership.threadsById([threadId]),
      ]);
      const reporter = threads.get(threadId);
      const title = reporter?.title ?? reporter?.titleFallback ?? threadId;
      const heading = spaceHeading(names.get(spaceId) ?? spaceId);
      const text = `${heading} Report from ${title} (${threadId}): ${outcome}\n${summary}`;
      const deliveredTo = await deliver(threadId, spaceId, text);
      deps.publishSpace(spaceId);
      return { spaceId, outcome, reportedAt, deliveredTo };
    },
  };
}

export type SpaceReportsService = ReturnType<typeof createSpaceReportsService>;
