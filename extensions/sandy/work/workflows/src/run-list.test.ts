import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRun, migrations, settleCall, startCall } from "./data.js";
import { listRunSummaries } from "./run-list.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";

const selection = {
  providerId: "codex",
  model: "gpt-test",
  reasoningLevel: "medium",
  permissionMode: "full",
} as const;

describe("workflow run list query", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });

  afterEach(() => db.close());

  function newRun(projectId: string, originThreadId: string, name: string) {
    const run = createRun(db, {
      projectId,
      originThreadId,
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name,
      source: "return null",
      sourceHash: "hash",
      argsJson: "null",
      settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
      resumedFromRunId: null,
    });
    return run;
  }

  function addCall(runId: string, index: number, settleAs?: "succeeded" | "failed") {
    db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(
      runId,
    );
    const call = startCall(db, {
      runId,
      callIndex: index,
      cacheKey: `key-${runId}-${index}`,
      prompt: "work",
      options: { title: null, phase: null, outputSchema: null, selection: null },
      selection,
      replay: null,
    });
    if (settleAs !== undefined) {
      settleCall(db, {
        id: call.id,
        status: settleAs,
        result: settleAs === "succeeded" ? "ok" : null,
        error: settleAs === "failed" ? "boom" : null,
      });
    }
  }

  function setCreatedAt(runId: string, createdAt: number) {
    db.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?").run(
      createdAt,
      runId,
    );
  }

  it("lists a thread's runs newest first with per-run agent counts", () => {
    const older = newRun("proj", "thr_a", "older");
    const newer = newRun("proj", "thr_a", "newer");
    const empty = newRun("proj", "thr_a", "no calls");
    setCreatedAt(older.id, 1);
    setCreatedAt(newer.id, 2);
    setCreatedAt(empty.id, 3);
    addCall(newer.id, 0, "succeeded");
    addCall(newer.id, 1, "failed");
    addCall(newer.id, 2);
    addCall(newer.id, 3);
    db.prepare(
      "UPDATE workflow_calls SET status = 'running' WHERE run_id = ? AND call_index >= 2",
    ).run(newer.id);

    const { threadRuns } = listRunSummaries(db, {
      threadId: "thr_a",
      projectId: null,
      threadLimit: 50,
      projectLimit: 10,
    });

    expect(threadRuns.map((run) => run.name)).toEqual([
      "no calls",
      "newer",
      "older",
    ]);
    expect(threadRuns[1]).toMatchObject({
      id: newer.id,
      status: "running",
      originThreadId: "thr_a",
      calls: { total: 4, settled: 2, running: 2, failed: 1 },
    });
    expect(threadRuns[0]!.calls).toEqual({
      total: 0,
      settled: 0,
      running: 0,
      failed: 0,
    });
  });

  it("lists the project's other threads separately and honours the limits", () => {
    const mine = newRun("proj", "thr_a", "mine");
    const first = newRun("proj", "thr_b", "b1");
    const second = newRun("proj", "thr_b", "b2");
    const foreign = newRun("other-proj", "thr_c", "elsewhere");
    setCreatedAt(first.id, 1);
    setCreatedAt(second.id, 2);
    setCreatedAt(mine.id, 3);
    setCreatedAt(foreign.id, 4);

    const result = listRunSummaries(db, {
      threadId: "thr_a",
      projectId: "proj",
      threadLimit: 50,
      projectLimit: 1,
    });

    expect(result.threadRuns.map((run) => run.name)).toEqual(["mine"]);
    expect(result.projectRuns.map((run) => run.name)).toEqual(["b2"]);
    expect(
      listRunSummaries(db, {
        threadId: "thr_a",
        projectId: null,
        threadLimit: 50,
        projectLimit: 10,
      }).projectRuns,
    ).toEqual([]);
  });
});
