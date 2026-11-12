import { assert } from "./assert";
import {
  REPORT_OUTCOMES,
  REPORT_SUMMARY_CHARS_MAX,
  type MemberReport,
  type ReportOutcome,
} from "./space-coordination-contract";
import type { ServerContext } from "./server-context";

type Database = ServerContext["db"];

interface ReportRow {
  space_id: string;
  outcome: string;
  summary: string;
  reported_at: number;
}

function parseOutcome(value: string): ReportOutcome {
  const outcome = REPORT_OUTCOMES.find((candidate) => candidate === value);
  assert(outcome !== undefined, `stored report outcome ${value} is known`);
  return outcome;
}

export function createSpaceReportsStore(db: Database) {
  const selectReport = db.prepare(
    "SELECT space_id, outcome, summary, reported_at FROM space_member_reports WHERE thread_id = ?",
  );
  const upsertReport = db.prepare(
    "INSERT OR REPLACE INTO space_member_reports (thread_id, space_id, outcome, summary, reported_at) VALUES (?, ?, ?, ?, ?)",
  );
  const deleteReport = db.prepare("DELETE FROM space_member_reports WHERE thread_id = ?");

  return {
    latestIn(threadId: string, spaceId: string): MemberReport | null {
      assert(threadId.length > 0 && spaceId.length > 0, "thread and Space ids must not be empty");
      const row = selectReport.get(threadId) as ReportRow | undefined;
      if (row === undefined) return null;
      if (row.space_id !== spaceId) {
        deleteReport.run(threadId);
        return null;
      }
      return { outcome: parseOutcome(row.outcome), summary: row.summary, reportedAt: row.reported_at };
    },

    record(threadId: string, spaceId: string, report: MemberReport): void {
      assert(threadId.length > 0 && spaceId.length > 0, "thread and Space ids must not be empty");
      assert(
        report.summary.length > 0 && report.summary.length <= REPORT_SUMMARY_CHARS_MAX,
        "report summary is within its limit",
      );
      upsertReport.run(threadId, spaceId, report.outcome, report.summary, report.reportedAt);
      assert(this.latestIn(threadId, spaceId)?.reportedAt === report.reportedAt, "report must exist after recording");
    },
  };
}

export type SpaceReportsStore = ReturnType<typeof createSpaceReportsStore>;
