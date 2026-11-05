export const GIT_PLUGIN_ID = "sandy--git";

interface ChangeStats {
  insertions: number;
  deletions: number;
  lineStatsComplete: boolean;
}

export interface WorkspaceStatus {
  workingTree: ChangeStats;
  mergeBase: ChangeStats | null;
}

export type GitStatusRow =
  | { outcome: "available"; workspace: WorkspaceStatus }
  | { outcome: "not_applicable" | "unavailable" | "failed" };

export interface DiffStat {
  insertions: number;
  deletions: number;
}

export function diffStatOf(row: GitStatusRow | undefined): DiffStat | null {
  if (row?.outcome !== "available") return null;
  const parts = [row.workspace.workingTree, row.workspace.mergeBase].filter(
    (part): part is ChangeStats => part !== null && part !== undefined,
  );
  if (parts.some((part) => !part.lineStatsComplete)) return null;
  const insertions = parts.reduce((sum, part) => sum + part.insertions, 0);
  const deletions = parts.reduce((sum, part) => sum + part.deletions, 0);
  return insertions + deletions === 0 ? null : { insertions, deletions };
}
