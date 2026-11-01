import { describe, expect, it } from "vitest";
import {
  buildRunListRow,
  buildRunListRows,
  formatRunDuration,
  formatStartedAgo,
} from "./run-list-view.js";
import type { WorkflowRunSummary } from "./ui-contract.js";

const NOW = 10_000_000;

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "wfr_1",
    name: "Review the release",
    status: "running",
    currentPhase: "Review",
    originThreadId: "thr_origin",
    calls: { total: 5, settled: 2, running: 2, failed: 0 },
    createdAt: NOW - 400_000,
    startedAt: NOW - 192_000,
    finishedAt: null,
    ...overrides,
  };
}

describe("workflow run list view model", () => {
  it("describes a running run with phase, progress, start and elapsed time", () => {
    expect(buildRunListRow(summary(), NOW)).toEqual({
      id: "wfr_1",
      originThreadId: "thr_origin",
      name: "Review the release",
      tone: "active",
      statusLabel: "Running",
      active: true,
      progress: "2/5 agents",
      progressFraction: 0.4,
      phase: "Review",
      started: "3m ago",
      duration: "3m 12s",
    });
  });

  it("drops the phase of a finished run and freezes its duration", () => {
    const row = buildRunListRow(
      summary({
        status: "succeeded",
        calls: { total: 5, settled: 5, running: 0, failed: 0 },
        finishedAt: NOW - 100_000,
      }),
      NOW,
    );
    expect(row).toMatchObject({
      tone: "completed",
      statusLabel: "Done",
      active: false,
      phase: null,
      duration: "1m 32s",
      progress: "5/5 agents",
    });
  });

  it("reports failed agents and maps failed and cancelled runs", () => {
    expect(
      buildRunListRow(
        summary({
          status: "failed",
          calls: { total: 4, settled: 4, running: 0, failed: 1 },
          finishedAt: NOW,
        }),
        NOW,
      ),
    ).toMatchObject({
      tone: "failed",
      statusLabel: "Failed",
      progress: "4/4 agents · 1 failed",
    });
    expect(
      buildRunListRow(summary({ status: "cancelled", finishedAt: NOW }), NOW),
    ).toMatchObject({ tone: "muted", statusLabel: "Cancelled" });
  });

  it("shows no progress or timing for a queued run without calls", () => {
    expect(
      buildRunListRow(
        summary({
          status: "queued",
          currentPhase: null,
          calls: { total: 0, settled: 0, running: 0, failed: 0 },
          startedAt: null,
        }),
        NOW,
      ),
    ).toMatchObject({
      statusLabel: "Queued",
      active: true,
      progress: null,
      progressFraction: null,
      started: null,
      duration: null,
    });
  });

  it("lists live runs first, then the rest, each newest first", () => {
    const rows = buildRunListRows(
      [
        summary({ id: "old-done", status: "succeeded", createdAt: 3 }),
        summary({ id: "new-done", status: "failed", createdAt: 9 }),
        summary({ id: "old-live", status: "running", createdAt: 1 }),
        summary({ id: "new-live", status: "queued", createdAt: 2 }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual([
      "new-live",
      "old-live",
      "new-done",
      "old-done",
    ]);
  });

  it("formats durations and start times compactly", () => {
    expect(formatRunDuration(null, null, NOW)).toBeNull();
    expect(formatRunDuration(NOW - 45_000, null, NOW)).toBe("45s");
    expect(formatRunDuration(NOW - 120_000, null, NOW)).toBe("2m");
    expect(formatRunDuration(NOW - 3_900_000, null, NOW)).toBe("1h 5m");
    expect(formatStartedAgo(null, NOW)).toBeNull();
    expect(formatStartedAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(formatStartedAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(formatStartedAgo(NOW - 72 * 3_600_000, NOW)).toBe("3d ago");
  });
});
