import type { Db } from "./data.js";
import type { WorkflowRunSummary } from "./ui-contract.js";

interface SummaryRow {
  id: string;
  name: string;
  status: WorkflowRunSummary["status"];
  currentPhase: string | null;
  originThreadId: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  settled: number;
  running: number;
  failed: number;
}

const SUMMARY_SELECT = `
  SELECT runs.id, runs.name, runs.status, runs.phase AS currentPhase,
    runs.origin_thread_id AS originThreadId, runs.created_at AS createdAt,
    runs.started_at AS startedAt, runs.finished_at AS finishedAt,
    COUNT(calls.id) AS total,
    COALESCE(SUM(calls.status IN ('succeeded', 'failed', 'cancelled')), 0) AS settled,
    COALESCE(SUM(calls.status = 'running'), 0) AS running,
    COALESCE(SUM(calls.status = 'failed'), 0) AS failed
  FROM workflow_runs runs
  LEFT JOIN workflow_calls calls ON calls.run_id = runs.id`;

function summary(row: SummaryRow): WorkflowRunSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    currentPhase: row.currentPhase,
    originThreadId: row.originThreadId,
    calls: {
      total: row.total,
      settled: row.settled,
      running: row.running,
      failed: row.failed,
    },
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Newest first: the runs started from one thread, then the project's other recent runs. */
export function listRunSummaries(
  db: Db,
  args: {
    threadId: string;
    projectId: string | null;
    threadLimit: number;
    projectLimit: number;
  },
): { threadRuns: WorkflowRunSummary[]; projectRuns: WorkflowRunSummary[] } {
  const threadRuns = db
    .prepare(
      `${SUMMARY_SELECT} WHERE runs.origin_thread_id = ?
       GROUP BY runs.id ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT ?`,
    )
    .all(args.threadId, args.threadLimit) as SummaryRow[];
  const projectRuns =
    args.projectId === null
      ? []
      : (db
          .prepare(
            `${SUMMARY_SELECT} WHERE runs.project_id = ? AND runs.origin_thread_id != ?
             GROUP BY runs.id ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT ?`,
          )
          .all(args.projectId, args.threadId, args.projectLimit) as SummaryRow[]);
  return {
    threadRuns: threadRuns.map(summary),
    projectRuns: projectRuns.map(summary),
  };
}
